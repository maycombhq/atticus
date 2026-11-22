import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { isScalar, parse, parseDocument, Scalar, visit } from "yaml";
import {
  acquireLock,
  askedGapQuestionId,
  catalogDirOf,
  factIdPart,
  Finding,
  listQuestions,
  loadOrgPack,
  mayBeOldLooseEndId,
  newerThan,
  oldIdOfLooseEnd,
  orgPackDirOf,
  parseRecord,
  Question,
  questionFileOf,
  questionFileText,
  recordPath,
  unresolvedIdOf,
  unresolvedIdsNow,
  type CatalogRecord,
} from "@maycombhq/core";
import { loadRepos } from "@maycombhq/workspace";

/**
 * ADR 0124 addendum E-ids (the owner, 2026-11-19): the upgrade step that names the loose ends of a
 * catalog an earlier build wrote (`unresolved.<fact id>`) again with their repo
 * (`unresolved.<repo>.<fact id>`), as moves, and carries every id that cites one to the new id.
 *
 * One plan (`planOf`) gives both what the step lists and what it writes, so every file it writes
 * is in the upgrade's backup; the write refuses a file the list didn't name (the review of
 * 93ddfc5e). An old id goes to one id, decided only by committed files (the owner, 2026-11-22):
 * the repo the old record in catalog/generated cited (it is still there: a beta.30 build refuses
 * to rename a loose end an input names, `oldIdsNamedOf`), else, with no record (a suppressed
 * loose end), the repo beta.28.5's merge cited, the first by id. Another repo's loose end of the
 * same fact id appears as a new loose end: nobody saw it, so no decision of the old one is its.
 * A carry never goes over a file there, or onto an id another decision already targets: the
 * step refuses.
 *
 * Where record ids are kept, and what this step does with each:
 * - `catalog/generated/`: the build's. The step builds once, under the scan's lock, through the
 *   guards; the guard lists each loose end as renamed (counted toward no removal limit). Its undo
 *   copy holds every file it wrote, there and in the inputs: `atticus catalog undo` of it puts
 *   back both (ADR 0195's addendum of 2026-11-21, an exception to point 7 for this step only).
 * - `catalog/curated/`: a decision's `target`, and a curated loose end's own id (its file moved,
 *   never over another's).
 * - A change's YAML files (`change.yaml`'s `touches`, a flow delta's target, a review finding's
 *   locator and evidence), the questions, the specs' flows (`specs/<repo>/`) and the cross-check
 *   dismissals (`facts/<repo>.crosscheck.yaml`): any value that is an old id. A knowledge gap's
 *   owner question, whose id is made from the finding's record (`askedGapQuestionId`), is
 *   re-keyed with it, so its answer still closes the gap. An archived change, and Markdown (a
 *   person's words), are left as written.
 * - Kept as they are: the facts and their corrections (pairings name facts by fact id, which
 *   didn't change), the index (rebuilt from the catalog), and a legacy repo's records (kept as
 *   they were adopted, ADR 0195 point 6: they are named again when the repo is read from facts).
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
const recordOf = (text: string | undefined): CatalogRecord | undefined => {
  try {
    const x = parseRecord(parse(text ?? ""));
    return x.ok ? x.record : undefined;
  } catch {
    return undefined;
  }
};
/** A loose end of the form before beta.30: one `unresolvedIdsNow` names otherwise. */
const isOld = (r: CatalogRecord) => {
  const ids = unresolvedIdsNow(r);
  return ids.length > 0 && !(ids.length === 1 && ids[0] === r.id);
};

