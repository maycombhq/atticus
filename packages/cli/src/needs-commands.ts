import { readdir } from "node:fs/promises";
import { changesDirOf, changesRelOf, loadOrgPack, orgPackDirOf } from "@maycombhq/core";
import { RuntimeConfigError, runtimeForCli, type AiRuntime } from "@maycombhq/ai";
import { readKnowledge } from "@maycombhq/knowledge";
import { findNeeds, markNeed, readNeeds, type ContextOptions, type Need } from "@maycombhq/planner";
import type { Output } from "./commands.js";
import { contextFlags, contextLines } from "./context-flags.js";
import { table } from "./table.js";

/**
 * What a change needs from the organisation (ADR 0101):
 *
 * - `atticus change needs <change>`: the assistant reads the change and the knowledge items and
 *   says which apply, to what and why; Atticus checks each (an AI step: --mode, --resume,
 *   --handoff).
 * - `atticus needs [--change id] [--all] [--json]`: the open needs, across changes.
 * - `atticus needs done <change> <item> [--for t] [--note]`, `atticus needs skip <change> <item>
 *   --note why`, `atticus needs reopen <change> <item>`: a person's own record of each.
 */

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const stamp = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const forWords = (t: string) => (t === "change" ? "the change" : t.replace(":", " "));

export interface NeedsDeps {
  runtime?: AiRuntime;
  now?: Date;
}

export async function changeNeeds(
  root: string,
  change: string,
  o: {
    attempts?: number;
    resume?: string;
    json?: boolean;
    mode?: string;
    context?: ContextOptions;
  },
  deps: NeedsDeps,
  io: Output,
): Promise<number> {
  let runtime = deps.runtime;
  if (!runtime)
    try {
      runtime = (await runtimeForCli(root, o.mode ? { mode: o.mode } : {})).runtime;
    } catch (e) {
      if (e instanceof RuntimeConfigError) {
        io.err(e.message);
        return 2;
      }
      throw e;
    }
  const k = await readKnowledge(root);
  if (!k.items.length) {
    io.err(
      "There are no knowledge items to check the change against yet. Run atticus sources sync, then atticus knowledge scan.",
    );
    return 2;
  }
  const op = await loadOrgPack(orgPackDirOf(root));
  const r = await findNeeds(root, change, {
    runtime,
    orgPack: op,
    ...(deps.now ? { now: deps.now } : {}),
    ...(o.resume ? { resume: o.resume } : {}),
    maxAttempts: o.attempts ?? 3,
    ...(o.context ? { context: o.context } : {}),
  }).catch((e: Error) => {
    io.err(e.message);
    return undefined;
  });
  if (!r) return 2;
  if (o.json) {
    io.out(JSON.stringify(r, null, 2));
    return r.status === "failed" ? 1 : 0;
  }
  if (r.status === "waiting") {
    io.out(
      `Handed the change's needs to your assistant (run ${r.runId}). When it is done: atticus handoff done ${r.runId}, then atticus change needs ${change} --resume ${r.runId}`,
    );
    return 0;
  }
  if (r.status === "failed") {
    io.err(
      `No answer passed the checks after ${plural(r.attempts.length, "attempt")}: ${r.attempts.at(-1)?.problems.join("; ") ?? "no run"}. Nothing was written.`,
    );
    return 1;
  }
  for (const l of contextLines(r.context)) io.out(l);
  const f = r.file!;
  const open = f.needs.filter((n) => n.status === "open");
  io.out(
    `${change} needs ${plural(f.needs.length, "thing")} from the organisation (${open.length} open), each checked against the change's own words.`,
  );
  for (const n of f.needs) io.out(`  ${line(n)}`);
  io.out(
    `Written to ${changesRelOf(root)}/${change}/needs.yaml and needs.md. Mark each with atticus needs done or atticus needs skip.`,
  );
  return 0;
}

function line(n: Need): string {
  const box = n.status === "open" ? "[ ]" : n.status === "done" ? "[x]" : "[-]";
  return `${box} ${n.title} (${n.kind}, for ${forWords(n.for)})${n.leadTime ? `, ${n.leadTime}` : ""}${n.handledBy ? `, ${n.handledBy}` : ""}`;
}

