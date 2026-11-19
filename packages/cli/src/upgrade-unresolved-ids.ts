import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { isScalar, parse, parseDocument, Scalar, visit, type Document } from "yaml";
import {
  acquireLock,
  catalogDirOf,
  changesDirOf,
  factIdPart,
  factsDirOf,
  listQuestions,
  loadOrgPack,
  newerThan,
  orgPackDirOf,
  parseRecord,
  Question,
  questionFileOf,
  recordPath,
  serializeRecord,
  specsDirOf,
  unresolvedIdsNow,
  type CatalogRecord,
} from "@maycombhq/core";

/**
 * ADR 0124 addendum E-ids (the owner, 2026-11-19): the upgrade step that names the loose ends of a
 * catalog an earlier build wrote (`unresolved.<fact id>`) again with their repo
 * (`unresolved.<repo>.<fact id>`), as moves, and carries every id that cites one to the new id.
 *
 * Where record ids are kept, and what this step does with each:
 * - `catalog/generated/`: the build's. The step builds once, under the scan's lock, through the
 *   guards; the build names the loose ends again, and the guard lists each as renamed (counted
 *   toward no removal limit). Its undo copy (`atticus catalog undo`) holds every file it wrote.
 * - `catalog/curated/`: a decision's `target` (a suppress, an assert, an alias), and a curated
 *   record's own id. A loose end two repos shared under one id is carried to each repo's, the
 *   decision copied (`<id>-<repo>`), so what a person took off the map stays off.
 * - A change's YAML files (`change.yaml`'s `touches`, a flow delta's target), the questions, the
 *   specs' flows (`specs/<repo>/`) and the cross-check dismissals (`facts/<repo>.crosscheck.yaml`):
 *   any value that is an old id, in a list each new one, else the one of the file's own repo
 *   where it has one. An archived change, and Markdown (a person's words), are left as written.
 * - Kept as they are: the facts and their corrections (pairings name facts by fact id, which
 *   didn't change), the index (rebuilt from the catalog), and a legacy repo's records (kept as
 *   they were adopted, ADR 0195 point 6: they are named again when the repo is read from facts).
 *
 * Written as the build's inputs, in its one write (ADR 0195 point 2), so a refusal writes nothing
 * and `atticus catalog undo` puts every file back.
 */

export const UNRESOLVED_IDS_STEP = "unresolved-ids-repo";

/** The first build whose loose ends carry their repo (scanner's `UNRESOLVED_IDS_BUILD`). */
const FIRST_BUILD = "2.0.0-beta.30";

const posix = (p: string) => p.split(sep).join("/");
const PREFIX = "unresolved.";
/** A cross-check item's key, `<Kind>|<id>`. */
const KEYED = "Unresolved|";

async function readText(path: string): Promise<string | undefined> {
  return readFile(path, "utf8").catch(() => undefined);
}

async function walk(dir: string, keep: (name: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p, keep)));
    else if (keep(e.name)) out.push(p);
  }
  return out.sort();
}

const yamlFile = (n: string) => /\.ya?ml$/.test(n);

/** The generated catalog's loose ends, as records, by file. */
async function generatedLooseEnds(root: string): Promise<{ path: string; r: CatalogRecord }[]> {
  const dir = join(catalogDirOf(root), "generated", "unresolved");
  const out: { path: string; r: CatalogRecord }[] = [];
  for (const p of await walk(dir, yamlFile)) {
    try {
      const x = parseRecord(parse((await readText(p)) ?? ""));
      if (x.ok) out.push({ path: p, r: x.record });
    } catch {
      // a file that isn't YAML is the build's guard's to say
    }
  }
  return out;
}

/** Whether the last build is one before the repo was in the ids (`build.json`'s buildVersion). */
async function builtBefore(root: string): Promise<boolean | undefined> {
  const text = await readText(join(catalogDirOf(root), "sources", "build.json"));
  if (text === undefined) return undefined;
  try {
    const v = (JSON.parse(text) as { buildVersion?: unknown }).buildVersion;
    return typeof v !== "string" || newerThan(FIRST_BUILD, v);
  } catch {
    return undefined;
  }
}

/** An id of the new form, `unresolved.<repo>.<rest>`, as the old one `unresolved.<rest>`. */
const oldFormOf = (id: string): string | undefined => {
  if (!id.startsWith(PREFIX)) return undefined;
  const rest = id.slice(PREFIX.length);
  const dot = rest.indexOf(".");
  return dot > 0 ? `${PREFIX}${rest.slice(dot + 1)}` : undefined;
};
/** The repo part of a new id (`factIdPart` of the repo). */
const repoPartOf = (id: string) => id.slice(PREFIX.length).split(".")[0]!;

