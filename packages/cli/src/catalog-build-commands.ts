import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import {
  acquireLock,
  catalogDirOf,
  cmpText,
  declareLink,
  deserializeRecord,
  loadOrgPack,
  LockHeldError,
  orgPackDirOf,
  parseRecord,
  recordPath,
  serializeRecord,
  undeclareLink,
  writeFileAtomic,
  type Api,
  type CatalogRecord,
} from "@maycombhq/core";
import {
  applyUndo,
  baselineTarget,
  buildAndWrite,
  buildCatalog,
  buildLines,
  filesUnder,
  generatedBeforeUpgradeDirOf,
  guardBuild,
  listUndo,
  loadBuildInputs,
  planUndo,
  readBuildManifest,
  sha256Of,
  takeUndoCopy,
  undoDirOf,
  undoHandEdits,
  UPGRADE_UNDONE,
  writeCuratedEdits,
  type BuildAndWrite,
  type BuildRefusal,
  type HandEdit,
} from "@maycombhq/scanner";
import { gitUser } from "@maycombhq/workspace";
import { buildPlanOf, pageChanged, prunePlanHash, undoPlanHash } from "./build-report.js";
import type { Output } from "./commands.js";

/**
 * The build's own commands (ADR 0195, ticket CS2): `atticus catalog build [--check]` makes
 * catalog/generated from the slots and inputs on demand (after a curated file is edited by hand,
 * or a merge conflict), `catalog edits [--curate]` turns hand edits into curated decisions,
 * `catalog undo [<n>]` takes back the last builds and `catalog prune` removes the slot files no
 * build reads. Each takes the scan's lock, and nothing is removed or overwritten without being
 * listed first.
 */

const posix = (p: string) => p.split(sep).join("/");

/**
 * A test hook (ADR 0195 point 2, the review's check-then-act): runs once after a command listed
 * what it would change and before it takes the lock, as another command writing meanwhile would.
 * Never set outside tests.
 */
export const listHooks: { afterList?: () => Promise<void> } = {};

export async function afterListed(): Promise<void> {
  const hook = listHooks.afterList;
  listHooks.afterList = undefined;
  await hook?.();
}

async function locked<T>(
  root: string,
  what: string,
  io: Output,
  run: () => Promise<T>,
): Promise<T | number> {
  await afterListed();
  let lock: Awaited<ReturnType<typeof acquireLock>>;
  try {
    lock = await acquireLock(root, "scan", what);
  } catch (e) {
    if (e instanceof LockHeldError) {
      io.err(e.message);
      return 1;
    }
    throw e;
  }
  try {
    return await run();
  } finally {
    await lock.release();
  }
}

/** A build's report for `--json` (the same structure for every command that builds). */
export function buildJson(r: BuildAndWrite) {
  return {
    written: r.write !== undefined,
    files: r.write
      ? { written: r.write.written, unchanged: r.write.unchanged, removed: r.write.removed }
      : null,
    slots: r.write?.slots ?? [],
    sources: r.build.sources,
    removed: (r.write?.removals ?? []).map((x) => ({
      kind: x.kind,
      id: x.id,
      repos: x.repos,
      explainedBy: x.explainedBy,
      reasons: x.reasons,
    })),
    retired: r.build.retired,
    orphaned: r.build.orphaned,
    orphanedDecisions: r.build.orphanedDecisions,
    ...(r.write?.undo !== undefined ? { undo: r.write.undo } : {}),
    ...(r.guard.refused ? { refused: r.guard.refused } : {}),
  };
}

/**
 * How the app says a refused build (ADR 0195 point 4; CS3 adds its confirm steps): the reason
 * in plain words and the command that goes on, so an action never just fails.
 */
export function refusalHint(r: BuildRefusal, command: string): string {
  if (r.reasons.includes("not-upgraded"))
    return "This catalog was written before beta.27: run atticus upgrade (it shows what it would do; atticus upgrade --yes applies it).";
  if (r.reasons.includes("hand-edits"))
    return `Files under catalog/generated were changed by hand. Make them curated: atticus catalog edits --curate, or discard them: ${command} --discard-edits ${r.discardEdits ?? 0}.`;
  if (r.reasons.includes("unexplained-removals"))
    return "The build would remove records nothing explains (a bug): nothing was written. The list is in the command's output.";
  if (r.reasons.includes("large-removals"))
    return `The build would remove ${r.allowRemovals ?? 0} records, more than the limit: confirm exactly these with ${command} --allow-removals ${r.allowRemovals ?? 0}.`;
  if (r.reasons.includes("empty"))
    return "The build has no record from any repo's code, so the catalog is left as it was.";
  return r.message.split("\n")[0] ?? "Nothing written.";
}

/**
 * The app's confirm of a list (ADR 0195, the review: a confirm is of the list shown): the plan
 * the page showed is worked out again under the lock, and nothing is written when it isn't that.
 * No flag of the command line takes it: the routes pass it. Its words are `pageChanged`
 * (build-report.ts), which verify --write and the scan say too.
 */
function refuseChanged(io: Output, json: boolean | undefined, message: string): number {
  io.err(message);
  if (json) io.out(JSON.stringify({ refused: { reasons: ["changed"], message } }, null, 2));
  return 1;
}

/** atticus catalog build [--check] [--json] [--allow-removals <n>] [--discard-edits <n>]. */
export async function catalogBuild(
  root: string,
  o: {
    check?: boolean;
    json?: boolean;
    allowRemovals?: number;
    discardEdits?: number;
    /** The app's: GET /api/build's `pending.plan` the confirm is of, checked under the lock. */
    plan?: string;
    /** Beta.28: the caller holds the scan's lock already (it wrote what this builds). */
    held?: boolean;
  },
  io: Output,
): Promise<number> {
  const command = "atticus catalog build";
  const run = async () => {
    // The app's confirm: the build guarded as the page listed it (no counts), and written only
    // when it lists what the page did; the same build is then written, with the counts.
    let build: BuildAndWrite["build"] | undefined;
    if (o.plan !== undefined && !o.check) {
      const listed = await buildAndWrite(root, { command, check: true });
      if (buildPlanOf(listed.guard) !== o.plan)
        return refuseChanged(io, o.json, pageChanged("what the build would remove or discard"));
      build = listed.build;
    }
    const r = await buildAndWrite(root, {
      command,
      ...(build ? { build } : {}),
      ...(o.check ? { check: true } : {}),
      ...(o.allowRemovals !== undefined ? { allowRemovals: o.allowRemovals } : {}),
      ...(o.discardEdits !== undefined ? { discardEdits: o.discardEdits } : {}),
    });
    if (o.check) {
      if (o.json)
        io.out(JSON.stringify({ upToDate: r.upToDate, sources: r.build.sources }, null, 2));
      else
        io.out(
          r.upToDate
            ? "catalog/generated is what the slots and inputs build."
            : "catalog/generated isn't what the slots and inputs build: run atticus catalog build.",
        );
      return r.upToDate ? 0 : 1;
    }
    if (o.json) io.out(JSON.stringify(buildJson(r), null, 2));
    else {
      for (const s of r.build.sources)
        io.out(
          `${s.repo}: ${s.source === "none" ? "no slot yet" : `${s.source}${s.commit ? ` at ${s.commit.slice(0, 7)}` : ""}`}`,
        );
      for (const l of buildLines(root, r)) (r.guard.refused ? io.err : io.out)(l);
    }
    for (const p of r.build.problems)
      if (!o.json) io.err(`${p.repo ? `${p.repo}: ` : ""}${p.source}: ${p.message}`);
    return r.guard.refused ? 1 : 0;
  };
  const code = o.check || o.held ? await run() : await locked(root, command, io, run);
  return code;
}

