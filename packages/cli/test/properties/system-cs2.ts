import { buildWriteHooks } from "@maycombhq/scanner";
import { main } from "../../src/main.js";
import { renameHooks } from "../../src/repo-rename.js";
import type { CatalogSystem, Confirm, Faults, Guard, Outcome, RemovalReason } from "./seam.js";
import { freshFromSlots } from "./system.js";

/**
 * The system under test after CS2 (ADR 0195), as the CLI runs it: `atticus scan` writes the
 * readers slots of the repos it read in full and builds; `atticus verify <repo> --write` takes
 * the facts snapshot and builds; `atticus repo rename` writes the new slots, builds, then removes
 * the old ones; a person's change to an input is followed by `atticus catalog build`; a refusal
 * is confirmed by the same command with the count it listed (`--allow-removals <n>`,
 * `--discard-edits <n>`); `atticus catalog edits --curate`, `catalog undo [<n>] [--yes]` and
 * `catalog prune [--yes]`; `atticus upgrade [--yes]`. Every command is run with `--json` and the
 * outcome is read from its report, never from its words.
 */

async function run(
  args: string[],
): Promise<Omit<Outcome, "wrote" | "refused"> & { crashed?: true }> {
  const out: string[] = [];
  const err: string[] = [];
  try {
    const code = await main(args, { out: (l) => out.push(l), err: (l) => err.push(l) });
    return { code, out, err };
  } catch (e) {
    if (e instanceof Error && /the write stopped (after-slots|mid-records)/.test(e.message))
      return { code: 1, out, err: [...err, e.message], crashed: true };
    throw e;
  } finally {
    buildWriteHooks.crash = undefined;
    renameHooks.breakNewSlots = undefined;
  }
}

interface Removed {
  kind: string;
  id: string;
  reasons?: RemovalReason[];
}

interface Refused {
  reasons?: string[];
  allowRemovals?: number;
  removals?: Removed[];
  edits?: { path: string }[];
}

interface Report {
  written?: unknown;
  refused?: Refused;
  removed?: Removed[];
}

function reportOf(out: string[]): Report {
  try {
    return JSON.parse(out.join("\n")) as Report;
  } catch {
    return {};
  }
}

/** The build's refusal reason, in the seam's words. */
const GUARDS: Record<string, Guard> = {
  "nothing-read": "nothing-read",
  empty: "empty-catalog",
  "unexplained-removals": "unexplained-removals",
  "large-removals": "large-removals",
  "hand-edits": "hand-edits",
  "not-upgraded": "not-upgraded",
  "build-failed": "build-failed",
};

const flags = (o: Confirm) => [
  ...(o.allowRemovals !== undefined ? ["--allow-removals", String(o.allowRemovals)] : []),
  ...(o.discardEdits !== undefined ? ["--discard-edits", String(o.discardEdits)] : []),
];

/** The record id the seam names: `<Kind>/<id>`. */
const idOf = (r: Removed) => `${r.kind}/${r.id}`;