/** The input files a step carries ids in, with the repo each belongs to, where it has one. */
async function inputFiles(
  root: string,
): Promise<{ path: string; repo?: string; question?: true }[]> {
  const out: { path: string; repo?: string; question?: true }[] = [];
  // A change's YAML files (its change.yaml's `touches`, its flow deltas' targets), not the
  // archive: an archived change is history. Its Markdown is a person's words, left as written.
  const changes = changesDirOf(root);
  for (const p of await walk(changes, yamlFile))
    if (!posix(relative(changes, p)).startsWith("archive/")) out.push({ path: p });
  const specs = specsDirOf(root);
  for (const p of await walk(specs, yamlFile)) {
    const repo = posix(relative(specs, p)).split("/")[0];
    out.push({ path: p, ...(repo && !repo.endsWith(".yaml") ? { repo } : {}) });
  }
  const facts = factsDirOf(root);
  for (const p of await walk(facts, (n) => n.endsWith(".crosscheck.yaml")))
    out.push({ path: p, repo: posix(relative(facts, p)).replace(/\.crosscheck\.yaml$/, "") });
  const qs = (await listQuestions(root).catch(() => ({ questions: [] as Question[] }))).questions;
  for (const q of qs) out.push({ path: questionFileOf(root, q.id), repo: q.repo, question: true });
  return out;
}

/** Each string scalar of a YAML document, in order (seq items included). */
function scalars(doc: Document): string[] {
  const out: string[] = [];
  visit(doc, {
    Scalar(_, node) {
      if (typeof node.value === "string") out.push(node.value);
    },
  });
  return out;
}

/** Whether a scalar names a loose end by an id that may be of the old form. */
const mayBeOld = (
  v: string,
  oldIds: ReadonlySet<string>,
  any: boolean,
  now: ReadonlySet<string>,
) => {
  const id = v.startsWith(KEYED) ? v.slice(KEYED.length) : v;
  if (!id.startsWith(PREFIX) || now.has(id)) return false;
  return oldIds.has(id) || (any && /^unresolved\.[a-z0-9_-]+$/.test(id));
};

/**
 * The files the step would change: the generated loose ends of an earlier build's form, with
 * build.json, and every input file naming one (or, while the catalog is an earlier build's, an id
 * of the old form a decision took off the map). Reads files only: no build.
 */
export async function unresolvedIdsPending(root: string): Promise<string[]> {
  const before = await builtBefore(root);
  if (before === undefined) return [];
  const gen = await generatedLooseEnds(root);
  const renamed = before
    ? gen.filter((g) => {
        const ids = unresolvedIdsNow(g.r);
        return ids.length > 0 && !(ids.length === 1 && ids[0] === g.r.id);
      })
    : [];
  // The ids the catalog keeps: every loose end on disk but those the step names again.
  const now = new Set(gen.map((g) => g.r.id));
  for (const g of renamed) now.delete(g.r.id);
  const oldIds = new Set<string>(renamed.map((g) => g.r.id));
  for (const g of gen) {
    const o = oldFormOf(g.r.id);
    if (o && unresolvedIdsNow(g.r)[0] === g.r.id) oldIds.add(o);
  }
  for (const id of now) oldIds.delete(id);
  const files: string[] = renamed.map((g) => posix(relative(root, g.path)));
  if (renamed.length) files.push("catalog/sources/build.json");
  const curatedDir = join(catalogDirOf(root), "curated");
  for (const p of await walk(curatedDir, yamlFile)) {
    const doc = parseDocument((await readText(p)) ?? "");
    if (scalars(doc).some((v) => mayBeOld(v, oldIds, before, now)))
      files.push(posix(relative(root, p)));
  }
  for (const f of await inputFiles(root)) {
    const text = await readText(f.path);
    if (text === undefined || !text.includes(PREFIX)) continue;
    if (scalars(parseDocument(text)).some((v) => mayBeOld(v, oldIds, before, now)))
      files.push(posix(relative(root, f.path)));
  }
  return [...new Set(files)].sort();
}

/** Refused by the build's guards: nothing of the step was written. */
export class UnresolvedIdsRefused extends Error {}

/** A YAML file's text with each old id carried; undefined when nothing in it changed. */
function carriedText(
  text: string,
  map: ReadonlyMap<string, readonly string[]>,
  repo: string | undefined,
): string | undefined {
  const doc = parseDocument(text);
  let changed = false;
  const pick = (v: string): string[] | undefined => {
    const keyed = v.startsWith(KEYED);
    const news = map.get(keyed ? v.slice(KEYED.length) : v);
    if (!news?.length) return undefined;
    const own = repo ? news.filter((n) => repoPartOf(n) === factIdPart(repo)) : [];
    return (own.length ? own : news).map((n) => (keyed ? `${KEYED}${n}` : n));
  };
  visit(doc, {
    Seq(_, seq) {
      const items = seq.items.flatMap((x) => {
        if (!isScalar(x) || typeof x.value !== "string") return [x];
        const news = pick(x.value);
        if (!news) return [x];
        changed = true;
        return news.map((n) => new Scalar(n));
      });
      seq.items = items;
    },
    Scalar(key, node) {
      if (key === "key" || typeof node.value !== "string") return;
      const news = pick(node.value);
      if (!news) return;
      changed = true;
      node.value = news[0];
    },
  });
  return changed ? doc.toString() : undefined;
}