/**
 * The renames an undo takes back the builds of (ADR 0195 point 7): each copy records the command
 * that made it, and `atticus repo rename <old> <new>` names both ids. Undo puts back the catalog,
 * build.json and the slots under the old id, not the manifest and the other inputs (by design),
 * so the next build lists the repo's records as removals until the repo is renamed back; the
 * undo says so.
 */
export function undoneRenames(
  copies: readonly { command: string }[],
): { from: string; to: string; message: string }[] {
  return netRenames(copies.map((c) => c.command)).map(({ from, to }) => ({
    from,
    to,
    message: renameUndone(from, to),
  }));
}

/**
 * The renames of the copies an undo takes back (newest first, as listUndo gives them) as one net
 * rename per repo, oldest to newest: forge-ledger → forge-a then forge-a → forge-b is one rename
 * forge-ledger → forge-b, and a rename taken back by a later one (a → b, then b → a) is none, so
 * the advice names the id the manifest has now and the one to go back to (review of beta.27).
 */
export function netRenames(commandsNewestFirst: readonly string[]): { from: string; to: string }[] {
  const chain: { from: string; to: string }[] = [];
  for (const command of [...commandsNewestFirst].reverse()) {
    const m = /^atticus repo rename (\S+) (\S+)(?: |$)/.exec(command);
    if (!m) continue;
    const [, from, to] = m as unknown as [string, string, string];
    const was = chain.find((r) => r.to === from);
    if (was) was.to = to;
    else chain.push({ from, to });
  }
  return chain.filter((r) => r.from !== r.to);
}

/** What the undo of a rename's build says (the app's undo confirm says it too, from copy.ts). */
export const renameUndone = (from: string, to: string): string =>
  `This undoes the rename's build, not the rename: the manifest still names ${to}. Rename back with atticus repo rename ${to} ${from} to read the old slot again.`;

/** atticus catalog undo [<n>] [--yes]: list the copies kept, and take back the latest (or back to before n). */
export async function catalogUndo(
  root: string,
  o: {
    n?: number;
    yes?: boolean;
    json?: boolean;
    /** The app's: GET /api/build/undo's `plan.hash` the confirm is of, checked under the lock. */
    plan?: string;
  },
  io: Output,
): Promise<number> {
  const undoDir = await undoDirOf(root);
  const list = await listUndo(undoDir);
  const plan = await planUndo(undoDir, o.n);
  if ("problem" in plan) {
    if (o.json) io.out(JSON.stringify({ copies: list, problem: plan.problem }, null, 2));
    else io.err(plan.problem);
    return 1;
  }
  const renames = undoneRenames(plan.copies);
  if (!o.yes) {
    if (o.json) io.out(JSON.stringify({ copies: list, plan, renames }, null, 2));
    else {
      io.out(`The last ${list.length} builds kept here, newest first:`);
      list.forEach((c, i) => io.out(`  ${i + 1}: ${c.command} (${c.at}, ${c.files.length} files)`));
      io.out(
        `atticus catalog undo${o.n !== undefined ? ` ${o.n}` : ""} --yes would put back ${plan.files.length} ${plan.files.length === 1 ? "file" : "files"} as they were before ${plan.copies.length === 1 ? `the latest build (${plan.copies[0]!.command})` : `the ${plan.copies.length} latest builds`}:`,
      );
      for (const f of plan.files.slice(0, 30))
        io.out(`  ${f.to === "absent" ? "remove" : "restore"} ${f.path}`);
      if (plan.files.length > 30) io.out(`  and ${plan.files.length - 30} more`);
      for (const x of renames) io.out(x.message);
    }
    return 0;
  }
  return locked(root, "atticus catalog undo", io, async () => {
    // Planned again under the lock (ADR 0195 point 2): what it puts back is what it listed, or
    // nothing when another command wrote meanwhile.
    const again = await planUndo(undoDir, o.n);
    if ("problem" in again || JSON.stringify(again) !== JSON.stringify(plan)) {
      const why = changedMeanwhile("atticus catalog undo");
      io.err(why);
      if (o.json)
        io.out(JSON.stringify({ refused: { reasons: ["changed"], message: why } }, null, 2));
      return 1;
    }
    if (o.plan !== undefined && undoPlanHash(again) !== o.plan)
      return refuseChanged(io, o.json, pageChanged("what the undo puts back"));
    // Undo refuses over hand edits, as a build does.
    const b = await buildCatalog(await loadBuildInputs(root));
    const g = await guardBuild(b, { undoDir, command: "atticus catalog build" });
    if (g.refused?.reasons.includes("hand-edits")) {
      io.err(
        "Nothing undone: files under catalog/generated were changed by hand since the last build. Make them curated (atticus catalog edits --curate) or discard them (atticus catalog build --discard-edits <count>) first.",
      );
      if (o.json)
        io.out(
          JSON.stringify({ refused: { reasons: ["hand-edits"], edits: g.refused.edits } }, null, 2),
        );
      return 1;
    }
    // A catalog with no build.json (an undo took back the upgrade) has no hand-edit guard of the
    // build's: each file it would put back is checked against what the command it takes back
    // left there (the review), so a hand edit made since is never overwritten.
    if (g.refused?.reasons.includes("not-upgraded")) {
      const edited = await undoHandEdits(root, plan);
      if (edited.length) {
        io.err(
          `Nothing undone: ${edited.length} ${edited.length === 1 ? "file was" : "files were"} changed since ${plan.copies[0]!.command} wrote ${edited.length === 1 ? "it" : "them"}: ${edited.slice(0, 10).join(", ")}${edited.length > 10 ? ` and ${edited.length - 10} more` : ""}. Put ${edited.length === 1 ? "it" : "them"} back as ${edited.length === 1 ? "it was" : "they were"}, or keep ${edited.length === 1 ? "it" : "them"} and run atticus upgrade --yes.`,
        );
        if (o.json)
          io.out(
            JSON.stringify(
              { refused: { reasons: ["hand-edits"], edits: edited.map((path) => ({ path })) } },
              null,
              2,
            ),
          );
        return 1;
      }
    }
    const r = await applyUndo(
      root,
      undoDir,
      plan,
      `atticus catalog undo${o.n !== undefined ? ` ${o.n}` : ""}`,
    );
    // The restored record files against the restored build.json: one that differs was a hand
    // edit before the build undone (a discard, say), and is one again, as it was; the next build
    // lists it rather than overwrite it.
    const m = await readBuildManifest(baselineTarget(root).manifest);
    const bad: string[] = [];
    for (const f of m.manifest?.files ?? []) {
      const text = await readFile(join(root, ...f.path.split("/")), "utf8").catch(() => undefined);
      if (text === undefined || sha256Of(text.replace(/\r\n?/g, "\n")) !== f.sha256)
        bad.push(f.path);
    }
    if (o.json)
      io.out(
        JSON.stringify({ restored: r.restored, undo: r.undo, handEdits: bad, renames }, null, 2),
      );
    else {
      io.out(
        `Put back ${r.restored.length} ${r.restored.length === 1 ? "file" : "files"} as ${r.restored.length === 1 ? "it was" : "they were"} before ${plan.copies.map((c) => c.command).join(", then ")}.`,
      );
      if (r.undo !== undefined)
        io.out(`This undo can be undone too: atticus catalog undo --yes (copy ${r.undo}).`);
      if (plan.copies.some((c) => c.command.startsWith("atticus upgrade"))) io.out(UPGRADE_UNDONE);
      for (const x of renames) io.out(x.message);
      if (bad.length)
        io.out(
          `${bad.length} restored ${bad.length === 1 ? "file is a hand edit" : "files are hand edits"} again, as before (the next build lists ${bad.length === 1 ? "it" : "them"}: atticus catalog edits --curate keeps ${bad.length === 1 ? "it" : "them"}): ${bad.join(", ")}`,
        );
    }
    return 0;
  });
}

