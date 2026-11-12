import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import {
  acquireLock,
  catalogDirOf,
  cmpText,
  deserializeRecord,
  LockHeldError,
  parseRecord,
  recordPath,
  serializeRecord,
  writeFileAtomic,
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
  const code = o.check ? await run() : await locked(root, command, io, run);
  return code;
}

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
  if (!o.yes) {
    if (o.json) io.out(JSON.stringify({ copies: list, plan }, null, 2));
    else {
      io.out(`The last ${list.length} builds kept here, newest first:`);
      list.forEach((c, i) => io.out(`  ${i + 1}: ${c.command} (${c.at}, ${c.files.length} files)`));
      io.out(
        `atticus catalog undo${o.n !== undefined ? ` ${o.n}` : ""} --yes would put back ${plan.files.length} ${plan.files.length === 1 ? "file" : "files"} as they were before ${plan.copies.length === 1 ? `the latest build (${plan.copies[0]!.command})` : `the ${plan.copies.length} latest builds`}:`,
      );
      for (const f of plan.files.slice(0, 30))
        io.out(`  ${f.to === "absent" ? "remove" : "restore"} ${f.path}`);
      if (plan.files.length > 30) io.out(`  and ${plan.files.length - 30} more`);
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
      const { sha256Of } = await import("@maycombhq/scanner");
      if (text === undefined || sha256Of(text.replace(/\r\n?/g, "\n")) !== f.sha256)
        bad.push(f.path);
    }
    if (o.json)
      io.out(JSON.stringify({ restored: r.restored, undo: r.undo, handEdits: bad }, null, 2));
    else {
      io.out(
        `Put back ${r.restored.length} ${r.restored.length === 1 ? "file" : "files"} as ${r.restored.length === 1 ? "it was" : "they were"} before ${plan.copies.map((c) => c.command).join(", then ")}.`,
      );
      if (r.undo !== undefined)
        io.out(`This undo can be undone too: atticus catalog undo --yes (copy ${r.undo}).`);
      if (plan.copies.some((c) => c.command.startsWith("atticus upgrade"))) io.out(UPGRADE_UNDONE);
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
  const genRel = posix(relative(root, join(catalogDirOf(root), "generated")));
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
    // read against the record as its slot last held it, and the assert waits, orphaned, until
    // the record returns.
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
    const derived = derivedNow ?? fromSlot();
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
      const placed = await decisionFor(
        curatedDir,
        slug(`cd-edit-${String(p.decision.action)}-${String(p.decision.target)}`),
        p.decision,
        at,
      );
      if ("keep" in placed) {
        kept.push({
          path: p.path,
          decision: `${posix(relative(root, curatedDir))}/curateddecision/${placed.keep}`,
        });
        curated.push(p.path);
        continue;
      }
      const record = parseRecord({
        kind: "CuratedDecision",
        id: placed.id,
        schemaVersion: 2,
        status: "current",
        confidence: "asserted",
        ...p.decision,
        reason: `A hand edit to ${p.path}, made curated (atticus catalog edits --curate).`,
        by,
        at: placed.at,
      });
      if (!record.ok) {
        left.push({ path: p.path, why: record.issues.map((i) => i.message).join("; ") });
        continue;
      }
      const full = join(curatedDir, ...recordPath(record.record as CatalogRecord).split("/"));
      await mkdir(dirname(full), { recursive: true });
      await writeFileAtomic(full, serializeRecord(record.record as CatalogRecord));
      written.push(posix(relative(root, full)));
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