/** The generated catalog's loose ends, as records, by file. */
async function generatedLooseEnds(root: string): Promise<{ path: string; r: CatalogRecord }[]> {
  const out: { path: string; r: CatalogRecord }[] = [];
  for (const p of await walk(join(catalogDirOf(root), "generated", "unresolved"), yamlFile)) {
    const r = recordOf(await readText(p));
    if (r) out.push({ path: p, r });
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

/** The repo part of a new id (`factIdPart` of the repo). */
const repoPartOf = (id: string) => id.slice(PREFIX.length).split(".")[0]!;

/** Each string scalar of a YAML document, in order, and the id a value names (the scanner's). */
async function scalarsOf(text: string): Promise<string[]> {
  const { stringScalars } = await import("@maycombhq/scanner");
  return stringScalars(parseDocument(text));
}
const idOfValue = (v: string) => (v.startsWith(KEYED) ? v.slice(KEYED.length) : v);

/** A YAML file's text with each old id carried; undefined when nothing in it changed. */
function carriedText(text: string, map: ReadonlyMap<string, string>): string | undefined {
  const doc = parseDocument(text);
  let changed = false;
  const pick = (v: string): string | undefined => {
    const keyed = v.startsWith(KEYED);
    const next = map.get(idOfValue(v));
    return next === undefined ? undefined : keyed ? `${KEYED}${next}` : next;
  };
  visit(doc, {
    Seq(_, seq) {
      seq.items = seq.items.map((x) => {
        if (!isScalar(x) || typeof x.value !== "string") return x;
        const next = pick(x.value);
        if (next === undefined) return x;
        changed = true;
        const s = new Scalar(next);
        s.type = x.type;
        return s;
      });
    },
    Scalar(key, node) {
      if (key === "key" || typeof node.value !== "string") return;
      const next = pick(node.value);
      if (next === undefined) return;
      changed = true;
      node.value = next;
    },
  });
  return changed ? doc.toString() : undefined;
}

/** Refused: nothing of the step was written. */
export class UnresolvedIdsRefused extends Error {}

interface Plan {
  /** Every input file the step writes (null: removed), by absolute path. */
  writes: { path: string; text: string | null; input: true }[];
  /** The files it lists: those, the loose ends on disk it names again, build.json. */
  files: string[];
  /** Whether it has a build to run (a catalog of an earlier build's, or an input carried). */
  builds: boolean;
  curatedNext?: CatalogRecord[];
  questions?: Question[];
  op?: Awaited<ReturnType<typeof loadOrgPack>>;
  /**
   * Why the step can't run as it stands (a file or a decision a carry would go over): listed as
   * pending, so `atticus upgrade` says it, and refused by the write before anything is written.
   */
  refused?: string;
}

/** Whether a scalar may name a loose end by an id of the old form (no build to tell by). */
function mayBeOld(v: string, now: ReadonlySet<string>, repoParts: ReadonlySet<string>): boolean {
  const id = idOfValue(v);
  return id.startsWith(PREFIX) && !now.has(id) && mayBeOldLooseEndId(id, repoParts);
}

/**
 * What the step lists and writes, from one build with no decision applied (what each old id is
 * now). Undefined: no catalog built from slots (the slots' adoption builds it).
 */
async function planOf(root: string): Promise<Plan | undefined> {
  const before = await builtBefore(root);
  if (before === undefined) return undefined;
  const scanner = await import("@maycombhq/scanner");
  const op = await loadOrgPack(orgPackDirOf(root));
  const curatedDir = scanner.curatedDirOf(root, op);
  const gen = await generatedLooseEnds(root);
  const oldGen = gen.filter((g) => isOld(g.r));
  const now = new Set(gen.filter((g) => !oldGen.includes(g)).map((g) => g.r.id));
  const repoParts = new Set((await loadRepos(root).catch(() => [])).map((r) => factIdPart(r.id)));
  const inputs = await scanner.looseEndInputFiles(root, curatedDir);
  const texts = new Map<string, string>();
  for (const f of inputs) {
    const t = await readText(f.path);
    if (t !== undefined && t.includes(PREFIX)) texts.set(f.path, t);
  }
  let named = false;
  for (const t of texts.values())
    if ((await scalarsOf(t)).some((v) => mayBeOld(v, now, repoParts))) {
      named = true;
      break;
    }
  if (!(before && oldGen.length) && !named) return { writes: [], files: [], builds: false };

  // ---- what each old id is now: the loose ends a build makes with no decision applied
  scanner.forgetKeptReads();
  const raw = await scanner.buildCatalog(await scanner.loadBuildInputs(root, { op, curated: [] }));
  const rawIds = new Set(raw.records.filter((r) => r.kind === "Unresolved").map((r) => r.id));
  const candidates = new Map<string, { id: string; repo: string }[]>();
  for (const r of raw.records) {
    const o = oldIdOfLooseEnd(r);
    if (!o || rawIds.has(o)) continue;
    const repo = r.evidence.find((e) => e.repo && factIdPart(e.repo) === repoPartOf(r.id))?.repo;
    if (repo) candidates.set(o, [...(candidates.get(o) ?? []), { id: r.id, repo }]);
  }
  // The loose ends of the old form on disk that the step's build names again: every one of a
  // catalog an earlier build wrote, else those a build would rename now (a legacy repo's, once it
  // is read from facts).
  const renamedGen = oldGen.filter((g) => before || !rawIds.has(g.r.id));
  // The owner, 2026-11-22: the repos the old record of each old id cited, from catalog/generated
  // only, committed and the same on every machine. It is there: a beta.30 build that would
  // rename a loose end an input names refuses (`oldIdsNamedOf`), writing nothing.
  const cited = new Map<string, string[]>();
  for (const g of oldGen)
    if (!cited.has(g.r.id))
      cited.set(g.r.id, [...new Set(g.r.evidence.flatMap((e) => (e.repo ? [e.repo] : [])))].sort());
  const map = new Map<string, string>();
  for (const [o, cs] of candidates) {
    const sorted = [...cs].sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0));
    const was = cited.get(o);
    // The repo the old record cited (a record that cited a repo with no such loose end now goes
    // to the id that repo gives it, kept until its loose end is back); with no record, the one
    // beta.28.5's merge cited, the first by id.
    const to = was?.length
      ? (sorted.find((c) => was.includes(c.repo))?.id ??
        unresolvedIdOf(was[0]!, o.slice(PREFIX.length)))
      : sorted[0]?.id;
    if (to) map.set(o, to);
  }

  // ---- the inputs, carried in memory
  let refused: string | undefined;
  const refuse = (why: string) => {
    refused ??= why;
  };
  const writes: Plan["writes"] = [];
  const write = (path: string, text: string | null) => {
    const at = writes.findIndex((w) => w.path === path);
    if (at >= 0) writes[at] = { path, text, input: true };
    else writes.push({ path, text, input: true });
  };
  const carried = new Map<string, string>();
  for (const [path, t] of texts) {
    const next = carriedText(t, map);
    if (next !== undefined) carried.set(path, next);
  }
  const curatedNow = await scanner.readCatalog(curatedDir, { cacheRoot: root, fresh: true });
  const curatedNext: CatalogRecord[] = [];
  for (const r of curatedNow.records) {
    const from = join(curatedDir, ...recordPath(r).split("/"));
    const next = carried.has(from) ? recordOf(carried.get(from)) : undefined;
    if (!next) {
      curatedNext.push(r);
      continue;
    }
    curatedNext.push(next);
    // A decision carried onto an id a person's decision already names (one made on beta.30):
    // applied in time order, one would decide over the other unsaid. The person picks.
    if (
      r.kind === "CuratedDecision" &&
      next.kind === "CuratedDecision" &&
      next.target !== r.target
    ) {
      const there = curatedNow.records.find(
        (d) =>
          d.kind === "CuratedDecision" &&
          d.status === "current" &&
          d.id !== r.id &&
          d.target === next.target,
      );
      if (there)
        refuse(
          `Your change ${r.id} targets ${r.target}, which goes to ${next.target}, but your change ${there.id} targets ${next.target} already (${posix(relative(root, join(curatedDir, ...recordPath(there).split("/"))))}): carried, one would override the other. Nothing of this step was written: keep the one you want (remove the other's file), then run atticus upgrade again.`,
        );
    }
    const to = join(curatedDir, ...recordPath(next).split("/"));
    if (to !== from) {
      // A curated loose end renamed: its file moves, never over another's.
      if (existsSync(to)) {
        refuse(
          `${posix(relative(root, to))} is there already, so your change ${posix(relative(root, from))} can't move to it under its new id. Nothing of this step was written: move or merge one of them, then run atticus upgrade again.`,
        );
        // Listed (so the step is pending and says why), never written: the write refuses.
        write(from, carried.get(from)!);
        continue;
      }
      write(to, carried.get(from)!);
      write(from, null);
    } else write(from, carried.get(from)!);
  }
  let questions: Question[] | undefined;
  const allQuestions = async () =>
    (questions ??= (await listQuestions(root).catch(() => ({ questions: [] }))).questions);
  for (const f of inputs) {
    if (f.curated || !carried.has(f.path)) continue;
    write(f.path, carried.get(f.path)!);
    if (f.question) {
      const q = Question.safeParse(parse(carried.get(f.path)!));
      if (q.success)
        questions = (await allQuestions()).map((x) => (x.id === q.data.id ? q.data : x));
    }
  }
  // A knowledge gap's owner question, re-keyed with its finding's record, and the finding's
  // `answered` that names it.
  for (const [path, next] of carried) {
    let was: Finding | undefined;
    let now2: Finding | undefined;
    try {
      const a = Finding.safeParse(parse(texts.get(path)!));
      const b = Finding.safeParse(parse(next));
      if (a.success && b.success) [was, now2] = [a.data, b.data];
    } catch {
      continue;
    }
    if (!was || !now2) continue;
    const oldQ = askedGapQuestionId(was.change, was);
    const newQ = askedGapQuestionId(now2.change, now2);
    if (oldQ === newQ) continue;
    const qs = await allQuestions();
    const q = qs.find((x) => x.id === oldQ);
    if (q) {
      if (qs.some((x) => x.id === newQ) || existsSync(questionFileOf(root, newQ))) {
        refuse(
          `The owner question ${newQ} is there already, so ${oldQ} can't be re-keyed to it (knowledge gap ${was.id} of ${was.change}). Nothing of this step was written: remove the one that is no longer asked, then run atticus upgrade again.`,
        );
        write(path, next);
        continue;
      }
      const moved = Question.parse({ ...q, id: newQ });
      write(questionFileOf(root, newQ), questionFileText(moved));
      write(questionFileOf(root, oldQ), null);
      questions = qs.map((x) => (x.id === oldQ ? moved : x));
    }
    if (now2.answered?.question === oldQ) {
      const doc = parseDocument(next);
      doc.setIn(["answered", "question"], newQ);
      write(path, doc.toString());
    }
  }
  // Pending (the owner, 2026-11-22): a catalog an earlier build wrote, or an input that names an
  // old id a build would rename. A loose end no input names a normal build renames as now.
  const builds = (before && renamedGen.length > 0) || writes.length > 0 || !!refused;
  if (!builds) return { writes: [], files: [], builds: false };
  const files = [
    ...writes.map((w) => posix(relative(root, w.path))),
    ...renamedGen.map((g) => posix(relative(root, g.path))),
    ...(renamedGen.length ? ["catalog/sources/build.json"] : []),
  ];
  return {
    writes,
    files: [...new Set(files)].sort(),
    builds,
    curatedNext,
    ...(questions ? { questions } : {}),
    op,
    ...(refused ? { refused } : {}),
  };
}

