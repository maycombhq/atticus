import { createHash } from "node:crypto";
import {
  evidenceRelOf,
  factsRelOf,
  proposalsRelOf,
  questionsRelOf,
  sharedRelOf,
  type Api,
} from "@maycombhq/core";
import {
  buildAndWrite,
  listUndo,
  planUndo,
  type BuildAndWrite,
  readBuildReport,
  refusalCommands,
  undoDirOf,
  upgradeSlotsView,
  type BuildRefusal,
  type BuildReport,
  type Removal,
} from "@maycombhq/scanner";

/**
 * What the app shows of the catalog's build (ADR 0195 points 4, 6 and 7, ticket CS3), read from
 * the metarepo's files and this machine's state folder; nothing here writes. The writes are the
 * CLI's own commands (`atticus catalog build|edits|undo|prune`, `atticus upgrade --yes`), run by
 * the routes as local jobs.
 *
 * - `catalogBuildView`: each repo's source, what `atticus catalog build` would do now (built in
 *   memory and guarded, as `--check` does), and the latest build's own report (`buildAndWrite`
 *   writes it on every build: a scan, a verify --write, a rename, a build, in the app or a
 *   terminal, written or refused), each removal with why, an input's change named as such.
 * - `catalogUndoView`, `catalogPruneView`: the lists the confirm steps show, as the commands
 *   without `--yes` say them.
 * - `catalogUpgradeView`: the upgrade to source slots as a dry run, as `atticus upgrade --json`
 *   lists it, with a hash of the files listed that its confirm sends back.
 */

const BUILD = "atticus catalog build";

type RemovalInput = NonNullable<Api.BuildRemovalT["inputs"]>[number];

/**
 * The inputs other than a slot that explain a removal, from the build's words for them (`an
 * input changed (<path>)`): an answer named as such, per the owner's decision of 2026-11-11 (a
 * changed input explains a removal, and it is listed).
 */
export function removalInputs(root: string, r: Removal): RemovalInput[] | undefined {
  const out: RemovalInput[] = [];
  for (const words of r.explainedBy) {
    const m = /^an input changed \((.+)\)$/.exec(words);
    if (!m) continue;
    const path = m[1]!;
    const what: RemovalInput["what"] =
      path === questionsRelOf(root)
        ? "answers"
        : path === `${factsRelOf(root)}/*.corrections.jsonl`
          ? "pairings"
          : path === `${evidenceRelOf(root)}/traffic`
            ? "traffic"
            : path === sharedRelOf(root)
              ? "shared"
              : path === proposalsRelOf(root) || /(^|\/)proposals$/.test(path)
                ? "proposals"
                : path.startsWith("federated/")
                  ? "federated"
                  : /(^|\/)curated$/.test(path)
                    ? "curated"
                    : /(^|\/)inputs$/.test(path)
                      ? "inputs"
                      : /(^|\/)org-pack$/.test(path)
                        ? "org-pack"
                        : "other";
    out.push({ what, path });
  }
  return out.length ? out : undefined;
}

function removalView(root: string, r: Removal): Api.BuildRemovalT {
  const inputs = removalInputs(root, r);
  return {
    path: r.path,
    kind: r.kind,
    id: r.id,
    repos: r.repos,
    explainedBy: r.explainedBy,
    ...(r.reasons?.length ? { reasons: r.reasons } : {}),
    ...(inputs ? { inputs } : {}),
  };
}