async function changeIds(root: string): Promise<string[]> {
  return (await readdir(changesDirOf(root), { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory() && e.name !== "archive")
    .map((e) => e.name)
    .sort();
}

/** atticus needs [--change id] [--all] [--json]: what changes need, open first. */
export async function needsList(
  root: string,
  o: { change?: string; all?: boolean; json?: boolean },
  io: Output,
): Promise<number> {
  const k = await readKnowledge(root);
  const rows: (Need & { change: string; verified?: string })[] = [];
  for (const c of o.change ? [o.change] : await changeIds(root)) {
    const f = await readNeeds(root, c);
    for (const n of f?.needs ?? [])
      if (o.all || n.status === "open") {
        const rv = k.reviews[n.item];
        rows.push({
          ...n,
          change: c,
          ...(rv && (rv.state === "verified" || rv.state === "corrected")
            ? { verified: rv.by }
            : {}),
        });
      }
  }
  if (o.json) {
    io.out(JSON.stringify(rows, null, 2));
    return 0;
  }
  if (!rows.length) {
    io.out(
      o.change
        ? `${o.change} has no ${o.all ? "" : "open "}needs. atticus change needs ${o.change} finds them.`
        : "No change has an open need.",
    );
    return 0;
  }
  for (const l of table(
    ["CHANGE", "NEED", "KIND", "FOR", "LEAD TIME", "HANDLED BY", "STATE"],
    rows.map((n) => [
      n.change,
      `${n.item}${n.verified ? " ✓" : ""}`,
      n.kind,
      forWords(n.for),
      n.leadTime ?? "",
      n.handledBy ?? "",
      n.status,
    ]),
  ))
    io.out(l);
  if (rows.some((n) => n.verified)) io.out("✓ a person verified the knowledge item it comes from");
  return 0;
}

export async function needsCli(
  root: string,
  positionals: string[],
  values: Record<string, unknown>,
  io: Output,
  who: () => string,
  deps: NeedsDeps = {},
): Promise<number | undefined> {
  const [group, command, a, b] = positionals;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
  const json = values.json === true;
  if (group === "change" && command === "needs") {
    if (!a) {
      io.err("Usage: atticus change needs <change> [--mode m] [--resume run] [--attempts 3]");
      return 2;
    }
    const attempts = Number(str(values.attempts) ?? "3");
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) {
      io.err("--attempts is a whole number from 1 to 10.");
      return 2;
    }
    const flags = contextFlags(values);
    if ("error" in flags) {
      io.err(flags.error);
      return 2;
    }
    return changeNeeds(
      root,
      a,
      {
        attempts,
        json,
        context: flags.context,
        ...(str(values.resume) ? { resume: str(values.resume)! } : {}),
        ...(str(values.mode) ? { mode: str(values.mode)! } : {}),
      },
      deps,
      io,
    );
  }
  if (group !== "needs") return undefined;
  if (command === "done" || command === "skip" || command === "reopen") {
    if (!a || !b) {
      io.err(
        `Usage: atticus needs ${command} <change> <item> [--for target]${command === "skip" ? " --note why" : " [--note text]"}`,
      );
      return 2;
    }
    const r = await markNeed(root, a, b, {
      status: command === "done" ? "done" : command === "skip" ? "not-needed" : "open",
      by: who(),
      at: stamp(deps.now ?? new Date()),
      ...(str(values.note) ? { note: str(values.note)! } : {}),
      ...(str(values.for) ? { for: str(values.for)! } : {}),
    });
    if ("error" in r) {
      io.err(r.error);
      return 2;
    }
    if (json) io.out(JSON.stringify(r.need, null, 2));
    else
      io.out(
        `${r.need.title} (${forWords(r.need.for)}) is ${r.need.status === "not-needed" ? "not needed" : r.need.status} for ${a}${r.need.by && r.need.status !== "open" ? `, by ${r.need.by}` : ""}. Commit ${changesRelOf(root)}/${a}/needs.yaml with the change.`,
      );
    return 0;
  }
  if (command && command !== "list") {
    io.err("Usage: atticus needs [--change id] [--all] | needs done|skip|reopen <change> <item>");
    return 2;
  }
  return needsList(
    root,
    {
      json,
      all: values.all === true,
      ...(str(values.change) ? { change: str(values.change)! } : {}),
    },
    io,
  );
}
