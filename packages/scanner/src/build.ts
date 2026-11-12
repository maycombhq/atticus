import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { featuresForScan } from "@maycombhq/features";
import { glossaryForScan } from "@maycombhq/glossary";
import {
  applyCurated,
  applyLinkEvidence,
  applySharedMaps,
  catalogDirOf,
  cmpText,
  evidenceDirOf,
  evidenceRelOf,
  FACTS_SCHEMA_VERSION,
  factsDirOf,
  factsRelOf,
  joinSharedMaps,
  keptFilesMayHaveChanged,
  linkEvidenceOf,
  loadOrgPack,
  mergeCatalog,
  parseRecord,
  SCHEMA_VERSION,
  listQuestions,
  questionsRelOf,
  readSharedMaps,
  readTrafficFile,
  recordPath,
  serializeRecord,
  sharedDirOf,
  sharedRelOf,
  stripSharedMaps,
  writeFileAtomic,
  type CatalogRecord,
  type ContractsFileT,
  type CuratedProblem,
  type FactJoinMiss,
  type FactsJoinResult,
  type FlowRecord,
  type LinkEvidenceResult,
  type OrgPack,
  type PersonPair,
  type Question,
  type SharedJoinResult,
  type TrafficOnFile,
  sharedJoinAbout,
  type TermsResult,
} from "@maycombhq/core";
import { applyPipelineModels } from "@maycombhq/extractors";
import { listIngestors } from "@maycombhq/ingestors";
import { scanInputs, type ScanInputsResult } from "@maycombhq/intake";
import {
  answerMissesOf,
  factsEstateAfterMerge,
  factsEstateRecords,
  withFactsEstateJoins,
  withoutHeardListeners,
  type FactsEstateProjection,
  type FactsEstateRepo,
} from "./build-facts.js";
import {
  outsideProfileSystems as outsideProfileSystemsOf,
  targetsFromAnswers,
} from "./facts-catalog.js";
import { pairsOfRepo } from "./facts-scan.js";
import { forgetCatalogs, readCatalog, writeCatalog } from "./files.js";
import { resolveFederatedLooseEnds } from "./federate-loose.js";
import { joinAnswerQuestions, joinAnswerQuestionsOf } from "./join-host-questions.js";
import {
  curatedDirOf,
  estateMergeInput,
  estateRepos,
  isPrototypeRepo,
  productionRepos,
} from "./merge-input.js";
import {
  federate,
  federationSources,
  orgPackDirFor,
  usableFrameworks,
  type FederatedContribution,
  type ScanProblem,
} from "./scan.js";
import {
  buildManifestPath,
  factsSlotPaths,
  legacyJoinsPath,
  parseBuildManifest,
  parseFactsSlotMeta,
  parseFactsSnapshot,
  parseLegacyJoins,
  parseReadersSlot,
  readersSlotPath,
  serializeBuildManifest,
  serializeFactsSlotMeta,
  serializeFactsSnapshot,
  serializeLegacyJoins,
  SLOT_VERSION,
  BUILD_VERSION,
  sha256Of,
  sourcesDirOf,
  type BuildManifestT,
  type FactsSlotMetaT,
  type LegacyJoinsSlotT,
  type ReadersSlotT,
} from "./slots.js";

/**
 * The build (ADR 0195 point 2): `catalog/generated` made from the source slots and the build
 * inputs, every time, in a fixed order. `loadBuildInputs` reads what a build reads (the org pack,
 * the slots, the curated decisions, the answers, the pairings, the traffic, the shared maps);
 * `buildCatalog` reads no clone and calls no model, adapter or network (the passes that read
 * files of the metarepo itself, inputs/, catalog/proposals and the wiki folders, read only them);
 * `guardBuild` runs the guards of point 4 on the build in memory; `writeBuiltCatalog` takes the
 * undo copy, writes the slots a command changed, the record files and `build.json` last, and is
 * the only caller of `writeCatalog` (a check fails on any other import). A refused build writes
 * nothing.
 */

// ------------------------------------------------------------------ paths

const posix = (p: string) => p.split(sep).join("/");
const relOf = (root: string, p: string) => posix(relative(root, p));
const short = (c: string) => (/^[0-9a-f]{8,}$/.test(c) ? c.slice(0, 7) : c);

/** `catalog/generated` (or the branch's), relative to the root. */
export function generatedDirOf(root: string): string {
  return join(catalogDirOf(root), "generated");
}

/** Where a metarepo keeps its undo copies (ADR 0195 point 7): local, git-ignored. */
export function buildUndoDirOf(root: string, stateDir = root): string {
  return join(stateDir, ".index", "build-undo");
}

/** The upgrade's copy of the catalog before it (point 6), never read by the build. */
export function generatedBeforeUpgradeDirOf(root: string): string {
  return join(sourcesDirOf(root), "legacy", "generated-before-upgrade");
}

// ------------------------------------------------------------------ inputs

/** A repo's facts slot, read and checked (point 2.1, "current"), or why it isn't used. */
export type FactsSlotRead =
  | {
      ok: true;
      meta: FactsSlotMetaT;
      facts: import("@maycombhq/core").Fact[];
      sha: string;
      metaSha: string;
    }
  | { ok: false; problem: string };

export interface ReadersSlotRead {
  slot: ReadersSlotT;
  sha: string;
}

/** The slots a build reads, by repo id; a command passes the ones it is about to write. */
export interface BuildSlots {
  readers: Map<string, ReadersSlotRead | { problem: string }>;
  facts: Map<string, FactsSlotRead>;
  legacy?: { slot: LegacyJoinsSlotT; sha: string } | { problem: string };
}

export interface BuildInputs {
  root: string;
  op: OrgPack;
  orgPackDir: string;
  stateDir: string;
  slots: BuildSlots;
  curated: { records: CatalogRecord[]; problems: { file: string; message: string }[] };
  /** The targets and hosts questions, whose answers name where calls go. */
  questions: Question[];
  /** Each repo's corrections file text (G1 pairings), by repo. */
  corrections: Map<string, string>;
  traffic: TrafficOnFile[];
  shared: Awaited<ReturnType<typeof readSharedMaps>>;
  federated: { id: string; dir: string }[];
  /** inputs/ (intake), or null to leave it out (a branch's catalog). */
  inputsDir: string | null;
  /** The hash of each non-slot input, by its metarepo-relative path (what explains a removal). */
  inputHashes: Map<string, string>;
  curatedDir: string;
  /** Pairings not written yet (a preview's), by repo, over those on file. */
  extraPairs?: Map<string, Record<string, PersonPair>>;
  problems: string[];
}

const sha = (text: string) => sha256Of(text);

/**
 * A folder's files, hashed in path order: one hash for the folder, or none when it has none.
 * `pending` (absolute path to text, or null for a file to go) puts a command's writes in place of
 * what is on disk, so a build computed before they are written records the hashes they will have
 * (a rename's manifest, curated decisions and questions, ADR 0195 point 2).
 */
async function treeHash(
  dir: string,
  skip?: (rel: string) => boolean,
  pending?: ReadonlyMap<string, string | null>,
): Promise<string | undefined> {
  const lines: string[] = [];
  const extra = new Map<string, string | null>();
  if (pending)
    for (const [abs, text] of pending) {
      const r = relative(dir, abs);
      if (r && !r.startsWith("..") && !isAbsolute(r)) extra.set(posix(r), text);
    }
  const put = (r: string, text: string) =>
    lines.push(`${r}\u0000${sha(text.replace(/\r\n?/g, "\n"))}`);
  async function walk(d: string, rel: string) {
    const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
    const names = new Map<string, "dir" | "file">();
    for (const e of entries)
      if (e.isDirectory()) names.set(e.name, "dir");
      else if (e.isFile()) names.set(e.name, "file");
    // A pending file (or a folder holding one) not on disk yet.
    for (const r of extra.keys()) {
      if (rel && !r.startsWith(`${rel}/`)) continue;
      const [head, ...more] = (rel ? r.slice(rel.length + 1) : r).split("/");
      if (head && !names.has(head)) names.set(head, more.length ? "dir" : "file");
    }
    for (const name of [...names.keys()].sort(cmpText)) {
      const r = rel ? `${rel}/${name}` : name;
      if (skip?.(r)) continue;
      if (names.get(name) === "dir") await walk(join(d, name), r);
      else if (extra.has(r)) {
        const text = extra.get(r);
        if (typeof text === "string") put(r, text);
      } else put(r, await readFile(join(d, name), "utf8").catch(() => ""));
    }
  }
  await walk(dir, "");
  return lines.length ? sha(lines.join("\n")) : undefined;
}

async function readText(path: string): Promise<string | undefined> {
  return readFile(path, "utf8").then(
    (t) => t.replace(/\r\n?/g, "\n"),
    () => undefined,
  );
}

/** A repo's facts slot from its two files, checked as point 2.1 says ("current"). */
export function factsSlotOf(
  repo: string,
  text: string | undefined,
  metaText: string | undefined,
): FactsSlotRead | undefined {
  if (text === undefined && metaText === undefined) return undefined;
  if (text === undefined || metaText === undefined)
    return {
      ok: false,
      problem: `has ${text === undefined ? "a meta and no facts" : "facts and no meta"}`,
    };
  const meta = parseFactsSlotMeta(metaText);
  if (!meta.ok)
    return {
      ok: false,
      problem: `its meta doesn't read (${meta.issues[0]?.message ?? "invalid"})`,
    };
  if (meta.slot.repo !== repo)
    return { ok: false, problem: `its meta names another repo (${meta.slot.repo})` };
  if (sha(text) !== meta.slot.factsHash)
    return { ok: false, problem: "its facts aren't the ones its meta hashed" };
  const facts = parseFactsSnapshot(text);
  if (!facts.ok)
    return {
      ok: false,
      problem: `its facts don't read (${facts.issues[0]?.message ?? "invalid"})`,
    };
  return { ok: true, meta: meta.slot, facts: facts.facts, sha: sha(text), metaSha: sha(metaText) };
}

export function readersSlotRead(
  text: string,
  repo?: string,
): ReadersSlotRead | { problem: string } {
  const p = parseReadersSlot(text, repo);
  if (!p.ok) return { problem: `doesn't read (${p.issues[0]?.message ?? "invalid"})` };
  return { slot: p.slot, sha: sha(text) };
}

/** Every slot file on disk under catalog/sources, by repo (orphaned ones too). */
export async function readSlots(root: string): Promise<BuildSlots> {
  const dir = sourcesDirOf(root);
  const readers = new Map<string, ReadersSlotRead | { problem: string }>();
  for (const n of (await readdir(join(dir, "readers")).catch(() => [] as string[])).sort()) {
    if (!n.endsWith(".json")) continue;
    const text = await readText(join(dir, "readers", n));
    const repo = n.slice(0, -".json".length);
    if (text !== undefined) readers.set(repo, readersSlotRead(text, repo));
  }
  const facts = new Map<string, FactsSlotRead>();
  const names = new Set(
    (await readdir(join(dir, "facts")).catch(() => [] as string[]))
      .filter((n) => n.endsWith(".jsonl") || n.endsWith(".meta.json"))
      .map((n) => n.replace(/\.meta\.json$|\.jsonl$/, "")),
  );
  for (const repo of [...names].sort()) {
    const p = factsSlotPaths(root, repo);
    const f = factsSlotOf(repo, await readText(p.facts), await readText(p.meta));
    if (f) facts.set(repo, f);
  }
  const legacyText = await readText(legacyJoinsPath(root));
  let legacy: BuildSlots["legacy"];
  if (legacyText !== undefined) {
    const p = parseLegacyJoins(legacyText);
    legacy = p.ok
      ? { slot: p.slot, sha: sha(legacyText) }
      : { problem: `doesn't read (${p.issues[0]?.message ?? "invalid"})` };
  }
  return { readers, facts, ...(legacy ? { legacy } : {}) };
}

/** The org pack's folder and the state folder of a metarepo (an adopted repo keeps both in .atticus/). */
async function packOf(root: string): Promise<{ orgPackDir: string; stateDir: string }> {
  const pack = await orgPackDirFor(root);
  return { orgPackDir: pack.dir, stateDir: pack.adopted ? join(root, ".atticus") : root };
}

/**
 * Everything a build reads (point 2), from the metarepo's files. `slots` replaces what is on
 * disk with what a command is about to write (a scan's new reads, a verify's snapshot, a
 * rename's new ids), so the build and its guards run before anything is written.
 */