/** What a command listed changed before it could take the lock: it writes nothing. */
const changedMeanwhile = (command: string) =>
  `Nothing written: what ${command} would change isn't what it listed any more (another command wrote meanwhile). Run it again to list it.`;

/** The files `catalog prune` lists: the slot files no build reads, and the upgrade's copy. */
export async function pruneList(root: string): Promise<{ path: string; why: string }[]> {
  const b = await buildCatalog(await loadBuildInputs(root));
  return [
    ...b.orphaned.flatMap((x) =>
      x.files.map((f) => ({
        path: f,
        why: x.why === "archived" ? `${x.repo} is archived` : `${x.repo} isn't in the manifests`,
      })),
    ),
    ...(await filesUnder(generatedBeforeUpgradeDirOf(root))).map((p) => ({
      path: posix(relative(root, p)),
      why: "the copy the upgrade kept of the catalog before it",
    })),
  ].sort((a, x) => cmpText(a.path, x.path));
}

/** atticus catalog prune [--yes]: the slot files no build reads, listed, and removed only on confirmation. */
export async function catalogPrune(
  root: string,
  o: {
    yes?: boolean;
    json?: boolean;
    /** The app's: GET /api/build/prune's `plan` the confirm is of, checked under the lock. */
    plan?: string;
  },
  io: Output,
): Promise<number> {
  const files = await pruneList(root);
  if (!files.length) {
    if (o.json) io.out(JSON.stringify({ files: [], removed: [] }, null, 2));
    else io.out("Nothing to prune: every slot file is one a build reads.");
    return 0;
  }
  if (!o.yes) {
    if (o.json) io.out(JSON.stringify({ files, removed: [] }, null, 2));
    else {
      io.out(`${files.length} ${files.length === 1 ? "file" : "files"} no build reads:`);
      for (const f of files) io.out(`  ${f.path} (${f.why})`);
      io.out(
        "Nothing removed. atticus catalog prune --yes removes exactly these (atticus catalog undo and git keep them).",
      );
    }
    return 0;
  }
  return locked(root, "atticus catalog prune", io, async () => {
    // Listed again under the lock: it removes exactly what it listed, or nothing.
    const again = await pruneList(root);
    if (o.plan !== undefined && prunePlanHash(again) !== o.plan)
      return refuseChanged(io, o.json, pageChanged("what prune removes"));
    if (JSON.stringify(again) !== JSON.stringify(files)) {
      const why = changedMeanwhile("atticus catalog prune");
      io.err(why);
      if (o.json)
        io.out(
          JSON.stringify(
            { files, removed: [], refused: { reasons: ["changed"], message: why } },
            null,
            2,
          ),
        );
      return 1;
    }
    const undoDir = await undoDirOf(root);
    const touched = files.map((f) => ({ path: join(root, ...f.path.split("/")), text: null }));
    const undo = await takeUndoCopy(root, undoDir, "atticus catalog prune", touched);
    for (const t of touched) await rm(t.path, { force: true });
    if (o.json) io.out(JSON.stringify({ files, removed: files.map((f) => f.path), undo }, null, 2));
    else {
      io.out(`Removed ${files.length} ${files.length === 1 ? "file" : "files"}:`);
      for (const f of files) io.out(`  ${f.path}`);
      if (undo !== undefined) io.out(`atticus catalog undo --yes puts them back (copy ${undo}).`);
    }
    return 0;
  });
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100);

/** Fields an assert can't set (identity and provenance belong to the catalog). */
const PROTECTED = new Set(["kind", "id", "schemaVersion", "confidence", "evidence"]);

/** What `edits --curate` would do with one hand-edited file. */
interface EditPlan {
  path: string;
  how: HandEdit["how"];
  /** The decision drafted for it, when one can be. */
  decision?: Record<string, unknown>;
  /** Why it can't be made curated. */
  why?: string;
  /**
   * Fields it changes that no decision can set, or removes (an assert sets fields, it can't
   * take one away): the next build would put them back, so they are said, never dropped quietly.
   */
  fields?: string[];
  /** Of `fields`, those the edit removed. */
  removed?: string[];
}

/** What an edit does that no decision can say: "changes evidence, which a curated decision can't set". */
function cantSay(p: Pick<EditPlan, "fields" | "removed">): string {
  const removed = p.removed ?? [];
  const changed = (p.fields ?? []).filter((f) => !removed.includes(f));
  const what = [
    ...(changed.length ? [`changes ${changed.join(", ")}`] : []),
    ...(removed.length ? [`removes ${removed.join(", ")}`] : []),
  ].join(" and ");
  const verb =
    changed.length && removed.length ? "set or remove" : removed.length ? "remove" : "set";
  return `${what}, which a curated decision can't ${verb}`;
}

/**
 * The hand edits and what `edits --curate` would draft for each, from the files as they are: what
 * the command lists, and plans again under the lock before it writes (ADR 0195 point 2).
 */