/** The refusal as the page shows it, with the command that goes on in a terminal. */
export function refusalView(
  root: string,
  r: BuildRefusal,
  command = BUILD,
  run?: readonly string[],
): Api.BuildRefusalViewT {
  // The commands that go on from it, as the CLI says them (CS2's refusalCommands).
  const next = run?.[0] ?? refusalCommands(r, command)[0] ?? command;
  return {
    reasons: r.reasons,
    message: r.message,
    ...(r.removals ? { removals: r.removals.map((x) => removalView(root, x)) } : {}),
    ...(r.unexplained ? { unexplained: r.unexplained.map((x) => removalView(root, x)) } : {}),
    ...(r.allowRemovals !== undefined ? { allowRemovals: r.allowRemovals } : {}),
    ...(r.edits ? { edits: r.edits } : {}),
    ...(r.discardEdits !== undefined ? { discardEdits: r.discardEdits } : {}),
    ...(r.unread ? { unread: r.unread } : {}),
    command: next,
  };
}

/** A build's report as the page shows it. */
export function reportView(root: string, r: BuildReport): Api.BuildReportViewT {
  return {
    command: r.command,
    at: r.at,
    generated: r.generated,
    outcome: r.outcome,
    ...(r.refused ? { refused: refusalView(root, r.refused, r.command, r.run) } : {}),
    ...(r.stopped !== undefined ? { stopped: r.stopped } : {}),
    run: r.run,
    counts: r.counts,
    added: r.added,
    changed: r.changed,
    removed: r.removed.map((x) => removalView(root, x)),
    slots: r.slots,
    ...(r.undo !== undefined ? { undo: r.undo } : {}),
    ...(r.discarded?.length ? { discarded: r.discarded } : {}),
  };
}

/** The latest build's own report on this machine, whatever command built (none: undefined). */
export async function lastBuildOf(root: string): Promise<Api.BuildReportViewT | undefined> {
  const r = await readBuildReport(root);
  return r ? reportView(root, r) : undefined;
}

/** GET /api/build: built in memory and guarded, as `atticus catalog build --check`. */
export async function catalogBuildView(root: string): Promise<Api.CatalogBuildViewT> {
  const r = await buildAndWrite(root, { command: BUILD, check: true });
  const last = await lastBuildOf(root);
  return {
    sources: r.build.sources.map((s) => ({
      repo: s.repo,
      source: s.source,
      ...(s.commit ? { commit: s.commit } : {}),
      ...(s.slot ? { slot: s.slot } : {}),
      ...(s.problem ? { problem: s.problem } : {}),
    })),
    pending: {
      upToDate: r.upToDate === true,
      removals: r.guard.removals.map((x) => removalView(root, x)),
      ...(r.guard.refused ? { refused: refusalView(root, r.guard.refused) } : {}),
      plan: buildPlanOf(r.guard),
    },
    ...(last ? { last } : {}),
    ...(r.guard.refused?.reasons.includes("not-upgraded") ? { upgrade: true as const } : {}),
    orphaned: r.build.orphaned,
    problems: r.build.problems.map((p) => ({
      file: p.source,
      message: `${p.repo ? `${p.repo}: ` : ""}${p.message}`,
    })),
  };
}

/** A list's hash, for a confirm to send back (ADR 0195, the review: a confirm is of the list shown). */
export function planHash(lines: readonly string[]): string {
  return createHash("sha256")
    .update([...lines].sort().join("\n"), "utf8")
    .digest("hex");
}

/**
 * The plan of a build as GET /api/build lists it (`pending.plan`): of what it removes or would,
 * and the hand edits it lists. `atticus catalog build` and `catalog edits --curate`, run for the
 * app's confirm, work it out again under the lock and write nothing when it isn't this.
 */
export function buildPlanOf(g: BuildAndWrite["guard"]): string {
  return pendingPlan(g.refused?.removals ?? g.removals, g.refused?.edits);
}

/** The hash of what a refused build lists: each removal (path, reasons, words) and hand edit. */
export function pendingPlan(
  removals: readonly Removal[],
  edits: readonly { path: string; how: string }[] = [],
): string {
  return planHash([
    ...removals.map(
      (x) => `removal\u0000${x.path}\u0000${x.reasons.join(",")}\u0000${x.explainedBy.join("; ")}`,
    ),
    ...edits.map((e) => `edit\u0000${e.path}\u0000${e.how}`),
  ]);
}