/**
 * CS3 (with ADR 0119): the app's server keeps catalogs and small files in memory until its
 * watcher hears a change, and a writer it runs (`edits --curate`, an answer, a rename, a verify
 * --write) can build before the watcher fires. Every kept read is forgotten (the catalogs) or
 * checked against its file again (the org pack, the questions, the facts) when a build loads its
 * inputs, so no caller can build from a kept copy. A writer that reads an input itself before
 * it builds (the org pack it passes as `op`) calls this first.
 */
export function forgetKeptReads(): void {
  forgetCatalogs();
  keptFilesMayHaveChanged();
}

export async function loadBuildInputs(
  root: string,
  o: {
    op?: OrgPack;
    orgPackDir?: string;
    stateDir?: string;
    slots?: (on: BuildSlots) => BuildSlots;
    curated?: CatalogRecord[];
    curatedDir?: string;
    inputsDir?: string | null;
    federated?: { id: string; dir: string }[];
    /**
     * A command's writes to build inputs, not yet written (ADR 0195 point 2, "compute, guard,
     * then write": a rename's manifest, scan settings, curated decisions and corrections), by
     * absolute path, null for a file that goes. The build reads and hashes them in place of
     * the files on disk. Pass the org pack (`op`), the curated records and the questions as
     * they will be, too: those are read whole, not file by file.
     */
    pending?: ReadonlyMap<string, string | null>;
    /** Every question as it will be (with `pending`): the answers the build joins and hashes. */
    questions?: readonly Question[];
  } = {},
): Promise<BuildInputs> {
  forgetKeptReads();
  const pack = await packOf(root);
  const orgPackDir = o.orgPackDir ?? pack.orgPackDir;
  const stateDir = o.stateDir ?? pack.stateDir;
  const op = o.op ?? (await loadOrgPack(orgPackDir));
  const problems: string[] = [];
  const onDisk = await readSlots(root);
  const slots = o.slots ? o.slots(onDisk) : onDisk;
  const curatedDir = o.curatedDir ?? curatedDirOf(root, op);
  const curated = o.curated
    ? { records: o.curated, problems: [] }
    : await readCatalog(curatedDir, { cacheRoot: root, fresh: true });
  const questions = o.questions
    ? joinAnswerQuestionsOf(o.questions)
    : await joinAnswerQuestions(root);
  const corrections = new Map<string, string>();
  const fDir = factsDirOf(root);
  const fNames = new Set(await readdir(fDir).catch(() => [] as string[]));
  for (const [abs, text] of o.pending ?? [])
    if (dirname(abs) === fDir) {
      if (text === null) fNames.delete(basename(abs));
      else fNames.add(basename(abs));
    }
  for (const n of [...fNames].sort())
    if (n.endsWith(".corrections.jsonl")) {
      const p = join(fDir, n);
      const w = o.pending?.get(p);
      const t = typeof w === "string" ? w.replace(/\r\n?/g, "\n") : await readText(p);
      if (t !== undefined) corrections.set(n.slice(0, -".corrections.jsonl".length), t);
    }
  const traffic: TrafficOnFile[] = [];
  const tDir = join(evidenceDirOf(root), "traffic");
  const tRel = `${evidenceRelOf(root)}/traffic`;
  for (const n of (await readdir(tDir).catch(() => [] as string[])).sort()) {
    if (!/\.ya?ml$/.test(n)) continue;
    const r = readTrafficFile(`${tRel}/${n}`, await readFile(join(tDir, n), "utf8"));
    if (r.ok) traffic.push(r.traffic);
    else problems.push(`${r.message}; it is left out.`);
  }
  const shared = await readSharedMaps(root);
  for (const p of shared.problems) problems.push(p.message);
  const federated = o.federated ?? (await federationSources(root, stateDir, op));
  const inputsDir = o.inputsDir === undefined ? join(stateDir, "inputs") : o.inputsDir;

  // What explains a removal besides a slot (point 4; the owner's decision of 2026-11-11): each
  // build input other than a slot, hashed by its folder or file.
  const inputHashes = new Map<string, string>();
  // Each kind of input is listed even when it has nothing yet, so the first answer, decision or
  // pairing changes a hash a record's sources recorded.
  const put = (rel: string, h: string | undefined) => inputHashes.set(rel, h ?? sha(""));
  put(relOf(root, orgPackDir), await treeHash(orgPackDir, undefined, o.pending));
  put(relOf(root, curatedDir), await treeHash(curatedDir, undefined, o.pending));
  // The answers, not the questions: a question raised or refreshed while open changes no build.
  const answeredQs = (
    o.questions
      ? [...o.questions]
      : (await listQuestions(root).catch(() => ({ questions: [] as Question[] }))).questions
  )
    .filter((q) => q.answer !== undefined)
    .sort((a, b) => cmpText(a.id, b.id));
  put(questionsRelOf(root), answeredQs.length ? sha(JSON.stringify(answeredQs)) : undefined);
  put(
    `${factsRelOf(root)}/*.corrections.jsonl`,
    corrections.size
      ? sha([...corrections].map(([repo, text]) => `${repo}\u0000${sha(text)}`).join("\n"))
      : undefined,
  );
  put(tRel, await treeHash(tDir));
  put(sharedRelOf(root), await treeHash(sharedDirOf(root)));
  if (inputsDir) put(relOf(root, inputsDir), await treeHash(inputsDir));
  const proposals = join(dirname(curatedDir), "proposals");
  put(relOf(root, proposals), await treeHash(proposals));
  for (const f of federated)
    put(`federated/${f.id}`, await treeHash(f.dir, (r) => r.startsWith(".") || r === "workspace"));
  return {
    root,
    op,
    orgPackDir,
    stateDir,
    slots,
    curated: { records: curated.records, problems: curated.problems },
    questions,
    corrections,
    traffic,
    shared,
    federated,
    inputsDir,
    inputHashes,
    curatedDir,
    problems,
  };
}

// ------------------------------------------------------------------ the build

/** Where one repo's records came from in a build (point 5; `--json`'s `sources`). */
export interface RepoSource {
  repo: string;
  source: "facts" | "readers" | "legacy" | "none";
  commit?: string;
  /** The slot file the records came from, relative to the root. */
  slot?: string;
  /** A slot that is there but isn't used, and why (a snapshot that doesn't read, say). */
  problem?: string;
}

/** A repo read from its facts in the build: what verify --write reports and files about it. */
export interface FactsRepoBuild {
  repo: string;
  flows: FlowRecord[];
  /** Its calls still loose after the build: a host no repo lists, or no target at all. */
  unresolved: { factId: string; id: string; unresolvedKind: string; raw: string }[];
  join: FactsJoinResult;
  answerMisses: FactJoinMiss[];
  /** The targets named for its calls (people's answers and the AI's), by call fact id. */
  targets: Readonly<Record<string, string>>;
  projectionIssues: { factId?: string; code: string; message: string }[];
}

/** A legacy join the build derived again, so it left joins.json (point 6). */
export interface RetiredJoin {
  kind: string;
  id: string;
  /** Fields where the derived record differs from the legacy copy. */
  fields: string[];
}

export interface Build {
  root: string;
  /** The catalog, sorted by kind then id: what catalog/generated holds after the write. */
  records: CatalogRecord[];
  /** The record files, by path under catalog/generated, with their canonical text. */
  files: Map<string, string>;
  /** build.json for these files. */
  manifest: BuildManifestT;
  sources: RepoSource[];
  /** Every repo the manifests list, archived ones too (an empty catalog is fine only when none). */
  listed: string[];
  /** Repos whose slots are on disk but the manifests no longer list, or list archived (point 4). */
  orphaned: { repo: string; why: "not-listed" | "archived"; files: string[] }[];
  facts: Map<string, FactsRepoBuild>;
  retired: RetiredJoin[];
  /** joins.json as it is after this build (the retired entries out), when it changed. */
  legacyJoins?: string;
  curated: {
    applied: string[];
    suppressed: string[];
    /** The record ids a current alias decision folds into its target (a removal it explains). */
    folded?: string[];
    problems: CuratedProblem[];
  };
  /** Curated decisions whose target isn't in the build: kept in catalog/curated, applied when it returns. */
  orphanedDecisions: string[];
  linkEvidence?: LinkEvidenceResult;
  shared?: SharedJoinResult;
  terms?: TermsResult;
  inputs?: ScanInputsResult;
  federated?: FederatedContribution[];
  invalid: { record: unknown; issues: { path: string; message: string }[] }[];
  notes: string[];
  problems: ScanProblem[];
  stats: { records: number; interfaces: number; verified: number; unresolved: number };
}

const byKindId = (a: CatalogRecord, b: CatalogRecord) =>
  a.kind === b.kind ? cmpText(a.id, b.id) : cmpText(a.kind, b.kind);

const repoOfEvidence = (r: CatalogRecord): string[] =>
  [...new Set(r.evidence.flatMap((e) => (e.repo ? [e.repo] : [])))].sort(cmpText);

/** The repos of each component and system id the records name (an arrow's ends, by repo). */
function endReposOf(records: Iterable<CatalogRecord>): Map<string, string[]> {
  const out = new Map<string, Set<string>>();
  const add = (id: unknown, repo: unknown) => {
    if (typeof id !== "string" || typeof repo !== "string" || !repo) return;
    const s = out.get(id) ?? new Set<string>();
    s.add(repo);
    out.set(id, s);
  };
  for (const r of records) {
    if (r.kind !== "Component") continue;
    const c = r as unknown as { id: string; repo?: string; system?: string };
    add(c.id, c.repo);
    add(c.system, c.repo);
  }
  return new Map([...out].map(([k, v]) => [k, [...v].sort(cmpText)]));
}

/**
 * The repos at an arrow's ends whose every repo is gone (removed from the manifests or archived),
 * by the ends' component or system ids: a legacy join with one of them leaves (point 6).
 */
function endsGone(r: CatalogRecord, ends: Map<string, string[]>, live: Set<string>): string[] {
  if (r.kind !== "Interface") return [];
  const x = r as unknown as { from?: string; to?: string };
  const out: string[] = [];
  for (const end of [x.from, x.to]) {
    const rs = end ? ends.get(end) : undefined;
    if (rs?.length && rs.every((repo) => !live.has(repo))) out.push(...rs);
  }
  return [...new Set(out)].sort(cmpText);
}

/** One repo's slot files on disk, relative to the root (for prune and the orphan report). */
function slotFilesOf(root: string, slots: BuildSlots, repo: string): string[] {
  const out: string[] = [];
  if (slots.readers.has(repo)) out.push(relOf(root, readersSlotPath(root, repo)));
  if (slots.facts.has(repo)) {
    const p = factsSlotPaths(root, repo);
    out.push(relOf(root, p.facts), relOf(root, p.meta));
  }
  return out;
}

/**
 * Build the catalog from the slots and the build inputs (point 2), in this order:
 *
 * 1. Per repo, one source: its facts slot when current, else its readers slot (`read` or
 *    `legacy`), else none. The choice is by repo; reader records are never matched against fact
 *    records.
 * 2. The framework models over the code records, then the estate join over every facts slot at
 *    once (answers, pairings, the AI's targets, gateway callers, term grants).
 * 3. The merge of every repo's records with intake's records of inputs/; the features found in
 *    code; the federated catalogs; the glossary.
 * 4. The link evidence of the contract files and traffic, and the shared maps.
 * 5. The legacy records (point 6), as they are, where no current source has taken over.
 * 6. The curated decisions, once, last, so a person's suppress always wins.
 *
 * Nothing the build wrote is read back as an input: build.json is read only by the guards.
 */