/**
 * What the dry run of the adoption into source slots says of this step (a metarepo from before
 * slots, beta.26's): the loose ends of the old form it adopts as they are (ADR 0195 point 6) and
 * the decisions that name one, which this step carries only once a repo is read from facts; and
 * that which repo each goes to can't be known before. Undefined when there are none.
 */
export async function legacyLooseEndsWords(root: string): Promise<string | undefined> {
  const records = (await generatedLooseEnds(root)).filter((g) => isOld(g.r)).length;
  const repoParts = new Set((await loadRepos(root).catch(() => [])).map((r) => factIdPart(r.id)));
  const scanner = await import("@maycombhq/scanner");
  const curatedDir = scanner.curatedDirOf(root, await loadOrgPack(orgPackDirOf(root)));
  let decisions = 0;
  for (const p of await walk(curatedDir, yamlFile)) {
    const r = recordOf(await readText(p));
    if (
      r?.kind === "CuratedDecision" &&
      r.status === "current" &&
      mayBeOldLooseEndId(r.target, repoParts)
    )
      decisions++;
  }
  if (!records && !decisions) return undefined;
  const ends = `${records} loose end${records === 1 ? " has" : "s have"} an id from before beta.30 (unresolved.<fact id>)`;
  const named = `${decisions} of your changes name${decisions === 1 ? "s" : ""} one`;
  const what =
    records && decisions
      ? `${ends}, and ${named}`
      : records
        ? ends
        : `${named.replace(/ one$/, " a loose end by an id from before beta.30 (unresolved.<fact id>)")}`;
  return `${what}. The upgrade keeps them, as it keeps every record it moves into stored reads. Once a repo's facts are applied (atticus verify <repo> --write), a build that would name a loose end your changes name with its repo waits for atticus upgrade, which renames it and carries your changes in one write. Which repo each id goes to can't be known before then.`;
}

