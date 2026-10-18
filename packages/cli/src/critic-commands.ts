import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { AiRuntime } from "@maycombhq/ai";
import { changeStore } from "@maycombhq/changes";
import { Lens } from "@maycombhq/core";
import {
  CriticError,
  act,
  gateStatus,
  overrideStats,
  reviewedGates,
  runCritic,
  type GateStatus,
} from "@maycombhq/naysayer";
import type { Output } from "./commands.js";
import { table } from "./index-commands.js";

/**
 * atticus critic …, atticus findings, atticus finding <id> <action>, atticus critic stats.
 * The critic writes findings into the change folder; it never writes to a shared system.
 */

/** Things tests (and the local API) inject. */
export interface CriticDeps {
  /** The AI runtime for layer 2; without it only the deterministic layer runs. */
  runtime?: AiRuntime;
  /** ISO timestamp recorded on findings and resolutions. */
  now?: string;
  /** The model that wrote the artifacts, so the critic can pick another family. */
  authorModel?: string;
}

/** Map a critic error to its exit code: 2 for usage, 1 for everything else. */
function fail(io: Output, e: unknown): number {
  if (e instanceof CriticError) {
    io.err(e.message);
    return e.code === "invalid" || e.code === "no-gate" ? 2 : 1;
  }
  if (e instanceof Error && (e.name === "ChangeError" || e.name === "ChangeFileError")) {
    io.err(e.message);
    return 1;
  }
  throw e;
}

const where = (artifact: string, line?: number) => (line ? `${artifact}:${line}` : artifact);

function statusLine(s: GateStatus): string {
  const counts = `${s.open.blocking} blocking, ${s.open.gaps} open gap${s.open.gaps === 1 ? "" : "s"}`;
  if (s.mayProceed) return `The ${s.gate} gate may proceed: nothing blocking is open.`;
  if (s.humanDecides)
    return `The ${s.gate} gate is closed (${counts}) and its ${s.maxRounds} critic rounds are used: a person decides now.`;
  return `The ${s.gate} gate is closed: ${counts}. Act on each with atticus finding <id> <action> --by <you>.`;
}

/** atticus critic <change> [--gate g] [--lens l] [--json] */
export async function critic(
  root: string,
  changeId: string | undefined,
  o: { gate?: string; lens?: string; json?: boolean },
  io: Output,
  deps: CriticDeps = {},
): Promise<number> {
  if (!changeId) {
    io.err("Usage: atticus critic <change> [--gate <gate>] [--lens <lens>] [--json]");
    return 2;
  }
  if (o.lens && !Lens.safeParse(o.lens).success) {
    io.err(`Unknown lens ${o.lens}. Use one of: ${Lens.options.join(", ")}.`);
    return 2;
  }
  let r;
  try {
    r = await runCritic(root, changeId, {
      ...(o.gate ? { gate: o.gate } : {}),
      ...(o.lens ? { lenses: [Lens.parse(o.lens)] } : {}),
      ...(deps.runtime ? { runtime: deps.runtime } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.authorModel ? { authorModel: deps.authorModel } : {}),
    });
  } catch (e) {
    return fail(io, e);
  }
  if (o.json) {
    io.out(
      JSON.stringify(
        {
          change: r.change,
          gate: r.gate,
          round: r.round,
          mayProceed: r.status.mayProceed,
          humanDecides: r.status.humanDecides,
          open: r.status.open,
          findings: r.findings.map((f) => ({
            id: f.finding.id,
            layer: f.layer,
            kind: f.finding.kind,
            severity: f.finding.severity,
            rule: f.finding.rule,
            lens: f.finding.lens,
            artifact: f.finding.artifact,
            ...(f.finding.locator.line ? { line: f.finding.locator.line } : {}),
            summary: f.finding.summary,
            state: f.finding.state,
            path: f.path,
            ...(f.finding.question ? { question: f.finding.question } : {}),
          })),
          lenses: r.lenses.map((l) => ({
            lens: l.lens,
            state: l.state,
            ...(l.reason ? { reason: l.reason } : {}),
          })),
          skipped: r.rules.skipped,
          refused: r.refused,
          problems: r.problems,
          discarded: r.discarded,
          model: r.model,
        },
        null,
        2,
      ),
    );
    return r.status.mayProceed ? 0 : 1;
  }
  for (const p of r.problems) io.err(p);
  for (const x of r.refused)
    io.err(`Refused ${x.file}${x.rule ? ` (rule ${x.rule})` : ""}: ${x.reason}`);
  const s = r.status;
  io.out(
    `Critic round ${r.round} of ${s.maxRounds} at the ${r.gate} gate for ${r.change}: ${s.total.blocking} blocking, ${s.total.gaps} gaps, ${s.total.risks} risks, ${s.total.ideas} ideas.`,
  );
  if (r.findings.length) {
    for (const line of table(
      ["SEVERITY", "LAYER", "ID", "WHERE", "SUMMARY"],
      r.findings.map((f) => [
        f.finding.severity,
        f.layer === "ai" ? "AI" : "checks",
        f.finding.id,
        where(f.finding.artifact, f.finding.locator.line),
        f.carried
          ? `${f.finding.summary} (${f.finding.state} in the last round)`
          : f.finding.summary,
      ]),
    ))
      io.out(line);
  }
  for (const l of r.lenses.filter((x) => x.state !== "ran"))
    io.out(`${l.lens} lens ${l.state}: ${l.reason ?? ""}`.trimEnd());
  if (r.discarded.length)
    io.out(
      `Discarded ${r.discarded.length} AI finding${r.discarded.length > 1 ? "s" : ""} without valid evidence.`,
    );
  io.out(statusLine(s));
  return s.mayProceed ? 0 : 1;
}