export async function buildCatalog(i: BuildInputs): Promise<Build> {
  const { op, root } = i;
  const problems: ScanProblem[] = [];
  const notes: string[] = [];
  for (const p of i.problems) problems.push({ source: "build", message: p });
  for (const p of op.problems)
    problems.push({
      source: `org-pack/${p.file}`,
      message: `${p.path ? `${p.path}: ` : ""}${p.message}`,
    });
  for (const p of i.curated.problems)
    problems.push({ source: `catalog/curated/${p.file}`, message: p.message });
  const listed = new Set(op.profiles.flatMap((p) => (p.repos?.repos ?? []).map((r) => r.id)));
  const archived = new Set(
    op.profiles.flatMap((p) => (p.repos?.repos ?? []).filter((r) => r.archived).map((r) => r.id)),
  );
  const repos = productionRepos(op);
  const live = new Set(repos.map((r) => r.id));

  // ---- 1. per repo, one source
  const sources: RepoSource[] = [];
  const readerRecords: CatalogRecord[] = [];
  const legacyRecords: CatalogRecord[] = [];
  const factRepos: FactsEstateRepo[] = [];
  const contracts: ContractsFileT[] = [];
  /** Each repo's slot as used, for build.json: path and hash. */
  const used = new Map<string, { path: string; sha256: string }[]>();
  for (const r of repos) {
    const f = i.slots.facts.get(r.id);
    const x = i.slots.readers.get(r.id);
    const xr = x && "slot" in x ? x : undefined;
    const problem =
      f && !f.ok
        ? `its facts snapshot ${f.problem}, so it isn't used: atticus verify ${r.id} --write`
        : x && !xr
          ? `its readers slot ${(x as { problem: string }).problem}, so it isn't used: atticus scan --repos ${r.id}`
          : undefined;
    if (problem) problems.push({ repo: r.id, source: "catalog/sources", message: problem });
    if (f?.ok) {
      const p = factsSlotPaths(root, r.id);
      used.set(r.id, [
        { path: relOf(root, p.facts), sha256: f.sha },
        { path: relOf(root, p.meta), sha256: f.metaSha },
      ]);
      const pairs: Record<string, PersonPair> = {};
      const corr = i.corrections.get(r.id);
      if (corr !== undefined) Object.assign(pairs, await pairsFrom(root, r.id, f.facts));
      Object.assign(pairs, i.extraPairs?.get(r.id) ?? {});
      const ai: Record<string, { runtime: string; run: string }> = {};
      const targets = targetsFromAnswers(r.id, f.facts, i.questions, { repoType: r.type, ai });
      factRepos.push({ repo: r.id, facts: f.facts, targets, pairs, aiTargets: ai });
      if (f.meta.contracts) contracts.push(f.meta.contracts);
      sources.push({
        repo: r.id,
        source: "facts",
        commit: f.meta.commit,
        slot: relOf(root, p.facts),
        ...(problem ? { problem } : {}),
      });
      continue;
    }
    if (xr) {
      used.set(r.id, [{ path: relOf(root, readersSlotPath(root, r.id)), sha256: xr.sha }]);
      const legacy = xr.slot.status === "legacy";
      (legacy ? legacyRecords : readerRecords).push(...xr.slot.records);
      sources.push({
        repo: r.id,
        source: legacy ? "legacy" : "readers",
        commit: xr.slot.commit,
        slot: relOf(root, readersSlotPath(root, r.id)),
        ...(problem ? { problem } : {}),
      });
      continue;
    }
    sources.push({ repo: r.id, source: "none", ...(problem ? { problem } : {}) });
  }
  // Slots of repos the manifests no longer list, or list archived: kept on disk, not built from.
  const orphaned: Build["orphaned"] = [];
  for (const repo of [...new Set([...i.slots.readers.keys(), ...i.slots.facts.keys()])].sort()) {
    if (live.has(repo) || isPrototypeRepo(op, repo)) continue;
    orphaned.push({
      repo,
      why: archived.has(repo) && listed.has(repo) ? "archived" : "not-listed",
      files: slotFilesOf(root, i.slots, repo),
    });
  }
  // A contract file is read in the facts' order of their companions (`<repo>.contracts.yaml`).
  contracts.sort((a, b) => cmpText(`${a.repo}.contracts.yaml`, `${b.repo}.contracts.yaml`));

  // ---- 2. framework models, then the estate join over every facts slot at once
  const frameworks = await usableFrameworks(op, problems);
  let projection: FactsEstateProjection | undefined;
  let code: CatalogRecord[];
  if (factRepos.length) {
    projection = factsEstateRecords(op, factRepos);
    code = applyPipelineModels([...readerRecords, ...projection.records], frameworks);
    code = withFactsEstateJoins(code, op, projection);
  } else code = applyPipelineModels(readerRecords, frameworks);

  // ---- 3. the merge, intake, features, federation, the glossary
  const read = new Set(factRepos.filter((x) => x.facts.length > 0).map((x) => x.repo));
  const mergeInput = (records: CatalogRecord[]) =>
    estateMergeInput(op, estateRepos(op), [...records].sort(byKindId), undefined, read);
  let merged = mergeCatalog(mergeInput(code));
  let inputs: ScanInputsResult | undefined;
  if (i.inputsDir !== null) {
    inputs = await scanInputs({
      root,
      orgPack: op,
      inputsDir: i.inputsDir,
      records: [...merged.records, ...i.curated.records],
      ingestors: listIngestors(),
      // Intake stamps what it read; the build gives it no clock of its own (point 8).
      scannedAt: "1970-01-01T00:00:00.000Z",
    });
    for (const p of inputs.problems)
      problems.push({ source: "intake", message: `${p.path ? `${p.path}: ` : ""}${p.message}` });
    if (inputs.records.length > 0) merged = mergeCatalog(mergeInput([...code, ...inputs.records]));
  }
  let records = withoutHeardListeners(merged.records, projection);
  let afterFacts: ReturnType<typeof factsEstateAfterMerge> | undefined;
  if (projection) {
    afterFacts = factsEstateAfterMerge(records, projection);
    records = afterFacts.records;
  }
  const curatedDir = i.curatedDir;
  const proposalsDir = join(dirname(curatedDir), "proposals");
  // The passes that read the whole catalog (features, the glossary) read the legacy records too
  // (point 6): what they derive from them is the old catalog's, which the overlay keeps as it is;
  // what a current input adds to it (a term a proposal defines) comes through.
  const legacyAll = [
    ...legacyRecords,
    ...(i.slots.legacy && "slot" in i.slots.legacy ? i.slots.legacy.slot.records : []),
  ];
  const derivedKeys = new Set(records.map((r) => `${r.kind}/${r.id}`));
  /** Keys only the legacy records give (passed through features and the glossary as they are). */
  const legacyCtx = new Set(
    legacyAll
      .filter(
        (r) =>
          !derivedKeys.has(`${r.kind}/${r.id}`) &&
          r.kind !== "Capability" &&
          r.kind !== "GlossaryTerm",
      )
      .map((r) => `${r.kind}/${r.id}`),
  );
  const context = [...records, ...legacyAll.filter((r) => !derivedKeys.has(`${r.kind}/${r.id}`))];
  const found = await featuresForScan({
    records: context.filter((r) => r.kind !== "Capability"),
    decisions: i.curated.records,
    proposalsDir,
  });
  for (const p of found.problems)
    problems.push({ source: "features", message: `${p.decision}: ${p.message}` });
  let federated: FederatedContribution[] | undefined;
  let fedRecords: CatalogRecord[] = [];
  if (i.federated.length) {
    const fed = await federate([...records, ...found.features], i.federated, problems, root);
    const placed = resolveFederatedLooseEnds({
      local: records,
      raw: [...code, ...(inputs?.records ?? [])],
      federated: fed.records,
      merge: (rs) => mergeCatalog(mergeInput(rs)),
    });
    fedRecords = placed.federated;
    federated = fed.contributions.map((c) =>
      placed.resolved.get(c.id) ? { ...c, resolved: placed.resolved.get(c.id)! } : c,
    );
  }
  const glossary = await glossaryForScan({
    root,
    orgPack: op,
    records: [
      ...context.filter((r) => r.kind !== "Capability" && r.kind !== "GlossaryTerm"),
      ...found.features,
    ],
    decisions: i.curated.records,
    proposalsDir,
    orgPackDir: i.orgPackDir,
  });
  notes.push(...merged.notes, ...glossary.problems.map((p) => `glossary: ${p}`));
  records = [...glossary.records, ...fedRecords];

  // ---- 4. link evidence and shared maps, before the curated decisions (point 2.4)
  let linkEvidence: LinkEvidenceResult | undefined;
  let shared: SharedJoinResult | undefined;
  if (projection) {
    linkEvidence = linkEvidenceOf({
      join: projection.whole,
      repos: projection.repos,
      contracts,
      traffic: i.traffic,
    });
    records = applyLinkEvidence(records, linkEvidence.marks);
    const systems = outsideProfileSystemsOf(op);
    shared = i.shared.maps.length
      ? joinSharedMaps({
          outside: projection.whole.outside ?? [],
          repos: projection.repos,
          maps: i.shared.maps,
          systems,
        })
      : undefined;
    records = shared ? applySharedMaps(records, shared, systems) : stripSharedMaps(records);
  }

  // ---- 5. the legacy records, as they are, until a current source takes over (point 6)
  const retired: RetiredJoin[] = [];
  let legacyJoins: string | undefined;
  /** The joins joins.json still holds after this build (its retired ones out). */
  let legacyKept: CatalogRecord[] | undefined;
  const legacySlot = i.slots.legacy && "slot" in i.slots.legacy ? i.slots.legacy : undefined;
  if (i.slots.legacy && !legacySlot)
    problems.push({
      source: "catalog/sources/legacy/joins.json",
      message: `${(i.slots.legacy as { problem: string }).problem}; its records aren't used`,
    });
  const byKey = new Map(records.map((r) => [`${r.kind}/${r.id}`, r]));
  // Each component's and system's repos, from every slot on disk (an archived repo's too).
  const ends = endReposOf([
    ...code,
    ...legacyAll,
    ...[...i.slots.readers.values()].flatMap((x) => ("slot" in x ? x.slot.records : [])),
  ]);
  // A live repo's legacy records, as they are; an arrow of one to a repo removed or archived
  // leaves with that repo (point 6), as a legacy join does.
  // (The whole-catalog passes read the legacy records as context, so theirs come back through
  // them: one no current source derives is taken out.)
  for (const r of legacyRecords) {
    const key = `${r.kind}/${r.id}`;
    if (!endsGone(r, ends, live).length) byKey.set(key, r);
    else if (!derivedKeys.has(key)) byKey.delete(key);
  }
  if (legacySlot) {
    // ADR 0195 point 6: "Once a slot or input that the derived record comes from has changed
    // since the upgrade (against the slot's `inputs`), the derived record takes the id". What a
    // derived record comes from is its own sources in build.json: the slots of the repos its
    // evidence names (the estate-wide `catalog/sources` hash and the build inputs every record
    // lists are what a join may rest on, not what it comes from; with them, one curated decision
    // or one answer would retire every legacy join). A slot new since the upgrade has changed.
    const changedSince = (derived: CatalogRecord) =>
      repoOfEvidence(derived).some((repo) =>
        (used.get(repo) ?? []).some((x) => legacySlot.slot.inputs[x.path] !== x.sha256),
      );
    const keep: CatalogRecord[] = [];
    for (const r of legacySlot.slot.records) {
      const key = `${r.kind}/${r.id}`;
      const derived = byKey.get(key);
      const gone =
        repoOfEvidence(r).some((x) => !live.has(x)) || endsGone(r, ends, live).length > 0;
      if (gone) {
        // One of its repos was removed or archived: it leaves, through the removal guard.
        keep.push(r);
        continue;
      }
      // Derived: a current input made it, not the legacy records the whole-catalog passes read.
      if (derived && !legacyCtx.has(key) && changedSince(derived)) {
        retired.push({ kind: r.kind, id: r.id, fields: differingFields(r, derived) });
        continue;
      }
      keep.push(r);
      byKey.set(key, r);
    }
    if (retired.length)
      legacyJoins = serializeLegacyJoins({
        ...legacySlot.slot,
        records: keep,
      });
    legacyKept = keep;
  }
  // A legacy record a current alias decision folds into another (a feature merged by a person):
  // the passes fold what they derive, and the overlay must not bring the folded one back.
  const foldedNow = new Set(
    i.curated.records.flatMap((d) =>
      d.kind === "CuratedDecision" && d.status === "current" && d.action === "alias"
        ? (Array.isArray(d.value) ? d.value : [d.value]).filter(
            (v): v is string => typeof v === "string",
          )
        : [],
    ),
  );
  const legacyKeys = new Set(
    [...legacyRecords, ...(legacySlot ? legacySlot.slot.records : [])].map(
      (r) => `${r.kind}/${r.id}`,
    ),
  );
  records = [...byKey.values()].filter(
    (r) =>
      !(legacySlot && isLegacyGone(r, legacySlot.slot, live, ends)) &&
      !(
        foldedNow.has(r.id) &&
        legacyKeys.has(`${r.kind}/${r.id}`) &&
        !derivedKeys.has(`${r.kind}/${r.id}`)
      ),
  );

  // ---- 6. the curated decisions, once, last
  // A decision changes or suppresses a record the build makes; it never adds one (ADR 0195
  // addendum: "an added record can't be a curated decision"), and an assert naming `kind` is
  // refused by applyCurated like any other protected field.
  const sorted = [...records].sort(byKindId);
  const applied = applyCurated(sorted, i.curated.records);
  const present = new Set(sorted.map((r) => r.id));
  const orphanedDecisions = i.curated.records
    .filter(
      (d): d is Extract<CatalogRecord, { kind: "CuratedDecision" }> =>
        d.kind === "CuratedDecision" && d.status === "current",
    )
    .filter((d) => d.action !== "alias" && !present.has(d.target))
    .map((d) => d.id)
    .sort(cmpText);
  for (const p of applied.problems)
    if (!orphanedDecisions.includes(p.decision))
      problems.push({ source: "curated", message: JSON.stringify(p) });
  for (const inv of merged.invalid)
    problems.push({
      source: "merge",
      message: `invalid record: ${inv.issues.map((x) => `${x.path}: ${x.message}`).join("; ")}`,
    });
  const out = applied.records.filter((r) => r.kind !== "Flow").sort(byKindId);

  // ---- per fact repo: flows, loose calls, the join about it
  const facts = new Map<string, FactsRepoBuild>();
  if (projection && afterFacts) {
    const loose = new Map(out.filter((r) => r.kind === "Unresolved").map((r) => [r.id, r]));
    for (const [repo, x] of afterFacts.repos) {
      const p = projection.per.get(repo)!;
      const unresolved: FactsRepoBuild["unresolved"] = [];
      for (const [id, factId] of x.looseFact) {
        const r = loose.get(id) as Extract<CatalogRecord, { kind: "Unresolved" }> | undefined;
        if (r) unresolved.push({ factId, id, unresolvedKind: r.unresolvedKind, raw: r.raw });
      }
      unresolved.sort((a, b) => cmpText(a.factId, b.factId));
      facts.set(repo, {
        repo,
        flows: x.flows,
        unresolved,
        join: x.join,
        answerMisses: answerMissesOf(projection, repo),
        targets: p.targets,
        projectionIssues: p.projected.issues.filter((iss) => iss.code !== "unresolved-target"),
      });
    }
  }

  // ---- the files and build.json
  const files = new Map<string, string>();
  for (const r of out) files.set(recordPath(r), serializedOf(r));
  // joins.json as this build leaves it (its retired joins out): what the next build reads.
  const manifest = manifestOf(
    root,
    out,
    files,
    i,
    used,
    legacyJoins !== undefined ? sha(legacyJoins) : legacySlot ? legacySlot.sha : undefined,
    legacyKept ?? [],
  );
  const stats = {
    records: out.length,
    interfaces: out.filter((r) => r.kind === "Interface").length,
    verified: out.filter((r) => r.kind === "Interface" && r.confidence === "verified").length,
    unresolved: out.filter((r) => r.kind === "Unresolved").length,
  };
  for (const r of sources)
    if (r.source === "legacy")
      notes.push(
        `${r.repo}: its records are kept from before the upgrade (a legacy slot); scan or verify this repo to replace it.`,
      );
  return {
    root,
    records: out,
    files,
    manifest,
    sources,
    listed: [...listed].sort(cmpText),
    orphaned,
    facts,
    retired,
    ...(legacyJoins !== undefined ? { legacyJoins } : {}),
    curated: {
      applied: applied.applied,
      suppressed: applied.suppressed,
      folded: [
        ...new Set(
          i.curated.records.flatMap((d) =>
            d.kind === "CuratedDecision" && d.status === "current" && d.action === "alias"
              ? (Array.isArray(d.value) ? d.value : [d.value]).filter(
                  (v): v is string => typeof v === "string",
                )
              : [],
          ),
        ),
      ].sort(cmpText),
      problems: applied.problems,
    },
    orphanedDecisions,
    ...(linkEvidence ? { linkEvidence } : {}),
    ...(shared ? { shared } : {}),
    ...(projection ? { terms: projection.terms } : {}),
    ...(inputs ? { inputs } : {}),
    ...(federated ? { federated } : {}),
    invalid: merged.invalid,
    notes,
    problems,
    stats,
  };
}