async function planEdits(
  root: string,
  undoDir: string,
): Promise<EditPlan[] & { buildPlan?: string }> {
  const inputs = await loadBuildInputs(root);
  // Built from the inputs as loaded, where GET /api/build (catalogBuildView: buildAndWrite with
  // `check`) builds them through slotsAfter and withFactsWrites. With no slot writes those give
  // the same readers, facts and legacy slots and an empty `pending`, which neither the build
  // nor its cache key reads (slotsKeyOf leaves it out): the same build, so buildPlanOf gives the
  // page's plan hash and the confirm under the lock compares like with like.
  const b = await buildCatalog(inputs);
  const g = await guardBuild(b, { undoDir, command: "atticus catalog build" });
  const edits = g.refused?.reasons.includes("hand-edits") ? (g.refused.edits ?? []) : [];
  const built = new Map(b.records.map((r) => [recordPath(r), r]));
  // A record of a repo archived or removed since the last build (its build refused, say, for a
  // large removal, the manifest left as the person edited it): the build no longer makes it, and
  // its slot holds what the readers gave, not what the build made of it (the merge names an
  // endpoint by its path, and combines a spec's record with the code's). The record as the last
  // build made it is what the same inputs build with that repo back: built once, only when an
  // edit needs it, and never written or kept. An archived repo is built as listed. A removed
  // one's entry is gone, so it is listed again from its slot's Component (its component, system
  // and type), and a record of it is used only when its text is the one build.json hashed: what
  // the last build wrote, byte for byte.
  const genRel = posix(relative(root, join(catalogDirOf(root), "generated")));
  let restored: Map<string, CatalogRecord> | undefined;
  const asLastBuilt = async (rel: string): Promise<CatalogRecord | undefined> => {
    if (!restored) {
      restored = new Map();
      const op = inputs.op;
      const listed = new Set(op.profiles.flatMap((p) => (p.repos?.repos ?? []).map((r) => r.id)));
      const archived = new Set(
        op.profiles.flatMap((p) => (p.repos?.repos ?? []).filter((r) => r.archived)),
      );
      const removed = [...inputs.slots.readers]
        .filter(([repo]) => !listed.has(repo))
        .flatMap(([repo, x]) => {
          const c = "slot" in x ? x.slot.records.find((r) => r.kind === "Component") : undefined;
          return c && typeof c.type === "string"
            ? [
                {
                  id: repo,
                  url: repo,
                  defaultBranch: "main",
                  branches: [],
                  type: c.type,
                  owner: "unknown",
                  component: c.id,
                  ...(typeof c.system === "string" ? { system: c.system } : {}),
                  extractors: [],
                  dialects: [],
                  sparse: [],
                  archived: false,
                  hosts: [],
                  modules: [],
                },
              ]
            : [];
        });
      const at = op.profiles.findIndex((p) => p.repos);
      if ((archived.size || removed.length) && at >= 0) {
        const back: typeof op = {
          ...op,
          profiles: op.profiles.map((p, k) =>
            p.repos
              ? {
                  ...p,
                  repos: {
                    ...p.repos,
                    repos: [
                      ...p.repos.repos.map((r) => (r.archived ? { ...r, archived: false } : r)),
                      ...(k === at ? removed : []),
                    ],
                  },
                }
              : p,
          ),
        };
        const a = await buildCatalog({ ...inputs, op: back });
        const m = await readBuildManifest(baselineTarget(root).manifest);
        const shas = new Map((m.manifest?.files ?? []).map((f) => [f.path, f.sha256]));
        const fromRemoved = new Set(removed.map((r) => r.id));
        for (const r of a.records) {
          const p = recordPath(r);
          const ev = new Set((r.evidence ?? []).map((e) => e.repo).filter(Boolean));
          // A record of a removed repo is used only when its text is what the last build wrote.
          if ([...ev].some((x) => fromRemoved.has(String(x)))) {
            const text = a.files.get(p);
            const want = shas.get(`${genRel}/${p}`);
            if (text === undefined || want === undefined || sha256Of(text) !== want) continue;
          }
          restored.set(p, r);
        }
      }
    }
    return restored.get(rel);
  };
  const out: EditPlan[] & { buildPlan?: string } = [];
  // The plan GET /api/build lists for this build (an app's confirm checks it under the lock).
  Object.defineProperty(out, "buildPlan", {
    value: buildPlanOf(g),
    enumerable: false,
  });
  for (const e of edits) {
    const rel = e.path.startsWith(`${genRel}/`) ? e.path.slice(genRel.length + 1) : e.path;
    const derivedNow = built.get(rel);
    const plan = (x: Omit<EditPlan, "path" | "how">) =>
      out.push({ path: e.path, how: e.how, ...x });
    if (e.how === "deleted") {
      // A record this build no longer makes is suppressed by the id its file named, so it
      // stays deleted should it return.
      const id = derivedNow?.id ?? (rel.split("/").pop() ?? "").replace(/\.ya?ml$/, "");
      plan({ decision: { action: "suppress", target: id, value: null } });
      continue;
    }
    if (e.how === "added") {
      // ADR 0195 addendum (CS2): "an added record can't be a curated decision (one changes or
      // suppresses a record the build makes) and is said". It stays a hand edit, and nothing is
      // written for it, until it is discarded or said where the build reads it.
      plan({
        why: derivedNow
          ? "the build makes a record of its id: change that record instead"
          : "an added record can't be a curated decision (a decision changes or suppresses a record the build makes); discard it, or say it where the build reads it: a fact in facts/<repo>.jsonl that verify --write checks, or a rule in the org pack",
      });
      continue;
    }
    const text = await readFile(join(root, ...e.path.split("/")), "utf8").catch(() => "");
    const p = deserializeRecord(text);
    // A record this build no longer makes (its repo removed or archived since): the edit is
    // read against the record as the build makes it with its repo not archived, or else (a repo
    // the manifests no longer list) as its slot last held it, and the assert waits, orphaned,
    // until the record returns.
    const fromSlot = (): CatalogRecord | undefined => {
      if (!p.ok) return undefined;
      const { kind, id } = p.record;
      const held = [
        ...[...inputs.slots.readers.values()].flatMap((x) => ("slot" in x ? x.slot.records : [])),
        ...(inputs.slots.legacy && "slot" in inputs.slots.legacy
          ? inputs.slots.legacy.slot.records
          : []),
      ];
      return held.find((r) => r.kind === kind && r.id === id);
    };
    const derived = derivedNow ?? (await asLastBuilt(rel)) ?? fromSlot();
    if (!p.ok || !derived) {
      plan({ why: "it doesn't read as a record, or the build no longer makes it" });
      continue;
    }
    const now = p.record as unknown as Record<string, unknown>;
    const was = derived as unknown as Record<string, unknown>;
    const value: Record<string, unknown> = {};
    const bad: string[] = [];
    const removed: string[] = [];
    for (const k of [...new Set([...Object.keys(now), ...Object.keys(was)])].sort(cmpText)) {
      if (JSON.stringify(now[k]) === JSON.stringify(was[k])) continue;
      // A field the person deleted: an assert sets fields and can't take one away (C1's
      // CuratedDecision), so it is said with those no decision can set, never asserted over
      // silently (ADR 0195 point 4: hand edits are never silently lost), and made curated
      // without it only on --drop-fields: the next build puts it back.
      if (!(k in now)) removed.push(k);
      if (PROTECTED.has(k) || !(k in now)) bad.push(k);
      else value[k] = now[k];
    }
    const said = { fields: bad, ...(removed.length ? { removed } : {}) };
    if (bad.length && !Object.keys(value).length) {
      plan({ why: `it only ${cantSay(said)}`, ...said });
      continue;
    }
    if (!Object.keys(value).length) {
      plan({
        why: "its record says the same as the build's (a comment or the layout): discard it",
      });
      continue;
    }
    plan({
      decision: { action: "assert", target: derived.id, value },
      ...(bad.length ? said : {}),
    });
  }
  return out;
}

/**
 * atticus catalog edits [--curate [--drop-fields <count>]]: the files under catalog/generated
 * changed by hand since the last build. With --curate each becomes a curated decision (ADR 0195
 * point 4) as an edit to propose: a changed file an assert of the fields it changed, a deleted
 * one a suppress. An added record can't be one, and is said. A changed file that also changes
 * fields no decision can set (identity and provenance: evidence, confidence) is listed with
 * them, and made curated only with `--drop-fields <count>`, the count of such files listed: the
 * next build replaces the file, and those fields go back to what the build makes. Nothing is
 * built here; the next build replaces each file made curated, its bytes kept for undo.
 */