/** atticus findings <change> [--json]: the newest round at each gate. */
export async function findings(
  root: string,
  changeId: string | undefined,
  o: { json?: boolean },
  io: Output,
): Promise<number> {
  if (!changeId) {
    io.err("Usage: atticus findings <change> [--json]");
    return 2;
  }
  try {
    await changeStore(root).read(changeId);
  } catch (e) {
    io.err((e as Error).message);
    return 1;
  }
  const statuses: GateStatus[] = [];
  try {
    for (const g of await reviewedGates(root, changeId))
      statuses.push(await gateStatus(root, changeId, g));
  } catch (e) {
    return fail(io, e);
  }
  if (o.json) {
    io.out(
      JSON.stringify(
        statuses.map((s) => ({
          gate: s.gate,
          round: s.round,
          mayProceed: s.mayProceed,
          humanDecides: s.humanDecides,
          open: s.open,
          findings: s.findings.map((f) => ({ ...f.finding, path: f.path })),
        })),
        null,
        2,
      ),
    );
    return 0;
  }
  if (statuses.length === 0) {
    io.out(`No critic findings for ${changeId} yet. Run atticus critic ${changeId}.`);
    return 0;
  }
  for (const s of statuses) {
    io.out(`${s.gate} gate, round ${s.round ?? 0}:`);
    for (const line of table(
      ["SEVERITY", "STATE", "ID", "WHERE", "SUMMARY"],
      s.findings.map((f) => [
        f.finding.severity,
        f.finding.state,
        f.finding.id,
        where(f.finding.artifact, f.finding.locator.line),
        f.finding.summary,
      ]),
    ))
      io.out(`  ${line}`);
    io.out(statusLine(s));
  }
  return 0;
}

/** atticus finding <change> <id> <action> --by <you> [--reason r] [--asked-of x] [--edit patch-file] */
export async function findingAction(
  root: string,
  changeId: string | undefined,
  findingId: string | undefined,
  action: string | undefined,
  o: { by?: string; reason?: string; askedOf?: string; edit?: string },
  io: Output,
  deps: CriticDeps = {},
): Promise<number> {
  if (!changeId || !findingId || !action || !o.by) {
    io.err(
      "Usage: atticus finding <change> <finding> <apply|edit-and-apply|not-relevant|waive|ask> --by <you> [--reason <why>] [--asked-of <who>] [--edit <patch file>]",
    );
    return 2;
  }
  let edit: string | undefined;
  if (o.edit) {
    try {
      edit = await readFile(isAbsolute(o.edit) ? o.edit : join(root, o.edit), "utf8");
    } catch {
      io.err(`Can't read the patch file ${o.edit}.`);
      return 2;
    }
  }
  try {
    const r = await act(root, changeId, findingId, action, {
      by: o.by,
      ...(o.reason ? { reason: o.reason } : {}),
      ...(o.askedOf ? { askedOf: o.askedOf } : {}),
      ...(edit ? { edit } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
    io.out(r.message);
    return 0;
  } catch (e) {
    return fail(io, e);
  }
}

/** atticus critic stats [--json]: override rates per rule and suggested checklist changes. */
export async function criticStats(
  root: string,
  o: { json?: boolean; threshold?: number },
  io: Output,
): Promise<number> {
  const s = await overrideStats(root, o.threshold ? { threshold: o.threshold } : {});
  if (o.json) {
    io.out(JSON.stringify(s, null, 2));
    return 0;
  }
  if (s.rules.length === 0) {
    io.out("No critic findings yet.");
    return 0;
  }
  io.out(`Override rates across ${s.changes} change${s.changes === 1 ? "" : "s"}:`);
  for (const line of table(
    ["RULE", "FINDINGS", "DISMISSED", "WAIVED", "OVERRIDDEN"],
    s.rules.map((r) => [
      r.rule,
      String(r.total),
      String(r.dismissed),
      String(r.waived),
      `${Math.round(r.overrideRate * 100)}%`,
    ]),
  ))
    io.out(line);
  for (const g of s.suggestions) {
    io.out("");
    io.out(g.message);
    if (g.patch) for (const l of g.patch.trimEnd().split("\n")) io.out(`  ${l}`);
  }
  return 0;
}