/** The part of a build's shared-map join about one repo (ADR 0160), for its verify report. */
export function sharedAbout(b: Build, repo: string): SharedJoinResult | undefined {
  return b.shared ? sharedJoinAbout(b.shared, repo) : undefined;
}

async function pairsFrom(
  root: string,
  repo: string,
  facts: readonly import("@maycombhq/core").Fact[],
): Promise<Record<string, PersonPair>> {
  return pairsOfRepo(root, repo, facts);
}

/** A legacy record whose repos the manifests no longer list (or list archived): it leaves. */
function isLegacyGone(
  r: CatalogRecord,
  slot: LegacyJoinsSlotT,
  live: Set<string>,
  ends: Map<string, string[]>,
): boolean {
  if (!slot.records.some((x) => x.kind === r.kind && x.id === r.id)) return false;
  return repoOfEvidence(r).some((x) => !live.has(x)) || endsGone(r, ends, live).length > 0;
}

function differingFields(a: CatalogRecord, b: CatalogRecord): string[] {
  const x = a as unknown as Record<string, unknown>;
  const y = b as unknown as Record<string, unknown>;
  return [...new Set([...Object.keys(x), ...Object.keys(y)])]
    .filter((k) => k !== "evidence" && JSON.stringify(x[k]) !== JSON.stringify(y[k]))
    .sort(cmpText);
}

/**
 * A record's canonical YAML, kept by its JSON for the next builds in this process: most records
 * of a build are the last build's, and the YAML writer was most of a build's time (ADR 0195,
 * CS2: the budgets). The text is what `serializeRecord` gives; only the work is saved.
 */
function serializedOf(r: CatalogRecord): string {
  const key = JSON.stringify(r);
  const hit = SERIALIZED.get(key);
  if (hit !== undefined) {
    SERIALIZED.delete(key);
    SERIALIZED.set(key, hit);
    return hit;
  }
  const text = serializeRecord(r);
  SERIALIZED.set(key, text);
  if (SERIALIZED.size > SERIALIZED_MAX) SERIALIZED.delete(SERIALIZED.keys().next().value!);
  return text;
}
const SERIALIZED = new Map<string, string>();
const SERIALIZED_MAX = 20_000;

/** The single hash of every slot the build used (what a join with any repo may rest on). */
const ALL_SLOTS = "catalog/sources";

function manifestOf(
  root: string,
  records: readonly CatalogRecord[],
  files: Map<string, string>,
  i: BuildInputs,
  used: Map<string, { path: string; sha256: string }[]>,
  legacySha: string | undefined,
  legacyKept: readonly CatalogRecord[],
): BuildManifestT {
  const all = [...used.values()].flat().sort((a, b) => cmpText(a.path, b.path));
  if (legacySha) all.push({ path: relOf(root, legacyJoinsPath(root)), sha256: legacySha });
  const allSlots = sha(all.map((x) => `${x.path}\u0000${x.sha256}`).join("\n"));
  const inputs = [...i.inputHashes].map(([path, sha256]) => ({ path, sha256 }));
  const legacyKeys = new Set(legacySha ? legacyKept.map((r) => `${r.kind}/${r.id}`) : []);
  const genRel = relOf(root, generatedDirOf(root));
  const out: BuildManifestT["files"] = [];
  for (const r of records) {
    const path = recordPath(r);
    const text = files.get(path)!;
    const srcs: { path: string; sha256: string }[] = [];
    for (const repo of repoOfEvidence(r)) srcs.push(...(used.get(repo) ?? []));
    if (legacySha && legacyKeys.has(`${r.kind}/${r.id}`))
      srcs.push({ path: relOf(root, legacyJoinsPath(root)), sha256: legacySha });
    srcs.push({ path: ALL_SLOTS, sha256: allSlots }, ...inputs);
    const seen = new Set<string>();
    out.push({
      path: `${genRel}/${path}`,
      sha256: sha(text),
      sources: srcs.filter((s) => !seen.has(s.path) && !!seen.add(s.path)),
    });
  }
  return { version: 1, buildVersion: BUILD_VERSION, files: out };
}

// ------------------------------------------------------------------ the guards

/** What a changed source of a removed record was, in words: a slot, its repo's new source, an input. */
function sourceWords(path: string, b: Build): string {
  const m = /sources\/(readers|facts)\/(.+?)(\.meta\.json|\.jsonl|\.json)$/.exec(path);
  if (m) {
    const now = b.sources.find((s) => s.repo === m[2]);
    const was = m[1] === "facts" ? "facts snapshot" : "readers slot";
    if (now?.slot && now.slot !== path && m[3] !== ".meta.json")
      return `${m[2]} is built from ${now.source === "facts" ? "its facts snapshot" : now.source === "legacy" ? "a legacy slot" : "its readers slot"} now (${now.slot})`;
    return `${m[2]}'s ${was} changed (${path})`;
  }
  if (path.endsWith("joins.json")) return "a legacy join was derived again, or left";
  return `an input changed (${path})`;
}

/** The kinds a join across repos derives (an arrow, a loose end, a feature, a glossary term). */
const JOIN_DERIVED = new Set(["Interface", "Unresolved", "Capability", "GlossaryTerm"]);

/** The two limits of point 4: built in, not settings (a setting would be a C6 change). */
export const REMOVAL_LIMITS = { share: 0.1, count: 200 } as const;

/** Why a removal is explained (ADR 0195 point 4), as kinds a program reads. */
export type RemovalReason =
  /** A slot changed: a repo's new read or facts no longer produce it, or a join no longer forms. */
  | "slot"
  /** A repo the manifests no longer list. */
  | "manifest"
  /** A repo marked archived. */
  | "archived"
  /** A curated decision (a suppress). */
  | "curated"
  /** A build input other than a slot changed: an answer, a pairing, the org pack, inputs/... */
  | "input"
  /** The build itself changed (an Atticus whose passes give other records). */
  | "build";

export interface Removal {
  /** The record file, relative to the root. */
  path: string;
  kind: string;
  id: string;
  /** The repos its evidence names. */
  repos: string[];
  /** What explains it: the slots or inputs that changed since the last build, or why else. */
  explainedBy: string[];
  /** The same as kinds, most specific first: a repo gone, a decision, a slot, an input. */
  reasons: RemovalReason[];
}

export interface HandEdit {
  path: string;
  how: "changed" | "added" | "deleted";
}

export type RefusalReason =
  | "nothing-read"
  | "empty"
  | "unexplained-removals"
  | "large-removals"
  | "hand-edits"
  | "not-upgraded";

/** Why a build wrote nothing (point 4): every reason at once, with its list, and how to go on. */
export interface BuildRefusal {
  reasons: RefusalReason[];
  /** The whole refusal in words, what to do included. */
  message: string;
  removals?: Removal[];
  unexplained?: Removal[];
  /** The count `--allow-removals` must name to confirm these removals. */
  allowRemovals?: number;
  edits?: HandEdit[];
  /** The count `--discard-edits` must name to discard these edits. */
  discardEdits?: number;
  /** For a scan that read nothing: each repo and why. */
  unread?: { repo: string; why: string }[];
}

export interface GuardResult {
  /** Removals the build writes (explained, and confirmed when large). */
  removals: Removal[];
  /** Hand edits a confirmed discard replaces. */
  edits: HandEdit[];
  refused?: BuildRefusal;
}

/** Where `atticus catalog edits --curate` notes the edits it made curated (beside the undo copies). */
export const curatedEditsPathOf = (undoDir: string) =>
  join(dirname(undoDir), "build-curated-edits.json");

/** The edits made curated, by path (relative to the root), with the hash they had (or "deleted"). */
export async function readCuratedEdits(undoDir: string): Promise<Map<string, string>> {
  const t = await readText(curatedEditsPathOf(undoDir));
  if (!t) return new Map();
  try {
    return new Map(Object.entries(JSON.parse(t) as Record<string, string>));
  } catch {
    return new Map();
  }
}