function outcome(
  r: Omit<Outcome, "wrote" | "refused"> & { crashed?: true },
  report: Report,
  wrote: boolean,
): Outcome {
  const refused = report.refused;
  // The most telling reason first: what keeps the command from writing at all.
  const order = [
    "build-failed",
    "nothing-read",
    "unexplained-removals",
    "empty",
    "not-upgraded",
    "hand-edits",
    "large-removals",
  ];
  const reason = refused?.reasons ? order.find((x) => refused.reasons!.includes(x)) : undefined;
  const guard = reason ? GUARDS[reason] : undefined;
  const removals = refused?.reasons?.includes("large-removals")
    ? {
        count: refused.allowRemovals ?? refused.removals?.length ?? 0,
        ids: (refused.removals ?? []).map(idOf).sort(),
      }
    : undefined;
  const edits = refused?.edits
    ? refused.edits.map((e) => e.path.replace(/^(.*\/)?catalog\/generated\//, "")).sort()
    : undefined;
  return {
    ...r,
    wrote: wrote && !refused && !r.crashed,
    refused: refused !== undefined,
    ...(guard ? { guard } : {}),
    ...(r.crashed ? { crashed: true } : {}),
    ...(removals ? { removals } : {}),
    ...(edits ? { edits } : {}),
    ...(report.removed
      ? {
          removed: report.removed.map((x) => ({
            id: idOf(x),
            reason: x.reasons?.[0] ?? "slot",
          })),
        }
      : {}),
  };
}

const crashing = (o: Faults) => {
  if (o.crash) buildWriteHooks.crash = o.crash;
};

export const cs2Writers: CatalogSystem = {
  name: "CS2: slots and the build",
  async scan(root, o) {
    crashing(o);
    const r = await run([
      "scan",
      "--root",
      root,
      "--no-drift",
      "--json",
      ...(o.repos ? ["--repos", o.repos.join(",")] : []),
      ...flags(o),
    ]);
    const report = reportOf(r.out);
    return outcome(r, report, report.written === true);
  },
  async verify(root, repo, o) {
    if (o.write) crashing(o);
    const r = await run([
      "verify",
      repo,
      "--root",
      root,
      "--json",
      ...(o.write ? ["--write", ...flags(o)] : []),
    ]);
    const report = reportOf(r.out) as Report & { written?: { removed?: Removed[] } };
    if (!o.write) return { ...r, wrote: false, refused: false };
    // Facts rejected: refused, but by no guard (the facts aren't the build's to judge).
    // Beta.28.1: exit 3 wrote, with the rejected facts left out.
    const rejected = !report.refused && r.code !== 0 && report.written === undefined;
    const removed = report.written?.removed;
    const out = outcome(
      r,
      { ...report, ...(removed ? { removed } : {}) },
      r.code === 0 || (r.code === 3 && report.written !== undefined),
    );
    return rejected ? { ...out, wrote: false, refused: true } : out;
  },
  async rename(root, from, to, o) {
    if (o.failBuild) renameHooks.breakNewSlots = true;
    crashing(o);
    const r = await run(["repo", "rename", from, to, "--root", root, "--json", ...flags(o)]);
    const report = reportOf(r.out) as Report & { renamed?: boolean };
    return outcome(r, report, r.code === 0 && report.renamed === true);
  },
  async build(root, o) {
    crashing(o);
    const r = await run(["catalog", "build", "--root", root, "--json", ...flags(o)]);
    const report = reportOf(r.out);
    return outcome(r, report, report.written === true);
  },
  async curateEdits(root) {
    const r = await run(["catalog", "edits", "--curate", "--root", root, "--json"]);
    const report = reportOf(r.out) as Report & { decisions?: string[]; left?: unknown[] };
    return {
      ...r,
      wrote: r.code === 0 && !(report.left ?? []).length,
      refused: (report.left ?? []).length > 0,
    };
  },
  async undo(root, o) {
    const r = await run([
      "catalog",
      "undo",
      ...(o.n !== undefined ? [String(o.n)] : []),
      "--root",
      root,
      "--json",
      ...(o.yes ? ["--yes"] : []),
    ]);
    const report = reportOf(r.out) as { refused?: Refused };
    // An undo refuses over hand edits, as a build does; one refused as not upgraded is reported
    // as such, so the oracle can fail it (an undo can itself be undone, ADR 0195 point 7).
    const reasons = report.refused?.reasons ?? [];
    const guard = reasons.includes("hand-edits")
      ? ("hand-edits" as const)
      : reasons.includes("not-upgraded")
        ? ("not-upgraded" as const)
        : undefined;
    return {
      ...r,
      wrote: o.yes && r.code === 0,
      refused: r.code !== 0,
      ...(guard ? { guard } : {}),
    };
  },
  async prune(root, o) {
    const r = await run([
      "catalog",
      "prune",
      "--root",
      root,
      "--json",
      ...(o.yes ? ["--yes"] : []),
    ]);
    const report = reportOf(r.out) as { files?: { path: string }[]; removed?: string[] };
    const listed = o.yes ? (report.removed ?? []) : (report.files ?? []).map((f) => f.path);
    return {
      ...r,
      wrote: r.code === 0,
      refused: r.code !== 0,
      pruned: listed.map((p) => p.replace(/^(.*\/)?catalog\/sources\//, "")).sort(),
    };
  },
  async upgrade(root, o) {
    const r = await run(["upgrade", "--root", root, "--json", ...(o.yes ? ["--yes"] : [])]);
    return { ...r, wrote: r.code === 0, refused: r.code !== 0 };
  },
  freshBuild(from, to) {
    return freshFromSlots(cs2Writers, from, to);
  },
};