/**
 * Apply the step: build once (under the scan's lock, through the guards) with the inputs carried,
 * and write it all in the build's one write. Returns the files written, relative to the root.
 */
export async function unresolvedIdsApply(
  root: string,
  o: { allowRemovals?: number } = {},
): Promise<string[]> {
  const scanner = await import("@maycombhq/scanner");
  const before = await builtBefore(root);
  if (before === undefined) return [];
  const lock = await acquireLock(root, "scan", "atticus upgrade");
  try {
    scanner.forgetKeptReads();
    const op = await loadOrgPack(orgPackDirOf(root));
    const curatedDir = scanner.curatedDirOf(root, op);
    // ---- what each old id is now: the loose ends a build makes with no decision applied
    const raw = await scanner.buildCatalog(
      await scanner.loadBuildInputs(root, { op, curated: [] }),
    );
    const rawIds = new Set(raw.records.filter((r) => r.kind === "Unresolved").map((r) => r.id));
    const map = new Map<string, string[]>();
    for (const r of raw.records) {
      if (r.kind !== "Unresolved") continue;
      const ids = unresolvedIdsNow(r);
      if (ids.length !== 1 || ids[0] !== r.id) continue;
      const o0 = oldFormOf(r.id);
      if (o0 && !rawIds.has(o0)) map.set(o0, [...(map.get(o0) ?? []), r.id].sort());
    }
    // The record the last build wrote under an old id cites the repos it was: only those.
    const gen = await generatedLooseEnds(root);
    for (const g of gen) {
      const news = map.get(g.r.id);
      if (!news) continue;
      const mine = unresolvedIdsNow(g.r).filter((id) => news.includes(id));
      if (mine.length) map.set(g.r.id, mine);
    }
    const oldOnDisk = before && gen.some((g) => map.has(g.r.id));

    // ---- the inputs, carried in memory
    const writes: { path: string; text: string | null; input: true }[] = [];
    const curatedNow = await scanner.readCatalog(curatedDir, { cacheRoot: root, fresh: true });
    const curatedNext: CatalogRecord[] = [];
    for (const r of curatedNow.records) {
      const x = r as CatalogRecord & { target?: string };
      const news =
        x.kind === "CuratedDecision" && x.target
          ? map.get(x.target)
          : x.kind === "Unresolved"
            ? map.get(x.id)
            : undefined;
      if (!news?.length) {
        curatedNext.push(r);
        continue;
      }
      const from = join(curatedDir, ...recordPath(r).split("/"));
      for (const [k, n] of news.entries()) {
        // A curated loose end takes the new id; a decision keeps its id for the first, and each
        // other repo's copy is `<id>-<repo>`.
        const next = parseRecord(
          x.kind === "Unresolved"
            ? { ...x, id: n }
            : { ...x, id: k === 0 ? x.id : `${x.id}-${repoPartOf(n)}`, target: n },
        );
        if (!next.ok) continue;
        curatedNext.push(next.record);
        const path = join(curatedDir, ...recordPath(next.record).split("/"));
        writes.push({ path, text: serializeRecord(next.record), input: true });
      }
      // A curated record renamed leaves its old file.
      if (x.kind === "Unresolved") writes.push({ path: from, text: null, input: true });
    }
    let questions: Question[] | undefined;
    for (const f of await inputFiles(root)) {
      const text = await readText(f.path);
      if (text === undefined || !text.includes(PREFIX)) continue;
      const next = carriedText(text, map, f.repo);
      if (next === undefined) continue;
      writes.push({ path: f.path, text: next, input: true });
      // A question is a build input (its answer joins): the build reads them as they will be.
      if (f.question) {
        const q = Question.safeParse(parse(next));
        if (q.success) {
          questions ??= (await listQuestions(root)).questions;
          questions = questions.map((x) => (x.id === q.data.id ? q.data : x));
        }
      }
    }
    if (!oldOnDisk && !writes.length) return [];

    // ---- one build from all of it, guarded, then one write
    const pending = new Map<string, string | null>(writes.map((w) => [w.path, w.text]));
    const build = await scanner.buildCatalog(
      await scanner.loadBuildInputs(root, {
        op,
        curated: curatedNext,
        pending,
        ...(questions ? { questions } : {}),
      }),
    );
    const written = await scanner.buildAndWrite(root, {
      command: "atticus upgrade",
      build,
      slots: writes,
      ...(o.allowRemovals !== undefined ? { allowRemovals: o.allowRemovals } : {}),
    });
    scanner.forgetCatalogs();
    if (written.guard.refused)
      throw new UnresolvedIdsRefused(
        [
          ...scanner.buildLines(root, written),
          `Nothing of this step was written. ${
            written.guard.refused.allowRemovals !== undefined
              ? `Run atticus upgrade --allow-removals ${written.guard.refused.allowRemovals} to confirm the removals it lists.`
              : "Run atticus upgrade again once it is put right."
          }`,
        ].join("\n"),
      );
    return [
      ...writes.map((w) => posix(relative(root, w.path))),
      "catalog/generated",
      "catalog/sources/build.json",
    ];
  } finally {
    await lock.release();
  }
}