/** Note edits as made curated: the next build replaces them, its undo copy keeping their bytes. */
export async function writeCuratedEdits(
  root: string,
  undoDir: string,
  paths: readonly string[],
): Promise<void> {
  const out: Record<string, string> = Object.fromEntries(await readCuratedEdits(undoDir));
  for (const p of paths) {
    const t = await readText(join(root, ...p.split("/")));
    out[p] = t === undefined ? "deleted" : sha(t);
  }
  await mkdir(dirname(curatedEditsPathOf(undoDir)), { recursive: true });
  await writeFile(curatedEditsPathOf(undoDir), JSON.stringify(out, null, 2) + "\n", "utf8");
}

/** The last build.json, when there is one that reads. */
export async function readBuildManifest(
  path: string,
): Promise<{ manifest?: BuildManifestT; text?: string; problem?: string }> {
  const text = await readText(path);
  if (text === undefined) return {};
  const p = parseBuildManifest(text);
  return p.ok
    ? { manifest: p.slot, text }
    : { text, problem: `doesn't read (${p.issues[0]?.message ?? "invalid"})` };
}

/** Every record file under a catalog folder, with the hash of its bytes (line endings aside). */
/** A catalog folder's record files, by path under it: their text (LF) and its hash. */
type DiskFiles = Map<string, { sha: string; text: string }>;

async function hashFiles(dir: string): Promise<DiskFiles> {
  const out = new Map<string, { sha: string; text: string }>();
  async function walk(d: string, rel: string) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => cmpText(a.name, b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(join(d, e.name), r);
      else if (/\.ya?ml$/.test(e.name)) {
        const text = (await readFile(join(d, e.name), "utf8")).replace(/\r\n?/g, "\n");
        out.set(r, { sha: sha(text), text });
      }
    }
  }
  await walk(dir, "");
  return out;
}

/** Where a command writes (the baseline's catalog, or a branch's beside it). */
export interface CatalogTarget {
  /** catalog/generated (or catalog/branches/<b>/generated). */
  generated: string;
  /** build.json for it. */
  manifest: string;
}

/** A build's manifest with its file paths under the target's folder (a branch's, say). */
export function manifestAt(b: Build, target: CatalogTarget): BuildManifestT {
  const base = relOf(b.root, generatedDirOf(b.root));
  const at = relOf(b.root, target.generated);
  if (base === at) return b.manifest;
  return {
    ...b.manifest,
    files: b.manifest.files.map((f) => ({
      ...f,
      path: f.path.startsWith(`${base}/`) ? `${at}/${f.path.slice(base.length + 1)}` : f.path,
    })),
  };
}

export function baselineTarget(root: string): CatalogTarget {
  return { generated: generatedDirOf(root), manifest: buildManifestPath(root) };
}

/**
 * The manifest of a build that was cut short (point 2): the latest undo copy's manifest of the
 * build it was taking, when build.json isn't it. A file that matches it is a build's output.
 */
async function interruptedManifest(
  undoDir: string,
  current: string | undefined,
): Promise<BuildManifestT | undefined> {
  const latest = (await listUndo(undoDir))[0];
  if (!latest) return undefined;
  const next = await readText(join(undoDir, String(latest.n), "next-build.json"));
  if (next === undefined || next === current) return undefined;
  const p = parseBuildManifest(next);
  return p.ok ? p.slot : undefined;
}

/** Said when an undo took back the upgrade to slots (ADR 0195 point 7: every write can be undone). */
export const UPGRADE_UNDONE =
  "The last undo took back the upgrade; run atticus upgrade --yes (or Upgrade on Set up › Catalog builds) to build from slots again.";

/**
 * The guards of point 4, on the build in memory, before any file is written. `changed` are the
 * slot files this command writes (a scan's reads, a verify's snapshot): a removal they explain is
 * the command's own result.
 */
