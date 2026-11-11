import { cp, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { main } from "../../src/main.js";
import { fault } from "./fault.js";
import type { CatalogSystem, Outcome } from "./system.js";

/**
 * The system under test after CS2 (ADR 0195): the slot writers and the one build, as the CLI
 * runs them. `atticus scan` writes the readers slots of the repos it read in full and builds;
 * `atticus verify <repo> --write` writes the facts snapshot and builds; `atticus repo rename`
 * writes the new slots, builds, then removes the old ones; a person's change to an input
 * (curated, answers, manifest) is followed by `atticus catalog build`; a refusal is confirmed by
 * running the refused command again with the count it listed (`--allow-removals <n>`,
 * `--discard-edits <n>`); `atticus catalog undo --yes` takes back the latest build; `atticus
 * upgrade --yes` adopts a catalog from before the slots.
 */

async function run(args: string[]): Promise<Omit<Outcome, "wrote" | "refused">> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(args, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err };
}

interface Report {
  written?: boolean;
  refused?: { reasons?: string[]; allowRemovals?: number; discardEdits?: number };
}

function reportOf(out: string[]): Report {
  try {
    return JSON.parse(out.join("\n")) as Report;
  } catch {
    return {};
  }
}

/** The last command a guard refused, per metarepo, and the count it listed: what a person confirms. */
const pending = new Map<string, { args: string[]; allow: number; failOn?: string }>();

function outcomeOf(
  root: string,
  r: Omit<Outcome, "wrote" | "refused">,
  args: string[],
  report: Report,
  wrote: boolean,
  failOn?: string,
): Outcome {
  const refused = report.refused !== undefined;
  if (refused && report.refused?.allowRemovals !== undefined)
    pending.set(root, {
      args,
      allow: report.refused.allowRemovals,
      ...(failOn ? { failOn } : {}),
    });
  else if (wrote) pending.delete(root);
  return { ...r, wrote, refused, ...(refused ? { guard: true } : {}) };
}

export const cs2Writers: CatalogSystem = {
  name: "CS2: slots and the build",
  async scan(root, o) {
    fault.on = o.failOn;
    try {
      const args = [
        "scan",
        "--root",
        root,
        "--no-drift",
        "--json",
        ...(o.repos ? ["--repos", o.repos.join(",")] : []),
      ];
      const r = await run(args);
      const report = reportOf(r.out);
      return outcomeOf(root, r, args, report, report.written === true, o.failOn);
    } finally {
      fault.on = undefined;
    }
  },
  async verify(root, repo, o) {
    const args = ["verify", repo, "--root", root, "--json", ...(o.write ? ["--write"] : [])];
    const r = await run(args);
    const report = reportOf(r.out) as Report & { written?: unknown };
    if (!o.write) return { ...r, wrote: false, refused: false };
    if (report.refused) return outcomeOf(root, r, args, report, false);
    const wrote = r.code === 0 && report.written !== undefined;
    return outcomeOf(root, r, args, {}, wrote);
  },
  async rename(root, from, to) {
    const args = ["repo", "rename", from, to, "--root", root];
    const r = await run(args);
    const refused = r.err.some((l) => l.startsWith("Nothing was renamed"));
    return {
      ...r,
      wrote: r.code === 0,
      refused: r.code !== 0,
      ...(refused ? { guard: true } : {}),
    };
  },
  async build(root) {
    const args = ["catalog", "build", "--root", root, "--json"];
    const r = await run(args);
    const report = reportOf(r.out);
    return outcomeOf(root, r, args, report, report.written === true);
  },
  async discardEdits(root, count) {
    const args = ["catalog", "build", "--root", root, "--json", "--discard-edits", String(count)];
    const r = await run(args);
    const report = reportOf(r.out);
    return outcomeOf(root, r, args, report, report.written === true);
  },
  async confirmRemovals(root) {
    const p = pending.get(root);
    if (!p) return { wrote: false, refused: false, code: 0, out: [], err: [] };
    fault.on = p.failOn;
    try {
      const args = [...p.args, "--allow-removals", String(p.allow)];
      const r = await run(args);
      const report = reportOf(r.out) as Report & { written?: unknown };
      const wrote =
        args[0] === "verify"
          ? r.code === 0 && report.written !== undefined
          : report.written === true;
      return outcomeOf(root, r, p.args, report, wrote, p.failOn);
    } finally {
      fault.on = undefined;
    }
  },
  async undo(root) {
    const r = await run(["catalog", "undo", "--root", root, "--yes"]);
    return { ...r, wrote: r.code === 0, refused: r.code !== 0 };
  },
  async upgrade(root, o) {
    const r = await run(["upgrade", "--root", root, ...(o.yes ? ["--yes"] : [])]);
    return { ...r, wrote: o.yes && r.code === 0, refused: r.code !== 0 };
  },
  /**
   * The master oracle's fresh metarepo: only the final slots and inputs are copied (the org
   * pack, the curated decisions, the answers, the pairings, and catalog/sources without
   * build.json), no clone and no catalog, then one `atticus catalog build`.
   */
  async freshBuild(from, to) {
    await mkdir(to, { recursive: true });
    await cp(join(from, "org-pack"), join(to, "org-pack"), { recursive: true });
    for (const d of [
      "catalog/curated",
      "questions",
      "catalog/sources/readers",
      "catalog/sources/facts",
      "catalog/sources/legacy",
    ])
      if (existsSync(join(from, d))) await cp(join(from, d), join(to, d), { recursive: true });
    for (const n of await readdir(join(from, "facts")).catch(() => [] as string[]))
      if (n.endsWith(".corrections.jsonl")) {
        await mkdir(join(to, "facts"), { recursive: true });
        await cp(join(from, "facts", n), join(to, "facts", n));
      }
    await run(["catalog", "build", "--root", to, "--json"]);
  },
};