/**
 * The hash a confirm of the upgrade sends back: of every file listed, by path and content hash,
 * and of each change the first build makes (by path and how), when it makes any.
 */
export function upgradePlanHash(
  writes: readonly { path: string; sha256: string }[],
  changes: readonly { path: string; how: string }[] = [],
): string {
  const lines = writes.map((w) => `${w.path}\u0000${w.sha256}`);
  if (changes.length) lines.push("changes", ...changes.map((c) => `${c.path}\u0000${c.how}`));
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}

/**
 * GET /api/build/upgrade: the upgrade to source slots as a dry run (`atticus upgrade --json`
 * without `--yes`, under `slots`), with the hash of the files it lists.
 */
export async function catalogUpgradeView(root: string): Promise<Api.CatalogUpgradeViewT> {
  const v = await upgradeSlotsView(root);
  // The other steps run before this one and may change an input the slots record (atticus
  // upgrade plans this step again after them), so they are run first (Run the upgrade, POST /api/upgrade).
  const { upgradeCheck } = await import("./upgrade.js");
  const c = await upgradeCheck(root);
  return {
    ...v,
    plan: upgradePlanHash(v.writes, v.changes),
    others: c.pending.map((p) => ({ id: p.id, summary: p.summary })),
  };
}

/**
 * GET /api/build/undo: the builds kept here, newest first and numbered as `atticus catalog undo`
 * numbers them (1 the latest), and what taking back the `n` latest (1 when left out) restores.
 */
export async function catalogUndoView(root: string, n?: number): Promise<Api.CatalogUndoViewT> {
  const undoDir = await undoDirOf(root);
  const list = await listUndo(undoDir);
  const copies = list.map((c, i) => ({
    n: i + 1,
    command: c.command,
    at: c.at,
    commit: c.commit,
    files: c.files.length,
  }));
  const plan = await planUndo(undoDir, n);
  if ("problem" in plan) return { copies, problem: plan.problem };
  return {
    copies,
    plan: {
      n: n ?? 1,
      takesBack: plan.copies.map((c) => ({
        n: list.findIndex((x) => x.n === c.n) + 1,
        command: c.command,
      })),
      files: plan.files.map((f) => ({ path: f.path, to: f.to })),
      hash: undoPlanHash(plan),
    },
  };
}

/** The hash of an undo's plan (GET /api/build/undo's `plan.hash`): the builds and the files. */
export function undoPlanHash(
  plan: Exclude<Awaited<ReturnType<typeof planUndo>>, { problem: string }>,
): string {
  return planHash([
    ...plan.copies.map((c) => `copy\u0000${c.n}\u0000${c.command}\u0000${c.at}`),
    ...plan.files.map((f) => `file\u0000${f.path}\u0000${f.to}\u0000${f.from}`),
  ]);
}

/** The hash of what prune removes (GET /api/build/prune's `plan`). */
export function prunePlanHash(files: readonly { path: string; why: string }[]): string {
  return planHash(files.map((f) => `${f.path}\u0000${f.why}`));
}

/**
 * GET /api/build/prune: exactly what `atticus catalog prune` lists (its own `--json`, without
 * `--yes`), so the confirm step shows the list the command removes.
 */
export async function catalogPruneView(root: string): Promise<Api.CatalogPruneViewT> {
  const { catalogPrune } = await import("./catalog-build-commands.js");
  const out: string[] = [];
  const err: string[] = [];
  await catalogPrune(root, { json: true }, { out: (l) => out.push(l), err: (l) => err.push(l) });
  try {
    const j = JSON.parse(out.join("\n")) as { files?: { path: string; why: string }[] };
    const files = j.files ?? [];
    return { files, plan: prunePlanHash(files) };
  } catch {
    throw new Error(err.join("\n") || "atticus catalog prune didn't say what it would remove.");
  }
}