export async function guardBuild(
  b: Build,
  o: {
    target?: CatalogTarget;
    undoDir: string;
    /** `--allow-removals <count>`: confirms exactly the removals listed with this count. */
    allowRemovals?: number;
    /** `--discard-edits <count>`: confirms exactly the hand edits listed with this count. */
    discardEdits?: number;
    /** The command, for the words of what to run again. */
    command: string;
    /** The target's record files as read already (buildAndWrite reads them once). */
    onDisk?: DiskFiles;
  },
): Promise<GuardResult> {
  const root = b.root;
  const target = o.target ?? baselineTarget(root);
  const genRel = relOf(root, target.generated);
  const last = await readBuildManifest(target.manifest);
  const onDisk = o.onDisk ?? (await hashFiles(target.generated));
  const reasons: RefusalReason[] = [];
  const lines: string[] = [];
  const again = (flag: string) => `${o.command} ${flag}`;

  // ---- hand edits (and a catalog from before the slots)
  const edits: HandEdit[] = [];
  const known = new Map<string, string>(); // path under generated -> sha
  const strip = (p: string) => (p.startsWith(`${genRel}/`) ? p.slice(genRel.length + 1) : p);
  for (const f of last.manifest?.files ?? []) known.set(strip(f.path), f.sha256);
  const interrupted = await interruptedManifest(o.undoDir, last.text);
  const alt = new Map<string, string>();
  for (const f of interrupted?.files ?? []) alt.set(strip(f.path), f.sha256);
  // A catalog with no build.json is one from before the slots, unless every file in it is what
  // the first build, cut short, was writing (its undo copy's manifest): that build catches up.
  const before =
    !last.manifest && onDisk.size > 0 && ![...onDisk].every(([p, f]) => alt.get(p) === f.sha);
  if (!before) {
    for (const [p, f] of onDisk) {
      const want = b.files.get(p);
      // A file holding what this build writes loses nothing (an edit made curated, say).
      if (want !== undefined && sha(want) === f.sha) continue;
      if (known.get(p) === f.sha || alt.get(p) === f.sha) continue;
      edits.push({ path: `${genRel}/${p}`, how: known.has(p) || alt.has(p) ? "changed" : "added" });
    }
    // A file deleted by hand is an edit, unless an interrupted build had removed it.
    for (const p of known.keys())
      if (!onDisk.has(p) && !(interrupted && !alt.has(p)))
        edits.push({ path: `${genRel}/${p}`, how: "deleted" });
  }
  edits.sort((a, c) => cmpText(a.path, c.path));
  // Edits `atticus catalog edits --curate` made curated decisions of: their effect is in
  // catalog/curated now, so this build replaces them (their bytes go into the undo copy).
  const marked = await readCuratedEdits(o.undoDir);
  const curatedEdits = edits.filter((e) => {
    const m = marked.get(e.path);
    if (m === undefined) return false;
    const now = onDisk.get(strip(e.path));
    return now ? m === now.sha : m === "deleted";
  });
  for (const e of curatedEdits) edits.splice(edits.indexOf(e), 1);
  if (before && o.discardEdits !== onDisk.size) {
    reasons.push("not-upgraded");
    // An undo that took back the upgrade leaves a catalog from before the slots again.
    const latest = (await listUndo(o.undoDir))[0];
    if (latest?.command.startsWith("atticus catalog undo")) lines.push(UPGRADE_UNDONE);
    lines.push(
      `${genRel} was written before beta.27 (there is no ${relOf(root, target.manifest)}): run atticus upgrade to adopt its ${onDisk.size} record files into legacy slots (it shows what it would do first; atticus upgrade --yes applies it), or replace them with this build: ${again(`--discard-edits ${onDisk.size}`)}.`,
    );
  } else if (edits.length && o.discardEdits !== edits.length) {
    reasons.push("hand-edits");
    lines.push(
      `${edits.length} ${edits.length === 1 ? "file" : "files"} under ${genRel} ${edits.length === 1 ? "was" : "were"} changed by hand since the last build, so nothing is overwritten:`,
      ...edits.slice(0, 20).map((e) => `  ${e.how}: ${e.path}`),
      ...(edits.length > 20 ? [`  and ${edits.length - 20} more`] : []),
      `Make ${edits.length === 1 ? "it" : "them"} curated decisions, which every later build keeps: atticus catalog edits --curate. Or discard ${edits.length === 1 ? "it" : "them"} (a copy is kept for atticus catalog undo): ${again(`--discard-edits ${edits.length}`)}.`,
    );
    if (o.discardEdits !== undefined)
      lines.push(`--discard-edits ${o.discardEdits} doesn't name the ${edits.length} listed.`);
  }
  const discardCount = before ? onDisk.size : edits.length;
  const beforeEdits: HandEdit[] = [...onDisk.keys()].map((p) => ({
    path: `${genRel}/${p}`,
    how: "added" as const,
  }));

  // ---- removals: what the last build wrote and this one wouldn't
  const removals: Removal[] = [];
  const unexplained: Removal[] = [];
  if (last.manifest) {
    const nowSources = new Set<string>();
    for (const f of b.manifest.files)
      for (const s of f.sources) nowSources.add(`${s.path}\u0000${s.sha256}`);
    const oldRecords = new Map<string, CatalogRecord>();
    // The last build's records are read only when this one removes any (most builds don't).
    const removing = last.manifest.files.some((f) => {
      const p = strip(f.path);
      return !b.files.has(p) && onDisk.has(p);
    });
    if (removing) {
      const cat = await readCatalog(target.generated, { cacheRoot: root, fresh: true });
      for (const r of cat.records) oldRecords.set(recordPath(r), r);
    }
    const repoGone = (repo: string) => !b.sources.some((s) => s.repo === repo);
    // Each repo's slot files as this build read them, with their hashes.
    const slotNow = new Map<string, { path: string; sha256: string }[]>();
    for (const f of b.manifest.files)
      for (const x of f.sources) {
        const m = /sources\/(?:readers|facts)\/(.+?)(?:\.meta\.json|\.jsonl|\.json)$/.exec(x.path);
        if (!m) continue;
        const xs = slotNow.get(m[1]!) ?? [];
        if (!xs.some((y) => y.path === x.path)) xs.push(x);
        slotNow.set(m[1]!, xs);
      }
    // Each slot file as the last build read it.
    const slotThen = new Set<string>();
    for (const f of last.manifest.files)
      for (const x of f.sources)
        if (/sources\/(?:readers|facts)\//.test(x.path)) slotThen.add(`${x.path}\u0000${x.sha256}`);
    /** The repos whose slot is new or changed since the last build. */
    const slotChanged = (repo: string) =>
      (slotNow.get(repo) ?? []).some((x) => !slotThen.has(`${x.path}\u0000${x.sha256}`));
    // The arrows this build makes that the last didn't, by the components at their ends: a loose
    // end such an arrow joins is explained by the slot of the repo at its other end, when that
    // slot changed (a join with a repo read since), else by what else changed (an answer).
    const compRepo = new Map<string, string>();
    for (const x of b.records)
      if (x.kind === "Component") {
        const c = x as unknown as { id: string; repo?: string };
        if (c.repo) compRepo.set(c.id, c.repo);
      }
    const newArrowsOf = new Map<string, string[]>();
    for (const x of b.records) {
      if (
        x.kind !== "Interface" ||
        last.manifest.files.some((f) => f.path.endsWith(`/${recordPath(x)}`))
      )
        continue;
      const i = x as unknown as { from?: string; to?: string };
      for (const [a, z] of [
        [i.from, i.to],
        [i.to, i.from],
      ] as const)
        if (a && z) newArrowsOf.set(a, [...(newArrowsOf.get(a) ?? []), z]);
    }
    // An arrow's ends, by repo, as the last build had them: a join with a repo gone is explained.
    const oldEnds = endReposOf(oldRecords.values());
    const liveNow = new Set(b.sources.map((s) => s.repo));
    for (const f of last.manifest.files) {
      const p = strip(f.path);
      if (b.files.has(p)) continue;
      // A file deleted by hand isn't a removal of this build's: the edits above list it (or
      // `edits --curate` made it a decision the build keeps).
      if (!onDisk.has(p)) continue;
      const r = oldRecords.get(p);
      const [kind, file] = p.split("/");
      const id = r?.id ?? (file ?? "").replace(/\.ya?ml$/, "");
      const repos = r ? repoOfEvidence(r) : [];
      const why = new Set<string>();
      const kinds = new Set<RemovalReason>();
      let estate = false;
      for (const s of f.sources)
        if (!nowSources.has(`${s.path}\u0000${s.sha256}`)) {
          if (s.path === ALL_SLOTS) estate = true;
          else {
            why.add(sourceWords(s.path, b));
            kinds.add(/(^|\/)sources\//.test(s.path) ? "slot" : "input");
          }
        }
      // A repo its evidence names that has a slot now the record didn't rest on (read for the
      // first time since, a repo not cloned then, say): that repo's slot explains it.
      const had = new Set(f.sources.map((x) => `${x.path}\u0000${x.sha256}`));
      for (const repo of repos)
        for (const x of slotNow.get(repo) ?? [])
          if (!had.has(`${x.path}\u0000${x.sha256}`)) {
            why.add(sourceWords(x.path, b));
            kinds.add("slot");
          }
      // An arrow whose end is a repo whose slot changed since (its evidence may name only the
      // caller, for an arrow inferred from a host): that slot explains it.
      if (estate && r?.kind === "Interface") {
        const x = r as unknown as { from?: string; to?: string };
        for (const end of [x.from, x.to])
          for (const repo of new Set([
            ...((end ? oldEnds.get(end) : undefined) ?? []),
            ...(end && compRepo.has(end) ? [compRepo.get(end)!] : []),
          ]))
            if (!repos.includes(repo) && slotChanged(repo)) {
              why.add(`${repo}'s slot changed (the arrow's other end)`);
              kinds.add("slot");
            }
      }
      // A loose end a new arrow joins, with a repo whose slot changed since: that slot explains it.
      if (estate && r?.kind === "Unresolved") {
        const owner = String((r as unknown as { owner?: string }).owner ?? "");
        for (const other of newArrowsOf.get(owner) ?? []) {
          const repo = compRepo.get(other);
          if (repo && slotChanged(repo)) {
            why.add(`joined with ${repo}'s read`);
            kinds.add("slot");
          }
        }
      }
      // Only the estate's slots as a whole changed: a join with another repo no longer forms.
      // Only a record a join derives can rest on another repo's slot: an arrow, a loose end, a
      // feature or a term traced through several repos, or an id two repos' records collided on
      // (evidence from more than one). Any other record comes from its own repo's slot, so this
      // explains nothing of it (the review: it explained every removal).
      const joinDerived =
        !!r && (JOIN_DERIVED.has(r.kind) || repos.length > 1);
      if (estate && !why.size && joinDerived) {
        why.add("another repo's slot changed (a join with it)");
        kinds.add("slot");
      }
      for (const repo of new Set([...repos, ...(r ? endsGone(r, oldEnds, liveNow) : [])]))
        if (repoGone(repo)) {
          const archived = b.listed.includes(repo);
          // A repo whose slots are kept (orphaned) was archived or taken out of the manifests; one
          // whose slots went with it was renamed, its slots written under the new name.
          if (!archived && !b.orphaned.some((o) => o.repo === repo)) {
            why.add(`${repo}'s slot is gone (the repo was renamed)`);
            kinds.add("slot");
            continue;
          }
          why.add(archived ? `${repo} is archived` : `${repo} isn't in the manifests any more`);
          kinds.add(archived ? "archived" : "manifest");
        }
      if (last.manifest.buildVersion !== b.manifest.buildVersion) {
        why.add(`the build changed (${last.manifest.buildVersion} to ${b.manifest.buildVersion})`);
        kinds.add("build");
      }
      if (b.curated.suppressed.includes(id)) {
        why.add("a curated suppress");
        kinds.add("curated");
      }
      if (b.curated.folded?.includes(id)) {
        why.add("a curated alias folds it into another record");
        kinds.add("curated");
      }
      const order: RemovalReason[] = ["manifest", "archived", "curated", "slot", "input", "build"];
      const removal: Removal = {
        path: f.path,
        kind: r?.kind ?? kind ?? "",
        id,
        repos,
        explainedBy: [...why].sort(cmpText),
        reasons: order.filter((k) => kinds.has(k)),
      };
      (removal.explainedBy.length ? removals : unexplained).push(removal);
    }
    // The records each repo had in the last build, for the share.
    const had = new Map<string, number>();
    for (const r of oldRecords.values())
      for (const repo of repoOfEvidence(r)) had.set(repo, (had.get(repo) ?? 0) + 1);
    if (unexplained.length) {
      reasons.push("unexplained-removals");
      lines.push(
        `${unexplained.length} ${unexplained.length === 1 ? "record" : "records"} the last build wrote would be removed, and no changed slot, input, manifest entry or curated decision explains ${unexplained.length === 1 ? "it" : "them"}. That is a bug: nothing is written, and this list is its report:`,
        ...unexplained
          .slice(0, 20)
          .map((x) => `  ${x.kind}/${x.id}${x.repos.length ? ` (${x.repos.join(", ")})` : ""}`),
        ...(unexplained.length > 20 ? [`  and ${unexplained.length - 20} more`] : []),
      );
    }
    const gone = new Map<string, number>();
    for (const x of removals) for (const repo of x.repos) gone.set(repo, (gone.get(repo) ?? 0) + 1);
    const big = [...gone].filter(([repo, n]) => n > (had.get(repo) ?? 0) * REMOVAL_LIMITS.share);
    if (
      (big.length || removals.length > REMOVAL_LIMITS.count) &&
      o.allowRemovals !== removals.length
    ) {
      reasons.push("large-removals");
      const per = big.map(([repo, n]) => `${n} of ${repo}'s ${had.get(repo) ?? 0}`);
      lines.push(
        `This would remove ${removals.length} ${removals.length === 1 ? "record" : "records"}${per.length ? ` (${per.join(", ")})` : ""}, more than ${REMOVAL_LIMITS.share * 100}% of a repo's records or ${REMOVAL_LIMITS.count} in one build, so ${removals.length === 1 ? "it waits" : "they wait"} for you to confirm:`,
        ...removals
          .slice(0, 20)
          .map((x) => `  would remove ${x.kind}/${x.id}: ${x.explainedBy.join("; ")}`),
        ...(removals.length > 20 ? [`  and ${removals.length - 20} more`] : []),
        `Confirm exactly these: ${again(`--allow-removals ${removals.length}`)}.`,
      );
      if (o.allowRemovals !== undefined)
        lines.push(
          `--allow-removals ${o.allowRemovals} doesn't name the ${removals.length} listed.`,
        );
    }
  }

  // ---- no empty catalog over a full one
  const fromCode = (r: CatalogRecord) => r.evidence.some((e) => !!e.repo);
  const emptyNow = !b.records.some(fromCode) && b.listed.length > 0;
  const hadCode =
    emptyNow && last.manifest
      ? (await readCatalog(target.generated, { cacheRoot: root, fresh: true })).records.some(
          fromCode,
        )
      : false;
  if (hadCode && emptyNow) {
    reasons.push("empty");
    lines.push(
      `The build has no record from any repo's code, and ${genRel} has some, so it is left as it was. Check that the manifests list the repos to read (an archived repo or a prototype isn't read), then build again.`,
    );
  }

  if (reasons.length) {
    return {
      removals,
      edits,
      refused: {
        reasons,
        message: [`Nothing written: ${genRel} and every slot are as they were.`, ...lines].join(
          "\n",
        ),
        ...(removals.length ? { removals, allowRemovals: removals.length } : {}),
        ...(unexplained.length ? { unexplained } : {}),
        ...(edits.length || before
          ? { edits: before ? beforeEdits : edits, discardEdits: discardCount }
          : {}),
      },
    };
  }
  return { removals, edits: [...(before ? beforeEdits : edits), ...curatedEdits] };
}

// ------------------------------------------------------------------ the write, and undo

/** One file a command writes besides the records: a slot, or its removal (`text: null`). */
export interface SlotWrite {
  /** Absolute path. */
  path: string;
  text: string | null;
  /**
   * A build input the command writes with its slots, not a slot (a rename's manifest, curated
   * decisions, questions and facts files): in the undo copy and written in order with the slots,
   * but not listed among the slots written.
   */
  input?: true;
}

export interface WriteResult {
  written: number;
  unchanged: number;
  removed: number;
  /** The slot files written or removed. */
  slots: string[];
  /** The undo copy taken, when anything changed. */
  undo?: number;
  removals: Removal[];
  discarded: HandEdit[];
}

export const UNDO_KEEP = 5;

/**
 * A test hook (ADR 0195 point 10, "a crash part way through a write"): when set, the next write
 * stops after its slots (`after-slots`) or after some of its record files (`mid-records`),
 * throwing `BuildCrash`, as a process that died there would leave it. Never set outside tests.
 */
export const buildWriteHooks: { crash?: "after-slots" | "mid-records" } = {};

export class BuildCrash extends Error {
  constructor(readonly at: "after-slots" | "mid-records") {
    super(`the write stopped ${at} (a test hook)`);
  }
}

interface UndoEntry {
  version: 1;
  n: number;
  command: string;
  commit: string | null;
  at: string;
  /** Each file the command touched, relative to the root, and whether it was there before. */
  files: { path: string; before: "file" | "absent" }[];
  /**
   * The build inputs the command wrote with its slots (a rename's manifest, facts files,
   * questions and curated decisions), kept the same way. Only a failed write puts them back
   * (`rollBackUndo`); `atticus catalog undo` doesn't, as point 7 says of inputs.
   */
  inputs?: { path: string; before: "file" | "absent" }[];
}

/** The undo copies, newest first. */
export async function listUndo(undoDir: string): Promise<UndoEntry[]> {
  const out: UndoEntry[] = [];
  for (const n of await readdir(undoDir).catch(() => [] as string[])) {
    if (!/^\d+$/.test(n)) continue;
    const t = await readText(join(undoDir, n, "undo.json"));
    if (t === undefined) continue;
    try {
      out.push(JSON.parse(t) as UndoEntry);
    } catch {
      // A copy cut short is no copy.
    }
  }
  return out.sort((a, b) => b.n - a.n);
}

/** The metarepo's commit, read from .git without running git (undo copies say it). */
async function headOf(root: string): Promise<string | null> {
  const head = await readText(join(root, ".git", "HEAD"));
  if (!head) return null;
  const ref = /^ref: (.+)$/m.exec(head)?.[1];
  if (!ref) return head.trim() || null;
  return ((await readText(join(root, ".git", ...ref.split("/")))) ?? "").trim() || null;
}

/**
 * Take an undo copy (point 7) of the files a command is about to touch: their bytes now (or that
 * they aren't there), the command, the metarepo's commit and the time. Only the last five are
 * kept. Nothing is copied when nothing would change.
 */
export async function takeUndoCopy(
  root: string,
  undoDir: string,
  command: string,
  touched: readonly { path: string; text: string | null; input?: true }[],
  extra: { nextManifest?: string; now?: Date } = {},
): Promise<number | undefined> {
  // The bytes as they are on disk (a Windows checkout's CRLF kept), compared as text.
  const changes: { path: string; before: Buffer | null; input?: true }[] = [];
  for (const t of touched) {
    const raw = await readFile(t.path).catch(() => undefined);
    const cur = raw?.toString("utf8").replace(/\r\n?/g, "\n");
    if ((cur ?? null) === (t.text === null ? null : t.text.replace(/\r\n?/g, "\n"))) continue;
    changes.push({ path: t.path, before: raw ?? null, ...(t.input ? { input: t.input } : {}) });
  }
  if (!changes.length) return undefined;
  const listed = (cs: typeof changes) =>
    cs
      .map((c) => ({
        path: relOf(root, c.path),
        before: c.before === null ? ("absent" as const) : ("file" as const),
      }))
      .sort((a, b) => cmpText(a.path, b.path));
  const list = await listUndo(undoDir);
  const n = (list[0]?.n ?? 0) + 1;
  const dir = join(undoDir, String(n));
  // A copy cut short before its undo.json (a crash) is no copy: its folder is taken again.
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, "files"), { recursive: true });
  for (const c of changes)
    if (c.before !== null) {
      const to = join(dir, "files", ...relOf(root, c.path).split("/"));
      await mkdir(dirname(to), { recursive: true });
      await writeFile(to, c.before);
    }
  if (extra.nextManifest !== undefined)
    await writeFile(join(dir, "next-build.json"), extra.nextManifest, "utf8");
  const entry: UndoEntry = {
    version: 1,
    n,
    command,
    commit: await headOf(root),
    at: (extra.now ?? new Date()).toISOString(),
    files: listed(changes.filter((c) => !c.input)),
    ...(changes.some((c) => c.input) ? { inputs: listed(changes.filter((c) => c.input)) } : {}),
  };
  await writeFile(join(dir, "undo.json"), JSON.stringify(entry, null, 2) + "\n", "utf8");
  for (const old of list.slice(UNDO_KEEP - 1))
    await rm(join(undoDir, String(old.n)), { recursive: true, force: true });
  return n;
}

