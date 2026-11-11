import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { cmpText, type Api } from "@maycombhq/core";
import {
  buildAndWrite,
  buildManifestPath,
  listUndo,
  parseBuildManifest,
  planUndo,
  undoDirOf,
  type BuildAndWrite,
  type BuildManifestT,
  type Removal,
} from "@maycombhq/scanner";

/**
 * What the app shows of the catalog's build (ADR 0195 points 4 and 7, ticket CS3), read from the
 * metarepo's files and this machine's undo copies; nothing here writes. The writes are the CLI's
 * own commands (`atticus catalog build|edits|undo|prune`), run by the routes as local jobs.
 *
 * - `catalogBuildView`: each repo's source, what `atticus catalog build` would do now (built in
 *   memory and guarded, as `--check` does), and what the last build here changed, from its undo
 *   copy: the record files it added, changed and removed, each removal with the sources in its
 *   build.json entry that changed since (what explained it).
 * - `catalogUndoView`, `catalogPruneView`: the lists the confirm steps show, as the commands
 *   without `--yes` say them.
 *
 * TODO(CS2): the last build's report is derived here from the newest undo copy (it names the
 * command, and holds the build.json it replaced). A build report written by `buildAndWrite`
 * itself (removals with their reasons as the guard said them, refusals of commands run in a
 * terminal) would let the app show those too; until then a refusal is shown as the build would
 * refuse now, and a scan's own refusal in its job's result.
 */

const posix = (p: string) => p.split(sep).join("/");

const BUILD = "atticus catalog build";

function removalView(r: Removal): Api.BuildRemovalT {
  return { path: r.path, kind: r.kind, id: r.id, repos: r.repos, explainedBy: r.explainedBy };
}

/** The refusal as the page shows it, with the command that goes on in a terminal. */
export function refusalView(
  r: NonNullable<BuildAndWrite["guard"]["refused"]>,
  command = BUILD,
): Api.BuildRefusalViewT {
  const next = r.reasons.includes("not-upgraded")
    ? "atticus upgrade"
    : r.reasons.includes("hand-edits")
      ? "atticus catalog edits --curate"
      : r.reasons.includes("large-removals")
        ? `${command} --allow-removals ${r.allowRemovals ?? 0}`
        : command;
  return {
    reasons: r.reasons,
    message: r.message,
    ...(r.removals ? { removals: r.removals.map(removalView) } : {}),
    ...(r.unexplained ? { unexplained: r.unexplained.map(removalView) } : {}),
    ...(r.allowRemovals !== undefined ? { allowRemovals: r.allowRemovals } : {}),
    ...(r.edits ? { edits: r.edits } : {}),
    ...(r.discardEdits !== undefined ? { discardEdits: r.discardEdits } : {}),
    command: next,
  };
}

/** A record file's kind folder and id, from its path under catalog/generated. */
function kindAndId(path: string): { kind: string; id: string } {
  const parts = path.split("/");
  const file = parts.pop() ?? "";
  return { kind: parts.pop() ?? "", id: file.replace(/\.ya?ml$/, "") };
}

/** What the last build here changed, from its undo copy (undefined when no build kept one). */
export async function lastBuildOf(root: string): Promise<Api.CatalogBuildViewT["last"]> {
  const undoDir = await undoDirOf(root);
  const latest = (await listUndo(undoDir))[0];
  if (!latest) return undefined;
  const manifestRel = posix(relative(root, buildManifestPath(root)));
  const read = async (p: string) =>
    readFile(p, "utf8").then(
      (t) => t.replace(/\r\n?/g, "\n"),
      () => undefined,
    );
  const parse = (t: string | undefined): BuildManifestT | undefined => {
    if (t === undefined) return undefined;
    const p = parseBuildManifest(t);
    return p.ok ? p.slot : undefined;
  };
  const before = parse(
    await read(join(undoDir, String(latest.n), "files", ...manifestRel.split("/"))),
  );
  const after = parse(await read(join(undoDir, String(latest.n), "next-build.json")));
  const was = new Map((before?.files ?? []).map((f) => [f.path, f]));
  const now = new Map((after?.files ?? []).map((f) => [f.path, f]));
  const nowSources = new Set(
    (after?.files ?? []).flatMap((f) => f.sources.map((s) => `${s.path}\u0000${s.sha256}`)),
  );
  const touched = new Map(latest.files.map((f) => [f.path, f.before]));
  const added: string[] = [];
  const changed: string[] = [];
  const removed: Api.BuildRemovalT[] = [];
  const slots: string[] = [];
  for (const f of latest.files) {
    if (f.path === manifestRel) continue;
    if (!f.path.includes("/generated/")) slots.push(f.path);
  }
  for (const [path, f] of now) {
    const prev = was.get(path);
    if (!prev) added.push(path);
    else if (prev.sha256 !== f.sha256 && touched.has(path)) changed.push(path);
  }
  for (const [path, f] of was) {
    if (now.has(path)) continue;
    const why = f.sources
      .filter((s) => !nowSources.has(`${s.path}\u0000${s.sha256}`))
      .map((s) => s.path);
    removed.push({
      path,
      ...kindAndId(path),
      repos: [],
      explainedBy: [...new Set(why)].sort(cmpText),
    });
  }
  return {
    n: latest.n,
    command: latest.command,
    at: latest.at,
    added: added.sort(cmpText),
    changed: changed.sort(cmpText),
    removed: removed.sort((a, b) => cmpText(a.path, b.path)),
    slots: slots.sort(cmpText),
  };
}

/** GET /api/catalog/build: built in memory and guarded, as `atticus catalog build --check`. */
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
      removals: r.guard.removals.map(removalView),
      ...(r.guard.refused ? { refused: refusalView(r.guard.refused) } : {}),
    },
    ...(last ? { last } : {}),
    orphaned: r.build.orphaned,
    problems: r.build.problems.map((p) => ({
      file: p.source,
      message: `${p.repo ? `${p.repo}: ` : ""}${p.message}`,
    })),
  };
}

/** GET /api/catalog/undo: the copies, newest first, and what undoing back to before `n` restores. */
export async function catalogUndoView(root: string, n?: number): Promise<Api.CatalogUndoViewT> {
  const undoDir = await undoDirOf(root);
  const copies = (await listUndo(undoDir)).map((c) => ({
    n: c.n,
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
      n: n ?? copies[0]!.n,
      takesBack: plan.copies.map((c) => ({ n: c.n, command: c.command })),
      files: plan.files.map((f) => ({ path: f.path, to: f.to })),
    },
  };
}

/**
 * GET /api/catalog/prune: exactly what `atticus catalog prune` lists (its own `--json`, without
 * `--yes`), so the confirm step shows the list the command removes.
 */
export async function catalogPruneView(root: string): Promise<Api.CatalogPruneViewT> {
  const { catalogPrune } = await import("./catalog-build-commands.js");
  const out: string[] = [];
  const err: string[] = [];
  await catalogPrune(root, { json: true }, { out: (l) => out.push(l), err: (l) => err.push(l) });
  try {
    const j = JSON.parse(out.join("\n")) as { files?: { path: string; why: string }[] };
    return { files: j.files ?? [] };
  } catch {
    throw new Error(err.join("\n") || "atticus catalog prune didn't say what it would remove.");
  }
}