/** The files the step would change (what `unresolvedIdsApply` writes, and only those). */
export async function unresolvedIdsPending(root: string): Promise<string[]> {
  return (await planOf(root))?.files ?? [];
}

/**
 * Apply the step: the plan again, under the scan's lock, refused when it would write a file the
 * upgrade didn't list (`listed`: so it is in the backup); then one build through the guards, in
 * the build's one write. Returns the files written, relative to the root.
 */
export async function unresolvedIdsApply(
  root: string,
  o: { allowRemovals?: number; listed?: readonly string[] } = {},
): Promise<string[]> {
  const scanner = await import("@maycombhq/scanner");
  const lock = await acquireLock(root, "scan", "atticus upgrade");
  try {
    const plan = await planOf(root);
    if (plan?.refused) throw new UnresolvedIdsRefused(plan.refused);
    if (!plan?.builds) return [];
    if (o.listed) {
      const listed = new Set(o.listed);
      const not = plan.writes
        .map((w) => posix(relative(root, w.path)))
        .filter((f) => !listed.has(f));
      if (not.length)
        throw new UnresolvedIdsRefused(
          `${not.join(", ")} would be written, but wasn't listed (and backed up) by this upgrade: another command wrote meanwhile. Nothing of this step was written: run atticus upgrade again to list it.`,
        );
    }
    const pending = new Map<string, string | null>(plan.writes.map((w) => [w.path, w.text]));
    const build = await scanner.buildCatalog(
      await scanner.loadBuildInputs(root, {
        ...(plan.op ? { op: plan.op } : {}),
        ...(plan.curatedNext ? { curated: plan.curatedNext } : {}),
        pending,
        ...(plan.questions ? { questions: plan.questions } : {}),
      }),
    );
    const written = await scanner.buildAndWrite(root, {
      command: scanner.UNRESOLVED_IDS_COMMAND,
      build,
      slots: plan.writes,
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
    return [...plan.files, "catalog/generated"];
  } finally {
    await lock.release();
  }
}