/**
 * Write a build that passed its guards (point 2: compute, guard, then write): the undo copy
 * first, then the slots the command changed, then the record files (each atomically), then
 * build.json last. Building again with nothing changed writes no file.
 */
export async function writeBuiltCatalog(
  b: Build,
  o: {
    target?: CatalogTarget;
    undoDir: string;
    command: string;
    slots?: readonly SlotWrite[];
    guard: GuardResult;
    now?: Date;
    /** The target's record files as read already (buildAndWrite reads them once). */
    onDisk?: DiskFiles;
  },
): Promise<WriteResult> {
  if (o.guard.refused) throw new Error("writeBuiltCatalog: the build was refused");
  const root = b.root;
  const target = o.target ?? baselineTarget(root);
  const manifestText = serializeBuildManifest(manifestAt(b, target));
  const slots = [...(o.slots ?? [])];
  if (b.legacyJoins !== undefined && !slots.some((s) => s.path === legacyJoinsPath(root)))
    slots.push({ path: legacyJoinsPath(root), text: b.legacyJoins });
  // What changes: each record file, each slot, build.json.
  const onDisk = o.onDisk ?? (await hashFiles(target.generated));
  const touched: { path: string; text: string | null }[] = [];
  for (const [p, text] of b.files)
    if (onDisk.get(p)?.text !== text)
      touched.push({ path: join(target.generated, ...p.split("/")), text });
  for (const p of onDisk.keys())
    if (!b.files.has(p))
      touched.push({ path: join(target.generated, ...p.split("/")), text: null });
  for (const s of slots) touched.push(s);
  touched.push({ path: target.manifest, text: manifestText });
  const undo = await takeUndoCopy(root, o.undoDir, o.command, touched, {
    nextManifest: manifestText,
    ...(o.now ? { now: o.now } : {}),
  });
  const wrote: string[] = [];
  for (const s of slots) {
    const cur = await readText(s.path);
    if (s.text === null) {
      if (cur !== undefined) {
        await rm(s.path, { force: true });
        if (!s.input) wrote.push(relOf(root, s.path));
      }
    } else if (cur !== s.text) {
      await writeFileAtomic(s.path, s.text);
      if (!s.input) wrote.push(relOf(root, s.path));
    }
  }
  const crash = buildWriteHooks.crash;
  buildWriteHooks.crash = undefined;
  if (crash === "after-slots") throw new BuildCrash(crash);
  if (crash === "mid-records") {
    const records = touched.filter(
      (t) => t.text !== null && t.path.startsWith(target.generated) && t.path !== target.manifest,
    );
    for (const t of records.slice(0, Math.ceil(records.length / 2)))
      await writeFileAtomic(t.path, t.text!);
    throw new BuildCrash(crash);
  }
  const w = await writeCatalog(target.generated, b.records, { texts: b.files, onDisk });
  await rm(curatedEditsPathOf(o.undoDir), { force: true });
  if ((await readText(target.manifest)) !== manifestText)
    await writeFileAtomic(target.manifest, manifestText);
  return {
    ...w,
    slots: wrote.sort(cmpText),
    ...(undo !== undefined ? { undo } : {}),
    removals: o.guard.removals,
    discarded: o.guard.edits,
  };
}

export interface UndoPlan {
  /** The copies taken back, newest first. */
  copies: UndoEntry[];
  /** Each file and what it goes back to. */
  files: { path: string; to: "file" | "absent"; from: number }[];
}

/**
 * What `atticus catalog undo [<n>]` would restore: the n latest builds taken back, in order (1,
 * the default, is the latest; up to the five kept), so the files are as they were before the
 * n-th latest.
 */
export async function planUndo(undoDir: string, n = 1): Promise<UndoPlan | { problem: string }> {
  const list = await listUndo(undoDir);
  if (!list.length)
    return {
      problem:
        "There is nothing to undo: no build has been written here yet (undo copies are kept on this machine only).",
    };
  if (!Number.isInteger(n) || n < 1 || n > list.length)
    return {
      problem: `There ${list.length === 1 ? "is 1 build" : `are ${list.length} builds`} to undo here; undo takes back 1 to ${list.length} of them.`,
    };
  const copies = list.slice(0, n);
  const files = new Map<string, { path: string; to: "file" | "absent"; from: number }>();
  // The oldest copy that touched a file knows what it was before them all.
  for (const c of [...copies].reverse())
    for (const f of c.files)
      if (!files.has(f.path)) files.set(f.path, { path: f.path, to: f.before, from: c.n });
  return { copies, files: [...files.values()].sort((a, b) => cmpText(a.path, b.path)) };
}

/** Restore what a plan lists, keeping what it replaces as a new undo copy (an undo can be undone). */
export async function applyUndo(
  root: string,
  undoDir: string,
  plan: UndoPlan,
  command: string,
  now?: Date,
): Promise<{ restored: string[]; undo?: number }> {
  const target: { path: string; text: string | null; raw: Buffer | null }[] = [];
  for (const f of plan.files) {
    const abs = join(root, ...f.path.split("/"));
    // The bytes the copy kept, as they were written (a CRLF file stays CRLF).
    const raw =
      f.to === "absent"
        ? null
        : ((await readFile(join(undoDir, String(f.from), "files", ...f.path.split("/"))).catch(
            () => undefined,
          )) ?? null);
    target.push({
      path: abs,
      text: raw === null ? null : raw.toString("utf8").replace(/\r\n?/g, "\n"),
      raw,
    });
  }
  const undo = await takeUndoCopy(root, undoDir, command, target, now ? { now } : {});
  const restored: string[] = [];
  for (const t of target) {
    const cur = await readFile(t.path).catch(() => undefined);
    if (t.raw === null ? cur === undefined : cur?.equals(t.raw)) continue;
    if (t.raw === null) await rm(t.path, { force: true });
    else await writeFileAtomic(t.path, t.raw);
    restored.push(relOf(root, t.path));
  }
  await pruneEmptyDirs(generatedDirOf(root));
  return { restored, ...(undo !== undefined ? { undo } : {}) };
}

/**
 * Put back what the undo copies of a failed write list, and take those copies away (ADR 0195
 * point 2: a command that fails part way changes nothing; `atticus repo rename` uses it). Every
 * copy newer than `after` (the newest copy's number before the write began) is undone, newest
 * first: each file goes back to the bytes it had, and a file that wasn't there is removed. A copy
 * cut short before its undo.json was written goes too: nothing had been written after it.
 */
export async function rollBackUndo(
  root: string,
  undoDir: string,
  after: number,
): Promise<{ restored: string[] }> {
  const restored = new Set<string>();
  for (const c of await listUndo(undoDir)) {
    if (c.n <= after) continue;
    for (const f of [...c.files, ...(c.inputs ?? [])]) {
      const abs = join(root, ...f.path.split("/"));
      if (f.before === "absent") await rm(abs, { force: true });
      else {
        const raw = await readFile(join(undoDir, String(c.n), "files", ...f.path.split("/")));
        await writeFileAtomic(abs, raw);
      }
      restored.add(f.path);
    }
    await rm(join(undoDir, String(c.n)), { recursive: true, force: true });
  }
  for (const n of await readdir(undoDir).catch(() => [] as string[]))
    if (/^\d+$/.test(n) && Number(n) > after && !existsSync(join(undoDir, n, "undo.json")))
      await rm(join(undoDir, n), { recursive: true, force: true });
  await pruneEmptyDirs(generatedDirOf(root));
  return { restored: [...restored].sort(cmpText) };
}

async function pruneEmptyDirs(dir: string): Promise<void> {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => []))
    if (e.isDirectory()) {
      const d = join(dir, e.name);
      await pruneEmptyDirs(d);
      if (!(await readdir(d).catch(() => ["x"])).length)
        await rm(d, { recursive: true, force: true });
    }
}

/** Every file of a folder, for the upgrade's copy and prune's list. */
export async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string) {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out.push(p);
    }
  }
  await walk(dir);
  return out.sort(cmpText);
}

export async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

export { short as shortCommit };

// ------------------------------------------------------------------ one writer's path

/** The slots on disk with a command's writes in their place (what the build reads before they are written). */
export function slotsAfter(root: string, on: BuildSlots, writes: readonly SlotWrite[]): BuildSlots {
  const readers = new Map(on.readers);
  const facts = new Map(on.facts);
  let legacy = on.legacy;
  const dir = sourcesDirOf(root);
  const factsTexts = new Map<string, { facts?: string | null; meta?: string | null }>();
  for (const w of writes) {
    const rel = relOf(dir, w.path);
    let m = /^readers\/(.+)\.json$/.exec(rel);
    if (m) {
      if (w.text === null) readers.delete(m[1]!);
      else readers.set(m[1]!, readersSlotRead(w.text, m[1]!));
      continue;
    }
    m = /^facts\/(.+?)(\.meta\.json|\.jsonl)$/.exec(rel);
    if (m) {
      const e = factsTexts.get(m[1]!) ?? {};
      if (m[2] === ".jsonl") e.facts = w.text;
      else e.meta = w.text;
      factsTexts.set(m[1]!, e);
      continue;
    }
    if (rel === "legacy/joins.json") {
      if (w.text === null) legacy = undefined;
      else {
        const p = parseLegacyJoins(w.text);
        legacy = p.ok
          ? { slot: p.slot, sha: sha(w.text) }
          : { problem: `doesn't read (${p.issues[0]?.message ?? "invalid"})` };
      }
    }
  }
  return { readers, facts, ...(legacy ? { legacy } : {}), pending: factsTexts } as BuildSlots & {
    pending: typeof factsTexts;
  };
}

/**
 * The two files of a repo's facts snapshot (ADR 0195 point 1) as a command writes them: the kept
 * facts, then the meta with their hash, at the commit verify checked.
 */
export function factsSnapshotWrites(
  root: string,
  repo: string,
  facts: readonly import("@maycombhq/core").Fact[],
  o: { commit: string; contracts: ContractsFileT | null },
): SlotWrite[] {
  const p = factsSlotPaths(root, repo);
  const text = serializeFactsSnapshot(facts);
  return [
    { path: p.facts, text },
    {
      path: p.meta,
      text: serializeFactsSlotMeta({
        slotVersion: SLOT_VERSION,
        kind: "facts",
        repo,
        commit: o.commit,
        factsSchemaVersion: FACTS_SCHEMA_VERSION,
        factsHash: sha(text),
        contracts: o.contracts,
      }),
    },
  ];
}

/** The slots on disk with a command's writes in their place, its facts snapshots read whole. */
export async function withSlotWrites(
  root: string,
  on: BuildSlots,
  writes: readonly SlotWrite[],
): Promise<BuildSlots> {
  return withFactsWrites(root, slotsAfter(root, on, writes));
}

/** The facts slots with a command's snapshot writes put in (each read with its other file from disk when not written). */
async function withFactsWrites(root: string, s: BuildSlots): Promise<BuildSlots> {
  const pending = (
    s as BuildSlots & {
      pending?: Map<string, { facts?: string | null; meta?: string | null }>;
    }
  ).pending;
  if (!pending?.size) return s;
  const facts = new Map(s.facts);
  for (const [repo, e] of pending) {
    const p = factsSlotPaths(root, repo);
    const text = e.facts !== undefined ? (e.facts ?? undefined) : await readText(p.facts);
    const meta = e.meta !== undefined ? (e.meta ?? undefined) : await readText(p.meta);
    const f = factsSlotOf(repo, text, meta);
    if (f) facts.set(repo, f);
    else facts.delete(repo);
  }
  return { readers: s.readers, facts, ...(s.legacy ? { legacy: s.legacy } : {}) };
}

export interface BuildAndWrite {
  build: Build;
  guard: GuardResult;
  /** Undefined when refused, or with `check`. */
  write?: WriteResult;
  /** With `check`: whether catalog/generated is what the slots build. */
  upToDate?: boolean;
}