export async function catalogEdits(
  root: string,
  o: {
    curate?: boolean;
    json?: boolean;
    by?: string;
    now?: Date;
    dropFields?: number;
    /** The app's: GET /api/build's `pending.plan` the confirm is of, checked under the lock. */
    plan?: string;
  },
  io: Output,
): Promise<number> {
  const undoDir = await undoDirOf(root);
  const listed = await planEdits(root, undoDir);
  const edits = listed.map((p) => ({ path: p.path, how: p.how }));
  if (!edits.length) {
    if (o.json) io.out(JSON.stringify({ edits: [], decisions: [] }, null, 2));
    else io.out("No file under catalog/generated was changed by hand since the last build.");
    return 0;
  }
  const dropping = listed.filter((p) => p.decision && p.fields?.length);
  if (!o.curate) {
    if (o.json)
      io.out(
        JSON.stringify(
          {
            edits,
            decisions: [],
            ...(dropping.length
              ? { dropFields: dropping.length, fields: dropping.map((p) => pick(p)) }
              : {}),
          },
          null,
          2,
        ),
      );
    else {
      io.out(
        `${edits.length} ${edits.length === 1 ? "file was" : "files were"} changed by hand since the last build:`,
      );
      for (const e of listed)
        io.out(`  ${e.how}: ${e.path}${e.fields?.length ? ` (${cantSay(e)})` : ""}`);
      io.out(
        `Make them curated decisions: atticus catalog edits --curate${dropping.length ? ` --drop-fields ${dropping.length}` : ""}. Or discard them: atticus catalog build --discard-edits ${edits.length}.`,
      );
    }
    return 1;
  }
  return locked(root, "atticus catalog edits --curate", io, async () => {
    // Planned again under the lock: what it writes is what it listed, or nothing.
    const plans = await planEdits(root, undoDir);
    if (JSON.stringify(plans) !== JSON.stringify(listed)) {
      const why =
        "Nothing written: the hand edits changed while this ran (another command wrote meanwhile). Run atticus catalog edits again to list them.";
      io.err(why);
      if (o.json)
        io.out(JSON.stringify({ edits, decisions: [], refused: { message: why } }, null, 2));
      return 1;
    }
    if (o.plan !== undefined && plans.buildPlan !== o.plan)
      return refuseChanged(io, o.json, pageChanged("the hand edits"));
    const by = o.by ?? (await gitUser(root)).handle;
    const at = (o.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
    const curatedDir = join(catalogDirOf(root), "curated");
    const written: string[] = [];
    const curated: string[] = [];
    const left: { path: string; why: string; fields?: string[] }[] = [];
    /** Edits a decision already there says (the same suppress): nothing written for them. */
    const kept: { path: string; decision: string }[] = [];
    const confirmed = o.dropFields === dropping.length;
    for (const p of plans) {
      if (!p.decision) {
        left.push({ path: p.path, why: p.why ?? "it can't be made curated" });
        continue;
      }
      if (p.fields?.length && !confirmed) {
        left.push({
          path: p.path,
          why: `it also ${cantSay(p)} (the next build would put ${p.fields.length === 1 ? "it" : "them"} back): make it curated without ${p.fields.length === 1 ? "it" : "them"} with atticus catalog edits --curate --drop-fields ${dropping.length}`,
          fields: p.fields,
        });
        continue;
      }
      // A record made curated before (an earlier curate of it): that decision stays its author's,
      // untouched, and this edit is a decision of its own that applies after it.
      const w = await writeDecision(root, curatedDir, p.decision, {
        idBase: `cd-edit-${String(p.decision.action)}-${String(p.decision.target)}`,
        reason: `A hand edit to ${p.path}, made curated (atticus catalog edits --curate).`,
        by,
        at,
      });
      if ("kept" in w) {
        kept.push({ path: p.path, decision: w.kept });
        curated.push(p.path);
        continue;
      }
      if ("problem" in w) {
        left.push({ path: p.path, why: w.problem });
        continue;
      }
      written.push(w.written);
      curated.push(p.path);
    }
    if (o.dropFields !== undefined && !confirmed)
      left.push({
        path: "--drop-fields",
        why: `${o.dropFields} doesn't name the ${dropping.length} listed`,
      });
    // The next build replaces each edit made curated (its bytes kept in that build's undo copy);
    // nothing is built here, so the person reviews the decisions first.
    await writeCuratedEdits(root, undoDir, curated);
    if (o.json)
      io.out(
        JSON.stringify(
          {
            edits,
            decisions: written,
            ...(kept.length ? { kept } : {}),
            left,
            ...(dropping.length ? { dropFields: dropping.length } : {}),
            ...(confirmed && dropping.length ? { dropped: dropping.map((p) => pick(p)) } : {}),
          },
          null,
          2,
        ),
      );
    else {
      for (const w of written)
        io.out(`Wrote ${w}: propose it in a pull request so every build keeps the edit.`);
      for (const k of kept)
        io.out(`${k.path}: ${k.decision} already says this edit (left as it is).`);
      if (confirmed)
        for (const d of dropping)
          io.out(
            `${d.path}: made curated without ${d.fields!.join(", ")}, which the next build puts back as it makes ${d.fields!.length === 1 ? "it" : "them"}.`,
          );
      for (const l of left) io.err(`${l.path}: not made curated: ${l.why}.`);
      if (written.length)
        io.out(
          "atticus catalog build (or the next scan) builds with them, and replaces the edited files; their bytes are kept for atticus catalog undo.",
        );
      if (left.length)
        io.err(
          `What isn't curated stays a hand edit: discard it with atticus catalog build --discard-edits <count> (a copy is kept for undo).`,
        );
    }
    return left.length ? 1 : 0;
  });
}

const pick = (p: EditPlan) => ({
  path: p.path,
  fields: p.fields ?? [],
  ...(p.removed?.length ? { removed: p.removed } : {}),
});

/**
 * One curated decision written to `catalog/curated/curateddecision/` as `edits --curate` writes
 * it (and, beta.28, Delete this link on the canvas and Edit the map): its id and time from `decisionFor`, the
 * record checked against C1 and written canonical. The same suppress already there is `kept`
 * (its file, nothing written).
 */
async function writeDecision(
  root: string,
  curatedDir: string,
  decision: Record<string, unknown>,
  o: { idBase: string; reason: string; by: string; at: string },
): Promise<
  { written: string; id: string; bytes: string } | { kept: string } | { problem: string }
> {
  const placed = await decisionFor(curatedDir, slug(o.idBase), decision, o.at);
  if ("keep" in placed)
    return { kept: `${posix(relative(root, curatedDir))}/curateddecision/${placed.keep}` };
  const record = parseRecord({
    kind: "CuratedDecision",
    id: placed.id,
    schemaVersion: 2,
    status: "current",
    confidence: "asserted",
    ...decision,
    reason: o.reason,
    by: o.by,
    at: placed.at,
  });
  if (!record.ok) return { problem: record.issues.map((i) => i.message).join("; ") };
  const full = join(curatedDir, ...recordPath(record.record as CatalogRecord).split("/"));
  await mkdir(dirname(full), { recursive: true });
  const bytes = serializeRecord(record.record as CatalogRecord);
  await writeFileAtomic(full, bytes);
  return { written: posix(relative(root, full)), id: placed.id, bytes };
}

/**
 * Where `edits --curate` puts a decision, and when it says it was made. Every decision already
 * in `catalog/curated` is its author's and is never written over: a second curate of a record
 * (another person's, or the same person's later) is a decision of its own, under the first free
 * id of `id`, `id-2`, `id-3`, ... with only the fields this edit changed (the build it was read
 * against already had the earlier decisions applied, so their fields are not in it). Decisions
 * apply in time order, then id (applyCurated), so this one is dated after every decision on its
 * target already there (a second after the latest, when the clock says otherwise: another
 * machine's ahead, or the same second): it applies after them, and wins on the fields it sets,
 * while theirs keep the rest. The same suppress already there is that decision: `keep`, nothing
 * written.
 */
async function decisionFor(
  curatedDir: string,
  id: string,
  decision: Record<string, unknown>,
  now: string,
): Promise<{ id: string; at: string } | { keep: string }> {
  const dir = join(curatedDir, "curateddecision");
  const held: { file: string; d: Record<string, unknown> }[] = [];
  for (const n of (await readdir(dir).catch(() => [] as string[])).sort(cmpText)) {
    if (!/\.ya?ml$/.test(n)) continue;
    const p = deserializeRecord(await readFile(join(dir, n), "utf8").catch(() => ""));
    const d = p.ok ? (p.record as unknown as Record<string, unknown>) : undefined;
    if (d?.kind === "CuratedDecision" && d.target === decision.target) held.push({ file: n, d });
  }
  const same = held.find(
    ({ d }) =>
      decision.action === "suppress" &&
      d.action === "suppress" &&
      d.status === "current" &&
      (d.value ?? null) === null,
  );
  if (same) return { keep: same.file };
  let at = now;
  // By the instant each `at` names, as applyCurated orders them (an offset is allowed).
  const latest = held
    .map(({ d }) => (typeof d.at === "string" ? Date.parse(d.at) : NaN))
    .filter((x) => !Number.isNaN(x))
    .reduce((m, x) => Math.max(m, x), -Infinity);
  if (latest !== -Infinity && Date.parse(at) <= latest)
    at = new Date(Math.floor(latest / 1000) * 1000 + 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const fileOf = (x: string) => join(dir, `${x}.yaml`);
  if (!existsSync(fileOf(id))) return { id, at };
  for (let n = 2; ; n++) if (!existsSync(fileOf(`${id}-${n}`))) return { id: `${id}-${n}`, at };
}

// ------------------------------------------------------------ Delete this link (beta.28)

/** The id every decision Delete this link writes starts with (then the Interface's id). */
export const LINK_DELETE_PREFIX = "cd-link-delete-";

/**
 * The reason a Delete this link decision says; `deletedLinks` reads the link back from it. The
 * two ends are quoted (a name may hold " → "), and `group` names the one delete it is of, so two
 * deletes written at the same second are two links.
 */
const linkDeleteReason = (from: string, to: string, n: number, group: string) =>
  `Deleted on the canvas: the link ${JSON.stringify(from)} → ${JSON.stringify(to)} (${n} call${n === 1 ? "" : "s"}) [${group}].`;
const LINK_DELETE_REASON =
  /^Deleted on the canvas: the link ("(?:[^"\\]|\\.)*") → ("(?:[^"\\]|\\.)*") \((\d+) calls?\) \[([a-z0-9-]+)\]\.$/;
/** The reason as the first cut wrote it (unquoted ends, no group). */
const LINK_DELETE_REASON_0 = /^Deleted on the canvas: the link (.+) → (.+) \((\d+) calls?\)\.$/;

function linkOfReason(reason: string): { from: string; to: string; calls: number; group?: string } {
  const m = LINK_DELETE_REASON.exec(reason);
  if (m) {
    try {
      return {
        from: JSON.parse(m[1]!) as string,
        to: JSON.parse(m[2]!) as string,
        calls: Number(m[3]),
        group: m[4]!,
      };
    } catch {
      // Read as the first cut's below.
    }
  }
  const o = LINK_DELETE_REASON_0.exec(reason);
  return o ? { from: o[1]!, to: o[2]!, calls: Number(o[3]) } : { from: "", to: "", calls: 0 };
}

const decisionDirOf = (root: string) => join(catalogDirOf(root), "curated", "curateddecision");

/** A decision Delete this link wrote, still current: an unscoped suppress of its id prefix. */
function isLinkDelete(d: Record<string, unknown> | undefined): boolean {
  return (
    d?.kind === "CuratedDecision" &&
    typeof d.id === "string" &&
    d.id.startsWith(LINK_DELETE_PREFIX) &&
    d.action === "suppress" &&
    d.status === "current" &&
    (d.value ?? null) === null
  );
}

interface DeletedLink {
  from: string;
  to: string;
  calls: number;
  by: string;
  at: string;
  /** Beta.28 review: no Interface of it would be drawn now even without the suppress. */
  gone?: boolean;
  /** Taken away by a redirect (Edit the map), its new link added in the same change. */
  redirect?: boolean;
  decisions: { id: string; target: string; file: string; gone?: boolean }[];
}

/**
 * The links deleted on the canvas (GET /api/links/deleted): each Delete's decisions, one per
 * Interface behind the link, grouped by the delete they were written for, newest first. With
 * `suppressed` (the ids the build's curated suppresses take away now), a decision whose
 * Interface the build no longer makes says `gone`, and a link all of whose are.
 */
export async function deletedLinks(
  root: string,
  o: { suppressed?: ReadonlySet<string> } = {},
): Promise<{ links: DeletedLink[] }> {
  const dir = decisionDirOf(root);
  const rel = posix(relative(root, dir));
  const groups = new Map<string, DeletedLink>();
  for (const n of (await readdir(dir).catch(() => [] as string[])).sort(cmpText)) {
    if (!n.endsWith(".yaml")) continue;
    const p = deserializeRecord(await readFile(join(dir, n), "utf8").catch(() => ""));
    const d = p.ok ? (p.record as unknown as Record<string, unknown>) : undefined;
    if (!d || !isLinkDelete(d)) continue;
    const m = linkOfReason(String(d.reason ?? ""));
    const by = String(d.by ?? "");
    const at = String(d.at ?? "");
    const key = m.group ? `g\u0000${m.group}` : `${String(d.reason)}\u0000${by}\u0000${at}`;
    const g = groups.get(key) ?? {
      from: m.from,
      to: m.to,
      calls: m.calls,
      by,
      at,
      ...(m.group?.startsWith("r-") ? { redirect: true } : {}),
      decisions: [],
    };
    const target = String(d.target);
    g.decisions.push({
      id: String(d.id),
      target,
      file: `${rel}/${n}`,
      ...(o.suppressed && !o.suppressed.has(target) ? { gone: true } : {}),
    });
    groups.set(key, g);
  }
  const links = [...groups.values()]
    .map((l) => (l.decisions.every((x) => x.gone) && o.suppressed ? { ...l, gone: true } : l))
    .sort((a, b) =>
      a.at === b.at ? cmpText(`${a.from}>${a.to}`, `${b.from}>${b.to}`) : a.at < b.at ? 1 : -1,
    );
  return { links };
}

/** The ids the build's curated suppresses take away now (a build in memory, nothing written). */
export async function suppressedNow(root: string): Promise<Set<string>> {
  const r = await buildAndWrite(root, { command: "atticus catalog build", check: true });
  return new Set(r.build.curated.suppressed);
}

/**
 * The build after a Delete, a Bring back or Edit the map, run under the lock the writes hold
 * (beta.28 review: no other writer slips in between). The removals this run's own suppresses
 * explain (`targets`) are what the person confirmed (the confirm listed the links and their
 * calls), so a build that waits only for them is confirmed with their count, as Catalog builds
 * would; any other removal (a teammate's suppress from a pull, say) leaves the build's own
 * refusal, said in its lines and listed on Catalog builds (nothing written).
 */
export async function buildAfterDecisions(
  root: string,
  targets: ReadonlySet<string>,
  io: Output,
  o: {
    /** The build's inputs this run wrote (`org-pack` for a declaration), as removals name them. */
    inputs?: ReadonlySet<string>;
    /** What the build would have removed before this run wrote anything: never this run's. */
    pending?: ReadonlySet<string>;
  } = {},
): Promise<number> {
  const command = "atticus catalog build";
  const listed = await buildAndWrite(root, { command, check: true });
  const r = listed.guard.refused;
  const removals = listed.guard.removals;
  const byInput = (x: (typeof removals)[number]) =>
    !o.pending?.has(x.id) &&
    x.reasons.every((k) => k === "input") &&
    x.explainedBy.every((w) => {
      const m = /^an input changed \((.+)\)$/.exec(w);
      return !!m && !!o.inputs?.has(m[1]!);
    });
  const ours =
    !!r &&
    r.reasons.length === 1 &&
    r.reasons[0] === "large-removals" &&
    removals.length > 0 &&
    removals.every((x) => targets.has(x.id) || byInput(x));
  // The knock-on removals the person's changes make (a feature a declaration changes), said.
  if (ours)
    for (const x of removals.filter((y) => !targets.has(y.id)))
      io.out(`Also takes away ${x.kind}/${x.id}: ${x.explainedBy.join("; ")}.`);
  return catalogBuild(
    root,
    {
      ...(ours ? { allowRemovals: removals.length, plan: buildPlanOf(listed.guard) } : {}),
      held: true,
    },
    io,
  );
}

/**
 * Delete this link (beta.28, the owner's decision of 2026-11-12): Edit the map's delete alone.
 * Every id must be an Interface the catalog has now.
 */
export async function deleteLink(
  root: string,
  o: { interfaces: readonly string[]; from: string; to: string; by?: string; now?: Date },
  io: Output,
): Promise<number> {
  const r = await applyMapEdits(
    root,
    {
      edits: [
        { kind: "delete", delete: { interfaces: [...o.interfaces], from: o.from, to: o.to } },
      ],
      ...(o.by ? { by: o.by } : {}),
      ...(o.now ? { now: o.now } : {}),
      what: "Delete this link",
    },
    io,
  );
  return r.code;
}

/** Bring back a deleted link: its Delete's decisions removed, then the build, under one lock. */
export async function undeleteLink(
  root: string,
  o: { decisions: readonly string[] },
  io: Output,
): Promise<number> {
  const dir = decisionDirOf(root);
  return locked(root, "Bring back the link", io, async () => {
    const targets = new Set<string>();
    const files: { path: string; target: string }[] = [];
    for (const id of new Set(o.decisions)) {
      const path = join(dir, `${id}.yaml`);
      const p = deserializeRecord(await readFile(path, "utf8").catch(() => ""));
      const d = p.ok ? (p.record as unknown as Record<string, unknown>) : undefined;
      if (!isLinkDelete(d) || d!.id !== id) {
        io.err(`${id} isn't a link deleted on the canvas: nothing removed.`);
        return 1;
      }
      files.push({ path, target: String(d!.target) });
    }
    for (const f of files) {
      await rm(f.path, { force: true });
      targets.add(f.target);
      io.out(`Removed ${posix(relative(root, f.path))}: Interface/${f.target} is drawn again.`);
    }
    return buildAfterDecisions(root, targets, io);
  });
}

// ------------------------------------------------------------ Edit the map (beta.28)

type MapEditOutcome = Api.MapEditsResultT["edits"][number];

const addWords = (e: Api.MapEditT) => {
  if ("pair" in e) {
    const p = e.pair;
    const n = p.pairs.length;
    return `${p.from} → ${p.to.repo ?? p.to.system} (${n} call${n === 1 ? "" : "s"} paired)`;
  }
  if (!("add" in e)) return "";
  const a = e.add;
  return a.kind === "call" ? `${a.system} calls ${a.route}` : `${a.system} ${a.side} ${a.topic}`;
};

/** A staged change in words, as the job's lines and its result say it. */
export function mapEditWords(e: Api.MapEditT): string {
  if (e.kind === "delete") return `delete ${e.delete.from} → ${e.delete.to}`;
  if (e.kind === "add") return `add: ${addWords(e)}`;
  return `redirect ${e.delete.from} → ${e.delete.to} to: ${addWords(e)}`;
}

/** Test hooks, under the lock: around each change's writes, and once they are all written. */
export const mapEditHooks: {
  beforeBuild?: () => Promise<void>;
  /** Before each change's writes, and after them (a test's other writer landing). */
  beforeWrite?: (i: number) => Promise<void>;
  afterWrite?: (i: number) => Promise<void>;
} = {};

/**
 * Edit the map's Apply my changes (beta.28, the owner's ask of 2026-11-12: "delete arrows and add
 * arrows in one go and click a button"): every change staged on the canvas, checked already by
 * POST /api/map/edits, written and then built once, all under the scan's lock. A delete is Delete
 * this link's curated suppress of each Interface, except one a person declared on the canvas,
 * whose declaration is withdrawn instead (only its lines); an add is Declare a link…'s line in the
 * profile or Connect to…'s pairing in the repo's corrections; a redirect is both. Each file's bytes
 * are kept before its first write: a write that fails puts back every file still as this run
 * wrote it (a new file is removed), says each change's outcome and builds nothing.
 */
export async function applyMapEdits(
  root: string,
  o: { edits: readonly Api.MapEditT[]; by?: string; now?: Date; what?: string },
  io: Output,
): Promise<{ code: number; edits: MapEditOutcome[]; built: boolean }> {
  const outcomes: MapEditOutcome[] = o.edits.map((e, edit) => ({
    edit,
    kind: e.kind,
    state: "not-tried",
  }));
  const n = o.edits.length;
  let built = false;
  const code = await locked(root, o.what ?? "Edit the map", io, async () => {
    const by = o.by ?? (await gitUser(root)).handle;
    const at = (o.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
    const stamp = at.replace(/\D/g, "").slice(0, 14);
    const { correctionLine, factsDirOf } = await import("@maycombhq/core");
    const records = (
      await (
        await import("@maycombhq/scanner")
      ).readCatalog(join(catalogDirOf(root), "generated"), { fresh: true })
    ).records;
    const byId = new Map(records.map((r) => [r.id, r] as const));
    const targets = new Set<string>();
    // What the build would remove before this run writes anything (a teammate's pulled change):
    // never confirmed as this run's.
    const pending = new Set(
      (
        await buildAndWrite(root, { command: "atticus catalog build", check: true })
      ).guard.removals.map((x) => x.id),
    );
    const inputs = new Set<string>();
    // Each file this run writes, as each writer read it under its own lock or check (never read
    // apart from the write, so another writer's change landing first is kept): a profile's bytes
    // before this run's first write and after its last ("replace"), a new decision's bytes
    // ("new"), or the lines appended to a corrections file ("append"), and the changes that wrote
    // it.
    type Wrote =
      | {
          how: "replace";
          before: string;
          wrote: string;
          edits: Set<number>;
          /** Another writer wrote it between two of this run's writes (the third review). */
          between?: true;
        }
      | { how: "new"; wrote: string; edits: Set<number> }
      | { how: "append"; lines: string[]; edits: Set<number>; created?: true };
    const files = new Map<string, Wrote>();
    const replaced = (f: string, i: number, r: { before: string; wrote?: string }) => {
      const x = files.get(f);
      if (x?.how === "replace") {
        // This write started from bytes this run didn't leave: someone wrote in between, so
        // the bytes from before the run are no longer this run's to put back.
        if (r.before !== x.wrote) x.between = true;
        x.wrote = r.wrote ?? x.wrote;
        x.edits.add(i);
      } else
        files.set(f, {
          how: "replace",
          before: r.before,
          wrote: r.wrote ?? r.before,
          edits: new Set([i]),
        });
    };
    for (const [i, e] of o.edits.entries()) {
      const said = `Change ${i + 1} of ${n}, ${mapEditWords(e)}`;
      try {
        await mapEditHooks.beforeWrite?.(i);
        if (e.kind !== "add") {
          const d = e.delete;
          const ids = [...new Set(d.interfaces)];
          // A redirect's suppresses say so in Deleted links (its new link is the other half).
          const group = `${e.kind === "redirect" ? "r" : "d"}-${stamp}-${i + 1}`;
          const reason = linkDeleteReason(d.from, d.to, ids.length, group);
          for (const target of ids) {
            // A link a person declared on the canvas: the declaration goes, not a suppress of it.
            const decl = await canvasDeclarationOf(root, byId.get(target));
            if (decl) {
              const res = await undeclareLink(root, decl);
              replaced(join(root, ...res.rel.split("/")), i, res);
              // The build names the org pack as one input: a teammate's change to it pending
              // before this run is never confirmed (`pending`).
              inputs.add("org-pack");
              io.out(
                `${said}: withdrew ${decl.value} from ${decl.system}'s declarations in ${res.rel}.`,
              );
              targets.add(target);
              continue;
            }
            const w = await writeDecision(
              root,
              join(catalogDirOf(root), "curated"),
              { action: "suppress", target, value: null },
              { idBase: `${LINK_DELETE_PREFIX}${target}`, reason, by, at },
            );
            if ("problem" in w) throw new Error(`Interface/${target}: ${w.problem}`);
            if ("written" in w) {
              const file = join(root, ...w.written.split("/"));
              files.set(file, { how: "new", wrote: w.bytes, edits: new Set([i]) });
              io.out(`${said}: wrote ${w.written}, the person's suppress of Interface/${target}.`);
            } else io.out(`${said}: ${w.kept} suppresses Interface/${target} already.`);
            targets.add(target);
          }
        }
        if ("pair" in e) {
          // Connect to…'s pairings, exactly its lines in the caller's corrections file.
          const { pairingsOf } = await import("./ui-api-links.js");
          const { appendLines } = await import("./file-lock.js");
          const p = await pairingsOf(root, e.pair, { by, at });
          const lines = p.corrections.map(correctionLine);
          await mkdir(factsDirOf(root), { recursive: true });
          const appended = await appendLines(p.file, lines);
          const x = files.get(p.file);
          if (x?.how === "append") {
            x.lines.push(...lines);
            x.edits.add(i);
          } else
            files.set(p.file, {
              how: "append",
              lines: [...lines],
              edits: new Set([i]),
              ...(appended.before === null ? { created: true as const } : {}),
            });
          inputs.add(p.rel);
          io.out(
            `${said}: wrote ${lines.length} pairing${lines.length === 1 ? "" : "s"} in ${p.rel}, the person's word for ${e.pair.from}'s call${lines.length === 1 ? "" : "s"}.`,
          );
        } else if ("add" in e) {
          const a = e.add;
          const d =
            a.kind === "call"
              ? ({ kind: "call", system: a.system, route: a.route } as const)
              : ({ kind: "topic", system: a.system, topic: a.topic, side: a.side } as const);
          const { systemToCreate } = await import("./ui-api-declared.js");
          const create = systemToCreate(
            await loadOrgPack(orgPackDirOf(root)),
            a.system,
          );
          const res = await declareLink(root, d, { by, at, ...(create ? { create } : {}) });
          replaced(join(root, ...res.rel.split("/")), i, res);
          inputs.add("org-pack");
          // Beta.28.1: a box no System of the profiles was gets one first, said.
          if (res.created)
            io.out(
              `${said}: added the system ${res.created} to ${res.rel} (no profile had it), for the link to be declared on.`,
            );
          io.out(`${said}: declared in ${res.rel}.`);
        }
        outcomes[i]!.state = "saved";
        await mapEditHooks.afterWrite?.(i);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        outcomes[i] = { ...outcomes[i]!, state: "failed", message: why };
        io.err(`${said}: not saved: ${why}`);
        // Every file taken back while it is still as this run left it: a profile put back only
        // if nobody wrote it since (checked as it is written), a new decision removed only if it
        // is as written, a corrections file's own lines removed under its lock (any other line
        // kept). A file changed since is left as it is, and named.
        const { removeCorrectionLines } = await import("./ui-api-links.js");
        const { FileChangedError, writeFileIfUnchanged } = await import("@maycombhq/core");
        const kept = new Set<number>();
        const changedSince: string[] = [];
        for (const [f, x] of files) {
          try {
            if (x.how === "replace") {
              if (x.between) throw new FileChangedError(f);
              await writeFileIfUnchanged(f, x.wrote, x.before);
            } else if (x.how === "append") {
              await removeCorrectionLines(f, x.lines);
              // A file this run made, nothing else in it now: gone, as it was.
              if (x.created && (await readFile(f, "utf8").catch(() => null))?.trim() === "")
                await rm(f, { force: true });
            } else if ((await readFile(f, "utf8").catch(() => null)) === x.wrote)
              await rm(f, { force: true });
            else throw new FileChangedError(f);
          } catch (e2) {
            if (!(e2 instanceof FileChangedError)) throw e2;
            changedSince.push(posix(relative(root, f)));
            for (const k of x.edits) kept.add(k);
          }
        }
        // One outcome per change: the one that failed keeps its own; one before it is taken back,
        // unless a file it wrote changed since (left as it is, and said).
        for (let k = 0; k < i; k++)
          outcomes[k] = kept.has(k)
            ? {
                ...outcomes[k]!,
                state: "saved",
                message: `couldn't be taken back: ${changedSince.join(", ")} changed since`,
              }
            : { ...outcomes[k]!, state: "taken-back" };
        if (kept.has(i))
          outcomes[i] = {
            ...outcomes[i]!,
            message: `${why} (what it wrote first couldn't be taken back: ${changedSince.join(", ")} changed since)`,
          };
        io.err(
          changedSince.length
            ? `Nothing was built. ${changedSince.join(", ")} changed while this ran, so what was written there couldn't be taken back and is left as it is: look at ${changedSince.length === 1 ? "it" : "them"}, then fix change ${i + 1} (or remove it from your changes) and apply again.`
            : `Nothing was built. Every change written before it was taken back, each file as it was; fix change ${i + 1} (or remove it from your changes) and apply again.`,
        );
        return 1;
      }
    }
    io.out(`${n} change${n === 1 ? "" : "s"} saved. Building the catalog once, with all of them.`);
    await mapEditHooks.beforeBuild?.();
    const c = await buildAfterDecisions(root, targets, io, { inputs, pending });
    built = c === 0;
    if (c !== 0)
      io.err(
        "The changes are saved; the catalog is built with them once the build above is confirmed on Set up › Scans › Catalog builds.",
      );
    return c;
  });
  // The lock was held: nothing tried.
  if (outcomes.every((x) => x.state === "not-tried") && code !== 0)
    io.err("Nothing was saved and nothing was built.");
  return { code, edits: outcomes, built };
}

/**
 * The declaration on the canvas (who and when on its line) an Interface is drawn from, if any: a
 * gateway route its system declared it calls (`declared-caller`, by method and path or by the
 * route as served), or a topic a system declared it publishes or listens on. A declaration a
 * person wrote by hand isn't one: the link is suppressed instead, and the file is theirs.
 */
export async function canvasDeclarationOf(
  root: string,
  r: CatalogRecord | undefined,
): Promise<{ kind: "topic" | "call"; system: string; value: string } | undefined> {
  if (r?.kind !== "Interface") return undefined;
  if (!r.evidence.some((e) => e.source === "manual")) return undefined;
  const { declaredOf } = await import("@maycombhq/core");
  const norm = (p: string) =>
    p
      .replace(/\{[^}]*\}/g, "{}")
      .replace(/\/+$/, "")
      .toLowerCase();
  const flags = (r as { flags?: string[] }).flags ?? [];
  if (flags.includes("declared-caller")) {
    const list = (await declaredOf(root, r.from)).list.filter((x) => x.kind === "call" && x.by);
    const route = `${(r.method ?? "").toUpperCase()} ${norm(r.normalizedPath)}`;
    const these = list.filter((x) => {
      const [m, ...rest] = x.value.trim().split(/\s+/);
      return `${(m ?? "").toUpperCase()} ${norm(rest.join(" "))}` === route;
    });
    return these.length === 1
      ? { kind: "call", system: r.from, value: these[0]!.value }
      : undefined;
  }
  for (const system of [r.from, r.to]) {
    const list = (await declaredOf(root, system)).list.filter((x) => x.kind === "topic" && x.by);
    const these = list.filter((x) => x.value === r.normalizedPath);
    if (these.length === 1) return { kind: "topic", system, value: these[0]!.value };
  }
  return undefined;
}