/**
 * Every writer's path (ADR 0195 point 2: "update my slot, then build"): the build with the
 * command's slot writes in place of what is on disk, the guards, and only then the write (the
 * undo copy, the slots, the records, build.json). A refused build writes nothing, no slot either.
 * The caller holds the scan's lock.
 */
export async function buildAndWrite(
  root: string,
  o: {
    command: string;
    slots?: readonly SlotWrite[];
    op?: OrgPack;
    curated?: CatalogRecord[];
    allowRemovals?: number;
    discardEdits?: number;
    /** `catalog build --check`: build and compare, write nothing. */
    check?: boolean;
    /** A build already made (a scan's), with these slot writes in it. */
    build?: Build;
    target?: CatalogTarget;
    inputsDir?: string | null;
    federated?: { id: string; dir: string }[];
    now?: Date;
  },
): Promise<BuildAndWrite> {
  const pack = await packOf(root);
  const undoDir = buildUndoDirOf(root, pack.stateDir);
  const build =
    o.build ??
    (await buildCatalog(
      await loadBuildInputs(root, {
        ...(o.op ? { op: o.op } : {}),
        ...(o.curated ? { curated: o.curated } : {}),
        ...(o.inputsDir !== undefined ? { inputsDir: o.inputsDir } : {}),
        ...(o.federated ? { federated: o.federated } : {}),
      }).then(async (i) => ({
        ...i,
        slots: await withFactsWrites(root, slotsAfter(root, i.slots, o.slots ?? [])),
      })),
    ));
  // The target's record files, read once for the guards, the report and the write.
  const onDisk = await hashFiles((o.target ?? baselineTarget(root)).generated);
  const guard = await guardBuild(build, {
    undoDir,
    command: o.command,
    onDisk,
    ...(o.target ? { target: o.target } : {}),
    ...(o.allowRemovals !== undefined ? { allowRemovals: o.allowRemovals } : {}),
    ...(o.discardEdits !== undefined ? { discardEdits: o.discardEdits } : {}),
  });
  if (o.check) {
    const target = o.target ?? baselineTarget(root);
    const same =
      onDisk.size === build.files.size &&
      [...build.files].every(([p, t]) => onDisk.get(p)?.sha === sha(t)) &&
      (await readText(target.manifest)) === serializeBuildManifest(manifestAt(build, target));
    return { build, guard, upToDate: same };
  }
  const report = await buildReportOf(root, build, guard, {
    onDisk,
    command: o.command,
    target: o.target ?? baselineTarget(root),
    ...(o.now ? { now: o.now } : {}),
  });
  if (guard.refused) {
    await writeBuildReport(undoDir, report);
    return { build, guard };
  }
  let write: WriteResult;
  try {
    write = await writeBuiltCatalog(build, {
      undoDir,
      command: o.command,
      guard,
      onDisk,
      ...(o.slots ? { slots: o.slots } : {}),
      ...(o.target ? { target: o.target } : {}),
      ...(o.now ? { now: o.now } : {}),
    });
  } catch (e) {
    await writeBuildReport(undoDir, {
      ...report,
      outcome: "stopped",
      stopped: e instanceof Error ? e.message : String(e),
      run: ["atticus catalog build"],
    }).catch(() => undefined);
    throw e;
  }
  const changedNothing = write.written === 0 && write.removed === 0 && write.slots.length === 0;
  await writeBuildReport(undoDir, {
    ...report,
    outcome: changedNothing ? "unchanged" : "written",
    counts: { ...report.counts, written: write.written, unchanged: write.unchanged },
    slots: write.slots,
    ...(write.undo !== undefined ? { undo: write.undo } : {}),
    ...(write.discarded.length ? { discarded: write.discarded } : {}),
  });
  return { build, guard, write };
}

/** A record file a build adds or changes, as its report lists it. */
export interface BuildReportFile {
  /** Relative to the root (catalog/generated/<kind>/<id>.yaml). */
  path: string;
  kind: string;
  id: string;
}

/**
 * What the latest build did or refused (CS3: the app shows it after any writer, a terminal
 * command's included). Written by `buildAndWrite` on every build but a check, at
 * `.index/build-report.json` in the state folder, beside the undo copies; read with
 * `readBuildReport`. Local to this machine, like the undo copies, and never committed.
 */
export interface BuildReport {
  version: 1;
  /** When the build ran (ISO). */
  at: string;
  /** The command that built, as the writer named it (`atticus scan`, `atticus verify x --write`). */
  command: string;
  /** The catalog folder built, relative to the root (a branch's for `scan --ref`). */
  generated: string;
  /**
   * `written`: the build changed files; `unchanged`: it had nothing to change; `refused`: a guard
   * refused it and nothing was written; `stopped`: the write threw part way (an undo copy holds
   * what it replaced; the next build finishes it).
   */
  outcome: "written" | "unchanged" | "refused" | "stopped";
  /** The refusal, with its reasons, message and lists, when refused. */
  refused?: BuildRefusal;
  /** The error a stopped write threw. */
  stopped?: string;
  /** The commands that go on from here, the first the one to suggest; none when nothing waits. */
  run: string[];
  counts: {
    /** Record files the build makes. */
    records: number;
    added: number;
    changed: number;
    removed: number;
    /** Files written and left as they were (a written build's; 0 otherwise). */
    written: number;
    unchanged: number;
  };
  /** Against catalog/generated as it was before the build (for a refusal, what it would do). */
  added: BuildReportFile[];
  changed: BuildReportFile[];
  /** Every removal, with why (for a refusal, those it would make, unexplained ones included). */
  removed: Removal[];
  /** The slot files written or removed. */
  slots: string[];
  /** The undo copy a written build took. */
  undo?: number;
  /** Hand edits a confirmed discard replaced. */
  discarded?: HandEdit[];
}

/** Where the latest build's report is (beside the undo copies, in the state folder's .index). */
export const buildReportPathOf = (undoDir: string) => join(dirname(undoDir), "build-report.json");

/** The latest build's report, or undefined when no build has run here (or it doesn't read). */
export async function readBuildReport(root: string): Promise<BuildReport | undefined> {
  const t = await readText(buildReportPathOf(await undoDirOf(root)));
  if (!t) return undefined;
  try {
    const r = JSON.parse(t) as BuildReport;
    return r && r.version === 1 ? r : undefined;
  } catch {
    return undefined;
  }
}

/** Write a build's report (a scan that read nothing writes its own, through this). */
export async function writeBuildReport(undoDir: string, report: BuildReport): Promise<void> {
  const path = buildReportPathOf(undoDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, JSON.stringify(report, null, 2) + "\n");
}

/**
 * The report of a writer that refused before it built (a scan that read no repo in full): the
 * same shape, nothing added, changed or removed.
 */
export async function writeRefusedReport(
  root: string,
  command: string,
  refused: BuildRefusal,
  o: { now?: Date } = {},
): Promise<void> {
  await writeBuildReport(await undoDirOf(root), {
    version: 1,
    at: (o.now ?? new Date()).toISOString(),
    command,
    generated: relOf(root, generatedDirOf(root)),
    outcome: "refused",
    refused,
    run: refusalCommands(refused, command),
    counts: { records: 0, added: 0, changed: 0, removed: 0, written: 0, unchanged: 0 },
    added: [],
    changed: [],
    removed: [],
    slots: [],
  });
}

/** The commands that go on from a refusal: what confirms, curates, discards or upgrades. */
export function refusalCommands(r: BuildRefusal, command: string): string[] {
  if (r.reasons.includes("not-upgraded")) return ["atticus upgrade", "atticus upgrade --yes"];
  if (r.reasons.includes("unexplained-removals")) return ["atticus support bundle"];
  const allow = r.reasons.includes("large-removals")
    ? ` --allow-removals ${r.allowRemovals ?? 0}`
    : "";
  if (r.reasons.includes("hand-edits"))
    return [
      "atticus catalog edits --curate",
      `${command} --discard-edits ${r.discardEdits ?? 0}${allow}`,
    ];
  return allow ? [`${command}${allow}`] : [];
}

/** A build's report before it is written: what it adds, changes and removes against the disk. */
async function buildReportOf(
  root: string,
  b: Build,
  guard: GuardResult,
  o: { command: string; target: CatalogTarget; now?: Date; onDisk: DiskFiles },
): Promise<BuildReport> {
  const genRel = relOf(root, o.target.generated);
  const onDisk = o.onDisk;
  const byPath = new Map<string, CatalogRecord>();
  for (const r of b.records) byPath.set(recordPath(r), r);
  const file = (p: string): BuildReportFile => {
    const r = byPath.get(p);
    const [kind = "", rest = ""] = p.split("/");
    return {
      path: `${genRel}/${p}`,
      kind: r?.kind ?? kind,
      id: r?.id ?? rest.replace(/\.ya?ml$/, ""),
    };
  };
  const added: BuildReportFile[] = [];
  const changed: BuildReportFile[] = [];
  for (const [p, text] of [...b.files].sort(([a], [c]) => cmpText(a, c))) {
    const was = onDisk.get(p);
    if (!was) added.push(file(p));
    else if (was.sha !== sha(text)) changed.push(file(p));
  }
  const refused = guard.refused;
  const removed = refused
    ? [...(refused.removals ?? []), ...(refused.unexplained ?? [])].sort((a, c) =>
        cmpText(a.path, c.path),
      )
    : guard.removals;
  return {
    version: 1,
    at: (o.now ?? new Date()).toISOString(),
    command: o.command,
    generated: genRel,
    outcome: refused ? "refused" : "written",
    ...(refused ? { refused } : {}),
    run: refused ? refusalCommands(refused, o.command) : [],
    counts: {
      records: b.files.size,
      added: added.length,
      changed: changed.length,
      removed: removed.length,
      written: 0,
      unchanged: 0,
    },
    added,
    changed,
    removed,
    slots: [],
  };
}

/** The undo folder of a metarepo (its state folder's `.index/build-undo`). */
export async function undoDirOf(root: string): Promise<string> {
  return buildUndoDirOf(root, (await packOf(root)).stateDir);
}

/** What a build wrote or refused, in the words a person reads (the CLI and the Console). */
export function buildLines(root: string, r: BuildAndWrite): string[] {
  const genRel = relOf(root, generatedDirOf(root));
  if (r.guard.refused) return r.guard.refused.message.split("\n");
  const out: string[] = [];
  const w = r.write;
  if (w) {
    out.push(`${genRel}: ${w.written} written, ${w.unchanged} unchanged, ${w.removed} removed`);
    if (w.slots.length) out.push(`slots: ${w.slots.join(", ")}`);
    if (w.removals.length) {
      const by = new Map<string, number>();
      for (const x of w.removals)
        for (const repo of x.repos.length ? x.repos : ["no repo"])
          by.set(repo, (by.get(repo) ?? 0) + 1);
      out.push(
        `Removed ${w.removals.length} ${w.removals.length === 1 ? "record" : "records"} (${[...by].map(([k, n]) => `${n} of ${k}`).join(", ")}):`,
        ...w.removals
          .slice(0, 20)
          .map((x) => `  removed ${x.kind}/${x.id}: ${x.explainedBy.join("; ")}`),
        ...(w.removals.length > 20 ? [`  and ${w.removals.length - 20} more`] : []),
      );
    }
    if (w.discarded.length)
      out.push(
        `Discarded ${w.discarded.length} hand ${w.discarded.length === 1 ? "edit" : "edits"} (kept in the undo copy): ${w.discarded.map((e) => e.path).join(", ")}`,
      );
    if (w.undo !== undefined)
      out.push(`atticus catalog undo takes this back (undo copy ${w.undo}, on this machine).`);
  }
  for (const x of r.build.retired)
    out.push(
      `A legacy join was derived again and left catalog/sources/legacy/joins.json: ${x.kind}/${x.id}${x.fields.length ? ` (it differed in ${x.fields.join(", ")})` : ""}.`,
    );
  for (const x of r.build.orphaned)
    out.push(
      `${x.repo}: ${x.why === "archived" ? "archived" : "no longer in the manifests"}, so its slots aren't built from; they are kept (${x.files.join(", ")}). atticus catalog prune lists them to remove.`,
    );
  for (const d of r.build.orphanedDecisions)
    out.push(
      `The curated decision ${d} targets a record that isn't in the build; it is kept and applies again when its target returns.`,
    );
  return out;
}
