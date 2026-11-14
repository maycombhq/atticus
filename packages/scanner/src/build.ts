import { createHash } from "node:crypto";
import { constants as fsConstants, existsSync } from "node:fs";
import { copyFile, mkdir, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { featuresForScan } from "@maycombhq/features";
import { glossaryForScan } from "@maycombhq/glossary";
import {
  applyCurated,
  applyLinkEvidence,
  applySharedMaps,
  catalogDirOf,
  cmpText,
  copyFileAtomic,
  deserializeRecord,
  evidenceDirOf,
  evidenceRelOf,
  factIdPart,
  FACTS_SCHEMA_VERSION,
  factsDirOf,
  factsRelOf,
  joinSharedMaps,
  keptFilesMayHaveChanged,
  linkEvidenceOf,
  loadOrgPack,
  mergeCatalog,
  listQuestions,
  normalizePath,
  questionsRelOf,
  readSharedMaps,
  readTrafficFile,
  recordPath,
  DECLARED_CALLER,
  registrableDomain,
  serializeRecord,
  sharedDirOf,
  sharedRelOf,
  stripSharedMaps,
  writeFileAtomic,
  type CatalogRecord,
  type ContractsFileT,
  type CuratedProblem,
  type Fact,
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
  buildKeyOf,
  hitManifestText,
  isWrittenManifest,
  keepReaders,
  keptReaders,
  keepBuild,
  loadKept,
  loadReadersTrust,
  readersKeyOf,
  recordJsonKey,
  stageKept,
  textReused,
  type KeptTexts,
} from "./build-cache.js";
import {
  answerMissesOf,
  factsEstateAfterMerge,
  factsEstateRecords,
  factsEstateRecordsAsync,
  withFactsEstateJoins,
  withoutHeardListeners,
  type FactsEstateProjection,
  type FactsEstateRepo,
} from "./build-facts.js";
import {
  hostAliases,
  outsideProfileSystems as outsideProfileSystemsOf,
  targetsFromAnswers,
} from "./facts-catalog.js";
import { pairsOfText } from "./facts-scan.js";
import {
  forgetCatalogs,
  readCatalog,
  sortCatalogRecords,
  writeCatalog,
  type CatalogFilesRead,
} from "./files.js";
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
import { phaseClock } from "./build-phases.js";

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

/** Bytes with each CRLF and lone CR as LF: what `text.replace(/\r\n?/g, "\n")` does to text. */
function lfBytes(bytes: Buffer): Buffer {
  if (!bytes.includes(0x0d)) return bytes;
  const out = Buffer.allocUnsafe(bytes.length);
  let n = 0;
  for (let k = 0; k < bytes.length; k++) {
    const b = bytes[k]!;
    if (b === 0x0d) {
      out[n++] = 0x0a;
      if (bytes[k + 1] === 0x0a) k++;
    } else out[n++] = b;
  }
  return out.subarray(0, n);
}

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
  // A text file is hashed with its line ends as LF, so a Windows checkout (core.autocrlf)
  // records the hashes a Linux one does (ADR 0195 point 2). Text is what git converts: a file
  // with no NUL, whatever its encoding (Latin-1 too), so the line ends are made LF in its bytes.
  // Valid UTF-8 hashes exactly as its LF text did (CR and LF are those bytes in UTF-8 alone);
  // a file with a NUL (a PDF, an image, which git doesn't convert) by its bytes as they are, so
  // bytes UTF-8 would read alike still differ.
  const putBytes = (r: string, bytes: Buffer) => {
    const lf = bytes.includes(0) ? bytes : lfBytes(bytes);
    lines.push(`${r}\u0000${createHash("sha256").update(lf).digest("hex")}`);
  };
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
      } else putBytes(r, await readFile(join(d, name)).catch(() => Buffer.alloc(0)));
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
  // A slot of these bytes read and checked before reads as it was then (the build cache's
  // projection, ADR 0195 point 9).
  const textSha = sha(text);
  const key = readersKeyOf(repo, textSha);
  const kept = keptReaders(key) as ReadersSlotT | undefined;
  if (kept) return { slot: kept, sha: textSha };
  const p = parseReadersSlot(text, repo);
  if (!p.ok) return { problem: `doesn't read (${p.issues[0]?.message ?? "invalid"})` };
  keepReaders(key, p.slot);
  return { slot: p.slot, sha: textSha };
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
  const mark = phaseClock("inputs: ");
  forgetKeptReads();
  const pack = await packOf(root);
  const orgPackDir = o.orgPackDir ?? pack.orgPackDir;
  const stateDir = o.stateDir ?? pack.stateDir;
  const op = o.op ?? (await loadOrgPack(orgPackDir));
  const problems: string[] = [];
  await loadReadersTrust(stateDir);
  mark("org pack");
  const onDisk = await readSlots(root);
  const slots = o.slots ? o.slots(onDisk) : onDisk;
  mark("read slots");
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
  mark("the other inputs");
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
  /**
   * Beta.27: retired because its caller is read from facts now and the estate join doesn't make
   * it (no derived record to differ from).
   */
  notJoined?: true;
  /**
   * The call that decided it (ADR 0195 addendum "a legacy join its caller's facts place
   * elsewhere"): the caller repo's call at `file:line` joined to an entry, or left to a system
   * outside the estate; or `gone`, no call at the arrow's caller line (`at`), or none with its
   * method and path (`call`) in a complete read; or `guess` (beta.27.1), an arrow that cites no
   * line of its caller's, the caller's read complete.
   */
  call?: {
    repo: string;
    how: "joined" | "outside" | "gone" | "guess";
    at?: string;
    /** The entry or system it is joined or left to. */
    to?: string;
    /** For `gone` with no caller line: the arrow's method and path. */
    call?: string;
  };
}

/** The deciding call of a legacy join that left without being derived, in words. */
export function decidingCallWords(c: NonNullable<RetiredJoin["call"]>): string {
  if (c.how === "joined")
    return `${c.repo}'s call at ${c.at} is joined to ${c.to ?? "another entry"}`;
  if (c.how === "outside")
    return `${c.repo}'s call at ${c.at} is left to ${c.to}, outside the estate`;
  if (c.how === "guess")
    return `${c.call} was a guess with no line of ${c.repo}'s, and ${c.repo}'s read is complete`;
  return c.at
    ? `no call at ${c.at} in ${c.repo}'s read`
    : `no ${c.call} call in ${c.repo}'s complete read`;
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
  /**
   * Beta.28.1 (the review's B2): each legacy arrow end no slot names now, and the repos the
   * joins slot's inputs say it can be of (they had a slot at the upgrade and have none now).
   * The guard explains such an arrow's removal by them: their slot pruned, they are out of the
   * manifests (a rename rewrites the inputs, so a renamed repo isn't one of them).
   */
  unslottedEnds?: Map<string, string[]>;
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

/**
 * `ends` with each end of a legacy arrow that no slot names now, and no record holds, given the
 * repos it can be of: those the upgrade had a readers or facts slot of (the joins slot's
 * `inputs`) and that have none now. Its own slot gone (a prune of an orphaned slot), the end is
 * one of theirs.
 */
function withUnslottedEnds(
  ends: Map<string, string[]>,
  legacy: readonly CatalogRecord[],
  /** The ids of the records this build and the legacy slots hold: no repo's end to lose. */
  held: ReadonlySet<string>,
  inputs: Readonly<Record<string, string>>,
  slots: BuildSlots,
): Map<string, string[]> {
  const unslotted = new Set<string>();
  for (const path of Object.keys(inputs)) {
    const m = /^catalog\/sources\/(?:readers\/(.+)\.json|facts\/(.+)\.jsonl)$/.exec(path);
    const repo = m?.[1] ?? m?.[2];
    if (repo && !slots.readers.has(repo) && !slots.facts.has(repo)) unslotted.add(repo);
  }
  if (!unslotted.size) return ends;
  const repos = [...unslotted].sort(cmpText);
  const out = new Map(ends);
  for (const r of legacy) {
    if (r.kind !== "Interface") continue;
    const x = r as unknown as { from?: string; to?: string };
    // Beta.28.1 (seed 1542546636): an end is the repos the arrow's evidence names on its side
    // (the caller's for `from`, the callee's for `to`) among those, when it names any: an arrow
    // out of an archived repo isn't a join with another repo taken out of the manifests.
    const sideOf = (side: "caller" | "callee") => {
      const named = new Set(
        (r.evidence ?? []).filter((e) => e.side === side && e.repo).map((e) => e.repo!),
      );
      const mine = repos.filter((repo) => named.has(repo));
      return mine.length ? mine : repos;
    };
    for (const [end, side] of [
      [x.from, "caller"],
      [x.to, "callee"],
    ] as const)
      if (end && !out.has(end) && !held.has(end)) out.set(end, sideOf(side));
  }
  return out;
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
/**
 * Beta.28.1 ("nothing slow runs silently"): the build's passes in their order, as `onPass` names
 * them, so a command says where a long build is (`Building the catalog: pass 2 of 8, ...`).
 */
export const BUILD_PASSES = [
  "each repo's source",
  "the framework models and the estate join",
  "the merge, intake, features and the glossary",
  "link evidence and shared maps",
  "the legacy records",
  "the curated decisions",
  "each repo's flows and loose calls",
  "the record files and build.json",
] as const;

/**
 * Told as the build starts each pass (1-based, of BUILD_PASSES.length), and awaited: the caller
 * prints it, lets the line out and may stop the build there by throwing (nothing is written by
 * the build). It only listens: the build is the same with it or without it.
 */
export interface BuildProgress {
  onPass?: (pass: number, of: number, what: string) => void | Promise<void>;
  /**
   * Awaited where a long pass may give way (after each repo's projection, inside the estate join,
   * after each repo's flows): the caller lets its lines and heartbeat out there, and may stop the
   * build by throwing. It only listens: the build is the same with it or without it.
   */
  tick?: () => Promise<void>;
}

export async function buildCatalog(i: BuildInputs, progress: BuildProgress = {}): Promise<Build> {
  const { op, root } = i;
  const pass = async (n: number) => progress.onPass?.(n, BUILD_PASSES.length, BUILD_PASSES[n - 1]!);
  const mark = phaseClock("build: ");
  // The build cache (point 9): a build of the same inputs is the last build, kept whole; else
  // the last build's record texts are kept for the records that didn't change. A build with
  // federated catalogs isn't kept (their folders are read outside the inputs).
  const cacheKey = i.federated.length
    ? undefined
    : await buildKeyOf({
        inputs: i as unknown as Record<string, unknown>,
        slots: slotsKeyOf(i.slots),
        proposalsDir: join(dirname(i.curatedDir), "proposals"),
        orgPackDir: i.orgPackDir,
        wikis: op.sources.wikis,
      });
  const kept = await loadKept<Build>(i.stateDir, cacheKey?.key);
  mark("cache key and lookup");
  if (kept.hit) return kept.hit;
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
  await pass(1);
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
      // The repo's corrections as the inputs hold them (a command's pending write in place of
      // the file, a rename's included), not read from disk again.
      const corr = i.corrections.get(r.id);
      if (corr !== undefined) Object.assign(pairs, pairsOfText(corr, f.facts));
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

  mark("1 sources");
  // ---- 2. framework models, then the estate join over every facts slot at once
  await pass(2);
  const frameworks = await usableFrameworks(op, problems);
  let projection: FactsEstateProjection | undefined;
  let code: CatalogRecord[];
  if (factRepos.length) {
    projection = progress.tick
      ? await factsEstateRecordsAsync(op, factRepos, progress.tick)
      : factsEstateRecords(op, factRepos);
    mark("2 facts projection and estate join");
    code = applyPipelineModels([...readerRecords, ...projection.records], frameworks);
    mark("2 framework models");
    code = withFactsEstateJoins(code, op, projection);
    mark("2 joins applied");
  } else code = applyPipelineModels(readerRecords, frameworks);

  // ---- 3. the merge, intake, features, federation, the glossary
  await pass(3);
  const read = new Set(factRepos.filter((x) => x.facts.length > 0).map((x) => x.repo));
  const mergeInput = (records: CatalogRecord[]) =>
    estateMergeInput(op, estateRepos(op), [...records].sort(byKindId), undefined, read);
  let merged = mergeCatalog(mergeInput(code));
  mark("3 merge");
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
  mark("3 intake");
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
  mark("3 features");
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
  mark("3 federation and glossary");
  notes.push(...merged.notes, ...glossary.problems.map((p) => `glossary: ${p}`));
  records = [...glossary.records, ...fedRecords];

  // ---- 4. link evidence and shared maps, before the curated decisions (point 2.4)
  await pass(4);
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

  mark("4 link evidence and shared maps");
  // ---- 5. the legacy records, as they are, until a current source takes over (point 6)
  await pass(5);
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
  // Beta.28.1 (seed 1403991699): an orphaned slot is not built from (point 4) and prune may take
  // it, so a legacy arrow's end can't rest on it alone. An end no slot names now, and no record
  // of this build or the legacy slots holds (a profile's system is one), is a component
  // or system of a repo the upgrade had a slot of (the joins slot's `inputs`) and has none now:
  // when every such repo is gone (removed from the manifests or archived), the arrow leaves with
  // them, through the removal guard; when one may be live (unread for now), it stays (point 6).
  const goneEnds = legacySlot
    ? withUnslottedEnds(
        ends,
        [...legacyAll, ...legacySlot.slot.records],
        new Set([...records, ...legacyAll].map((r) => r.id)),
        legacySlot.slot.inputs,
        i.slots,
      )
    : ends;
  const unslottedEnds = new Map([...goneEnds].filter(([end]) => !ends.has(end)));
  // Beta.27 (a user's Map), narrowed by its review and as the owner approved it on 2026-11-12
  // (ADR 0195 addendum "a legacy join its caller's facts place elsewhere"): an adopted call
  // arrow (never a topic's or a queue's) leaves without being derived only when the facts read
  // of its caller places the call elsewhere, or shows it gone, and that read covers the arrow:
  // - its callers are the repos its caller evidence names (an end's component or system may
  //   name several; only one with no such evidence names its repo alone), each read from facts
  //   whose slot changed since the upgrade; every one must place the call;
  // - the read cites every file the arrow cites at that caller's end (a file no fact cites may
  //   be one a read in parts hasn't reached); an arrow with no code line there, or a line with
  //   no file, has no file to check, so the read must be complete (the meta's `readComplete`,
  //   verify's own verdict);
  // - every call of that read at the arrow's caller lines, or with its method and path, is
  //   placed: joined to an entry, or left to an outside system that no live repo still read
  //   from readers or legacy could be (a host in a domain its manifest lists, or its name);
  //   none left is the call gone from a file the read covers;
  // - its callee is no repo still read from readers or legacy: the join can't place a call
  //   with a repo whose facts it doesn't read.
  // A call the join couldn't place (a host no repo lists, a question open) keeps the arrow:
  // point 6, never dropped because the build can't derive it yet. Until the caller's slot
  // changes, the first build after the upgrade still changes nothing.
  const factsOf = new Map(factRepos.map((x) => [x.repo, x.facts] as const));
  const readWhole = new Set(
    factRepos.flatMap((x) => {
      const f = i.slots.facts.get(x.repo);
      return f?.ok && f.meta.readComplete ? [x.repo] : [];
    }),
  );
  const sinceUpgrade = (repo: string) =>
    !legacySlot || (used.get(repo) ?? []).some((x) => legacySlot.slot.inputs[x.path] !== x.sha256);
  // The live repos the join doesn't read (readers, legacy or no slot): their hosts' domains and
  // their names, which a call the join left outside the estate may be one of.
  const bareHost = (h: string) =>
    h
      .trim()
      .toLowerCase()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
      .replace(/[/?#].*$/, "")
      .replace(/:\d+$/, "")
      .replace(/^\*\./, "");
  const unreadHosts = new Set<string>();
  const unreadDomains = new Set<string>();
  const unreadNames = new Set<string>();
  /** The first label of each of those hosts (`ledger` of `ledger` or `ledger.forge.example`). */
  const unreadFirstLabels = new Set<string>();
  for (const r of repos) {
    if (factsOf.has(r.id)) continue;
    for (const n of [r.id, r.component, r.system, ...(r.modules ?? []).map((m) => m.component)])
      if (n) unreadNames.add(factIdPart(n));
    for (const h of [...(r.hosts ?? []), ...(r.modules ?? []).flatMap((m) => m.hosts ?? [])]) {
      const b = bareHost(h);
      unreadHosts.add(b);
      const d = registrableDomain(b);
      if (d) unreadDomains.add(d);
      const first = b.split(".")[0];
      if (first) unreadFirstLabels.add(first);
    }
  }
  const systemHosts = new Map(
    outsideProfileSystemsOf(op).map((x) => [factIdPart(x.id), hostAliases(x.aliases ?? [])]),
  );
  /** Whether a call left outside the estate may be to a repo the join doesn't read. */
  const unreadMayAnswer = (f: Fact, target: string): boolean => {
    const c = f as Fact & { host?: string; to?: string };
    const names = [target, c.to].flatMap((x) => (x ? [factIdPart(x)] : []));
    if (names.some((x) => unreadNames.has(x))) return true;
    const hosts = [target, c.host, ...(systemHosts.get(factIdPart(target)) ?? [])].flatMap((h) =>
      h ? [bareHost(h)] : [],
    );
    return hosts.some((h) => {
      const d = registrableDomain(h);
      if (unreadHosts.has(h) || (!!d && unreadDomains.has(d))) return true;
      // A host with no registrable domain (one label, `.svc`, `.svc.cluster.local`,
      // `name.namespace`) names a Service by its first label, which an unread repo may be.
      if (d) return false;
      const first = h.split(".")[0]!;
      return !!first && (unreadFirstLabels.has(first) || unreadNames.has(factIdPart(first)));
    });
  };
  // A call is placed unless it is still a loose end after the merge (the estate join or the
  // merge's hosts joined it, or its fact names its target), or left to an outside system (J2)
  // that a repo the join doesn't read may be.
  const looseNow = new Set(records.filter((r) => r.kind === "Unresolved").map((r) => r.id));
  const looseCalls = new Set(
    [...(projection?.per ?? new Map())].flatMap(([repo, x]) =>
      [...x.looseFact].flatMap(([u, fact]) => (looseNow.has(u) ? [`${repo}\u0000${fact}`] : [])),
    ),
  );
  const outsideTo = new Map(
    (projection?.whole.outside ?? []).map((o) => [`${o.call.repo}\u0000${o.call.fact}`, o.target]),
  );
  type CallerEv = { repo?: string; side?: string; source?: string; path?: string; line?: number };
  /** The entry a derived arrow joins a call to: the one citing the call's line at its caller. */
  const joinedTo = (repo: string, f: Fact): string | undefined => {
    for (const r of records) {
      if (r.kind !== "Interface") continue;
      const hit = (r.evidence as CallerEv[]).some(
        (e) =>
          e.side === "caller" &&
          e.repo === repo &&
          e.path === f.cite.file &&
          e.line === f.cite.line,
      );
      if (hit) return (r as unknown as { to?: string }).to;
    }
    return (f as Fact & { to?: string }).to;
  };
  const placed = (repo: string, f: Fact): NonNullable<RetiredJoin["call"]> | undefined => {
    const k = `${repo}\u0000${f.id}`;
    const at = `${f.cite.file}:${f.cite.line}`;
    const out = outsideTo.get(k);
    if (out !== undefined)
      return unreadMayAnswer(f, out) ? undefined : { repo, at, how: "outside", to: out };
    if (looseCalls.has(k)) return undefined;
    const to = joinedTo(repo, f);
    return { repo, at, how: "joined", ...(to ? { to } : {}) };
  };
  const callerReadNow = (r: CatalogRecord): RetiredJoin["call"] => {
    if (r.kind !== "Interface") return undefined;
    const x = r as unknown as {
      from?: string;
      to?: string;
      method?: string;
      normalizedPath?: string;
    };
    if (!x.method || r.via === "event-bus" || r.via === "mq") return undefined;
    const ev = r.evidence as CallerEv[];
    // Its callers: the repos its caller evidence names; else its end's one repo, if one.
    const named = [...new Set(ev.flatMap((e) => (e.side === "caller" && e.repo ? [e.repo] : [])))];
    const fromEnd = x.from ? (ends.get(x.from) ?? []) : [];
    const callers = named.length ? named : fromEnd.length === 1 ? fromEnd : [];
    if (!callers.length) return undefined;
    // Beta.27.1 (owner, 2026-11-12, ADR 0195 addendum "a guess never outlives a complete read"):
    // an adopted arrow that cites no code line at its caller's end is a guess (beta.26 paired it
    // by its path). A complete facts read of its caller is the whole truth of what that repo
    // calls, so once every caller is read from facts since the upgrade and the read is complete,
    // the guess leaves: the call it guessed is either derived (and takes the id) or, if the facts
    // can't place it, a question, never an arrow. No callee or path matching is needed for it.
    // A person's word is never a guess (the review): an asserted record, a declared caller or
    // any evidence a person gave keeps the rule below, as does an arrow with a line of any
    // source at a caller's end (a config or spec line is still a line of the caller's).
    const personal =
      r.confidence === "asserted" ||
      (r.flags ?? []).includes(DECLARED_CALLER) ||
      (r.evidence as { source?: string }[]).some((e) => e.source === "manual");
    const lineless = (repo: string) =>
      !ev.some((e) => e.side === "caller" && e.repo === repo && !!e.path);
    if (!personal && callers.every(lineless)) {
      if (!callers.every((repo) => factsOf.has(repo) && sinceUpgrade(repo) && readWhole.has(repo)))
        return undefined;
      const repo = [...callers].sort(cmpText)[0]!;
      return { repo, how: "guess", call: `${x.method} ${x.normalizedPath ?? ""}`.trim() };
    }
    // A callee still read from readers or legacy: the join can't place the call with it.
    const callees = [
      ...new Set(ev.flatMap((e) => (e.side === "callee" && e.repo ? [e.repo] : []))),
    ];
    const calleeRepos = callees.length ? callees : x.to ? (ends.get(x.to) ?? []) : [];
    if (calleeRepos.some((repo) => live.has(repo) && !factsOf.has(repo))) return undefined;
    let deciding: RetiredJoin["call"];
    for (const repo of [...callers].sort(cmpText)) {
      const facts = factsOf.get(repo);
      if (!facts || !sinceUpgrade(repo)) return undefined;
      const mine = ev.filter((e) => e.side === "caller" && e.repo === repo);
      const cited = new Set(
        facts.flatMap((f) => [f.cite.file, ...(f.cite.with ?? []).map((w) => w.file)]),
      );
      if (mine.some((e) => !!e.path && !cited.has(e.path))) return undefined;
      const lines = mine.filter((e) => e.source === "code" && !!e.path);
      // No file to check a read reached: only a complete read tells the call is gone.
      if ((!lines.length || mine.some((e) => !e.path)) && !readWhole.has(repo)) return undefined;
      const at = new Set(lines.map((e) => `${e.path}:${e.line}`));
      const calls = facts
        .filter(
          (f) =>
            f.kind === "call" &&
            (at.has(`${f.cite.file}:${f.cite.line}`) ||
              ((f.method ?? "").toUpperCase() === x.method &&
                normalizePath(f.path) === x.normalizedPath)),
        )
        .sort((a, b) => cmpText(a.id, b.id));
      const each = calls.map((f) => placed(repo, f));
      if (each.some((c) => !c)) return undefined;
      // Not gone while a call with its method is still loose in the files the arrow cites there
      // (or, with no file to check, anywhere in that read): it may be the arrow's call, moved or
      // written with another path.
      if (!each.length) {
        const files = new Set(lines.map((e) => e.path!));
        const loose = facts.some(
          (f) =>
            f.kind === "call" &&
            (f.method ?? "").toUpperCase() === x.method &&
            (!files.size || mine.some((e) => !e.path) || files.has(f.cite.file)) &&
            looseCalls.has(`${repo}\u0000${f.id}`),
        );
        if (loose) return undefined;
      }
      deciding ??= each[0] ?? {
        repo,
        how: "gone",
        ...(lines[0] ? { at: `${lines[0].path}:${lines[0].line}` } : {}),
        call: `${x.method} ${x.normalizedPath}`,
      };
    }
    return deciding;
  };
  // A live repo's legacy records, as they are; an arrow of one to a repo removed or archived
  // leaves with that repo (point 6), as a legacy join does.
  // (The whole-catalog passes read the legacy records as context, so theirs come back through
  // them: one no current source derives is taken out.)
  for (const r of legacyRecords) {
    const key = `${r.kind}/${r.id}`;
    if (callerReadNow(r) !== undefined) {
      if (!derivedKeys.has(key)) byKey.delete(key);
      continue;
    }
    if (!endsGone(r, goneEnds, live).length) byKey.set(key, r);
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
        repoOfEvidence(r).some((x) => !live.has(x)) || endsGone(r, goneEnds, live).length > 0;
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
      // Beta.27: an arrow out of a repo read from facts now, which the estate join doesn't make.
      const call = !derived || legacyCtx.has(key) ? callerReadNow(r) : undefined;
      if (call) {
        retired.push({ kind: r.kind, id: r.id, fields: [], notJoined: true, call });
        byKey.delete(key);
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
  const legacySlotKeys = new Set(
    (legacySlot ? legacySlot.slot.records : []).map((r) => `${r.kind}/${r.id}`),
  );
  // Beta.28.1 (seed 1539914139): the features pass folds only into a feature it detects. A
  // target the overlay alone keeps (a legacy feature no current source derives now) can't take
  // the folded feature's members, so the folded one is left out while the target is in the
  // catalog, as the alias says, whether the folded one is a legacy copy or derived again. (Its
  // legacy copy retiring must not bring it back on the next build.)
  const foldedInto = new Map<string, string[]>();
  for (const d of i.curated.records)
    if (d.kind === "CuratedDecision" && d.status === "current" && d.action === "alias")
      for (const v of Array.isArray(d.value) ? d.value : [d.value])
        if (typeof v === "string") foldedInto.set(v, [...(foldedInto.get(v) ?? []), d.target]);
  const overlaid = [...byKey.values()].filter(
    (r) =>
      !(legacySlot && isLegacyGone(r, legacySlotKeys, live, goneEnds)) &&
      !(
        foldedNow.has(r.id) &&
        legacyKeys.has(`${r.kind}/${r.id}`) &&
        !derivedKeys.has(`${r.kind}/${r.id}`)
      ),
  );
  const keptFeatures = new Set(
    overlaid.filter((r) => r.kind === "Capability" && !foldedNow.has(r.id)).map((r) => r.id),
  );
  records = overlaid.filter(
    (r) =>
      !(r.kind === "Capability" && (foldedInto.get(r.id) ?? []).some((t) => keptFeatures.has(t))),
  );

  mark("5 legacy");
  // ---- 6. the curated decisions, once, last
  await pass(6);
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
  mark("6 curated");

  // ---- per fact repo: flows, loose calls, the join about it
  await pass(7);
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
      await progress.tick?.();
    }
  }

  mark("per repo");
  // ---- the files and build.json
  await pass(8);
  const files = new Map<string, string>();
  /** Each file's record, by the hash of its JSON: what the cache keeps its text by. */
  const textKeys = new Map<string, string>();
  for (const r of out) {
    const path = recordPath(r);
    files.set(
      path,
      serializedOf(r, kept.texts, cacheKey !== undefined ? { textKeys, path } : undefined),
    );
  }
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
  mark("files and build.json");
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
  const build: Build = {
    root,
    records: out,
    files,
    manifest,
    sources,
    listed: [...listed].sort(cmpText),
    orphaned,
    ...(unslottedEnds.size ? { unslottedEnds } : {}),
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
  // Kept only when what the passes read themselves is still what the key hashed: a file changed
  // while they ran may be in the build or not, so the build is no build of either.
  if (cacheKey && (await cacheKey.unchanged()))
    stageKept(build, i.stateDir, cacheKey.key, textKeys);
  mark("kept");
  return build;
}

/** The slots as the cache's key reads them: each by the hash of its bytes, or its problem. */
function slotsKeyOf(s: BuildSlots): unknown {
  const rest: Record<string, unknown> = {};
  // `pending` (slotsAfter's facts texts, which withSlotWrites reads in) isn't read by the build.
  for (const k of Object.keys(s).sort(cmpText))
    if (k !== "readers" && k !== "facts" && k !== "legacy" && k !== "pending")
      rest[k] = (s as unknown as Record<string, unknown>)[k];
  return {
    readers: [...s.readers].map(([repo, x]) => [repo, "slot" in x ? x.sha : x]),
    facts: [...s.facts].map(([repo, f]) => [repo, f.ok ? [f.sha, f.metaSha] : f]),
    legacy: s.legacy ? ("slot" in s.legacy ? s.legacy.sha : s.legacy) : null,
    rest,
  };
}

/** The part of a build's shared-map join about one repo (ADR 0160), for its verify report. */
export function sharedAbout(b: Build, repo: string): SharedJoinResult | undefined {
  return b.shared ? sharedJoinAbout(b.shared, repo) : undefined;
}

/** A legacy record whose repos the manifests no longer list (or list archived): it leaves. */
function isLegacyGone(
  r: CatalogRecord,
  /** The legacy slot's records, by `kind/id`. */
  slotKeys: ReadonlySet<string>,
  live: Set<string>,
  ends: Map<string, string[]>,
): boolean {
  if (!slotKeys.has(`${r.kind}/${r.id}`)) return false;
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
function serializedOf(
  r: CatalogRecord,
  kept?: KeptTexts,
  keyed?: { textKeys: Map<string, string>; path: string },
): string {
  // JSON writes -0 as 0 and the YAML as -0: a record with a -0 is keyed apart (rare: a zero is
  // looked at again only when the JSON has one).
  let key = JSON.stringify(r);
  if (/[[:,]0[,\]}]/.test(key)) key = JSON.stringify(r, negZeroApart);
  // The hash the build cache keeps the text by (point 9: the last build's texts, on disk).
  let hashed: string | undefined;
  const hashOf = () => (hashed ??= recordJsonKey(key));
  if (keyed) keyed.textKeys.set(keyed.path, hashOf());
  const hit = SERIALIZED.get(key);
  if (hit !== undefined) {
    SERIALIZED.delete(key);
    SERIALIZED.set(key, hit);
    return hit;
  }
  let text = kept ? kept.get(hashOf()) : undefined;
  if (text !== undefined) textReused();
  else text = serializeRecord(r);
  SERIALIZED.set(key, text);
  if (SERIALIZED.size > SERIALIZED_MAX) SERIALIZED.delete(SERIALIZED.keys().next().value!);
  return text;
}
const SERIALIZED = new Map<string, string>();
const negZeroApart = (_k: string, v: unknown) => (v === 0 && Object.is(v, -0) ? "\u0000-0" : v);
const SERIALIZED_MAX = 20_000;

/** Forget the texts kept in this process (a test of the build cache on disk, alone). */
export function forgetSerializedTexts(): void {
  SERIALIZED.clear();
}

/**
 * The hash of a record file's text, `sha(text)`: build.json holds it already for every file the
 * build makes (by its path under catalog/generated), so the guards, the check and the report
 * don't hash each file again (ADR 0195 point 9). A text not the build's own is hashed.
 */
function fileShaOf(b: Build, path: string, text: string): string {
  let m = FILE_SHAS.get(b);
  if (!m) {
    m = new Map();
    const base = `${relOf(b.root, generatedDirOf(b.root))}/`;
    for (const f of b.manifest.files)
      if (f.path.startsWith(base)) m.set(f.path.slice(base.length), f.sha256);
    FILE_SHAS.set(b, m);
  }
  const h = b.files.get(path) === text ? m.get(path) : undefined;
  return h ?? sha(text);
}
const FILE_SHAS = new WeakMap<Build, Map<string, string>>();

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

/**
 * beta.28: the fields that say which thing a record is, whatever its id, for the kinds whose
 * fields can say it; a kind not listed is never matched. References are compared through the
 * components that came back under another id.
 */
const IDENTITY: Record<string, readonly string[]> = {
  Component: ["repo", "path", "type"],
  Interface: ["from", "to", "via", "direction", "method", "normalizedPath"],
  Endpoint: ["component", "endpointType", "method", "pathOrTopic"],
  Setting: ["component", "key", "env"],
  Table: ["dataStore", "name"],
  Column: ["table", "name"],
  GatewayRoute: ["proxy", "basepath", "env"],
  ObservabilityAsset: ["component", "assetKind", "name"],
};
const REFS = new Set(["from", "to", "component"]);

/** A record's identity as one string, or undefined when its kind has none to match by. */
function identityOf(
  r: CatalogRecord,
  rekeyed: ReadonlyMap<string, string>,
  fields: readonly string[] | undefined = IDENTITY[r.kind],
): string | undefined {
  if (!fields) return undefined;
  const x = r as unknown as Record<string, unknown>;
  const vals = fields.map((f) => {
    const v = x[f];
    if (typeof v !== "string" || !v) return "";
    return REFS.has(f) ? (rekeyed.get(v) ?? v) : v;
  });
  // A component is the same thing only where it is at a path; anything else needs a value.
  if (r.kind === "Component" ? !vals[1] : vals.every((v) => !v)) return undefined;
  return `${r.kind}\u0000${vals.join("\u0000")}`;
}

/** An arrow by its caller and what it calls, not where it goes. */
const CALL = ["from", "via", "direction", "method", "normalizedPath"] as const;

/**
 * beta.28: what each record of the last build that this build removes is to this build, when
 * that is known, as words by `<Kind>/<id>`: `comes back as <Kind>/<id>` where exactly one record
 * of the last build and exactly one of this build have its identity and they differ in id, or,
 * for an arrow, `its call goes to <to> now (Interface/<id>)` where exactly one arrow of each makes
 * the same call. Anything with more than one candidate on either side says nothing, so the words
 * don't depend on the order of the records.
 */
export function rekeyedWords(
  before: readonly CatalogRecord[],
  after: readonly CatalogRecord[],
): Map<string, string> {
  const key = (r: CatalogRecord) => `${r.kind}/${r.id}`;
  const was = new Set(before.map(key));
  const now = new Set(after.map(key));
  const gone = before.filter((r) => !now.has(key(r)));
  /** The record each identity is unique to, on one side (undefined where two share it). */
  const unique = (rs: readonly CatalogRecord[], k: (r: CatalogRecord) => string | undefined) => {
    const m = new Map<string, CatalogRecord | undefined>();
    for (const r of rs) {
      const i = k(r);
      if (i !== undefined) m.set(i, m.has(i) ? undefined : r);
    }
    return m;
  };
  const out = new Map<string, string>();
  const none = new Map<string, string>();
  // Components first: the others' references go through the components' new ids.
  const rekeyed = new Map<string, string>();
  const comps = (rs: readonly CatalogRecord[]) => rs.filter((r) => r.kind === "Component");
  const oldC = unique(comps(before), (r) => identityOf(r, none));
  const newC = unique(comps(after), (r) => identityOf(r, none));
  for (const r of comps(gone)) {
    const i = identityOf(r, none);
    const x = i === undefined ? undefined : newC.get(i);
    if (i === undefined || !x || oldC.get(i) !== r || was.has(key(x))) continue;
    rekeyed.set(r.id, x.id);
  }
  const oldK = unique(before, (r) => identityOf(r, rekeyed));
  const newK = unique(after, (r) => identityOf(r, rekeyed));
  const arrows = (rs: readonly CatalogRecord[]) => rs.filter((r) => r.kind === "Interface");
  const oldA = unique(arrows(before), (r) => identityOf(r, rekeyed, CALL));
  const newA = unique(arrows(after), (r) => identityOf(r, rekeyed, CALL));
  for (const r of gone) {
    const i = identityOf(r, rekeyed);
    const x = i === undefined ? undefined : newK.get(i);
    if (i !== undefined && x && oldK.get(i) === r && !was.has(key(x))) {
      out.set(key(r), `comes back as ${x.kind}/${x.id}`);
      continue;
    }
    if (r.kind !== "Interface") continue;
    const c = identityOf(r, rekeyed, CALL);
    const y = c === undefined ? undefined : newA.get(c);
    const to = (y as unknown as { to?: string } | undefined)?.to;
    if (c !== undefined && y && oldA.get(c) === r && !was.has(key(y)) && to)
      out.set(key(r), `its call goes to ${to} now (Interface/${y.id})`);
  }
  return out;
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
  return buildManifestOfText(await readText(path), undefined, path);
}

/**
 * build.json's text read: `mine`, when given, is the text this build writes (serialized from a
 * manifest, so it reads: its JSON is the manifest, unchecked; ADR 0195 point 9, a 40-repo
 * estate's build.json is large).
 */
function buildManifestOfText(
  text: string | undefined,
  mine?: string,
  /** Its path: a text the build cache says this code wrote there reads unchecked too. */
  path?: string,
): { manifest?: BuildManifestT; text?: string; problem?: string } {
  if (text === undefined) return {};
  if (mine !== undefined && text === mine)
    return { manifest: JSON.parse(text) as BuildManifestT, text };
  if (path !== undefined && isWrittenManifest(path, text))
    return { manifest: JSON.parse(text) as BuildManifestT, text };
  const p = parseBuildManifest(text);
  return p.ok
    ? { manifest: p.slot, text }
    : { text, problem: `doesn't read (${p.issues[0]?.message ?? "invalid"})` };
}

/** Every record file under a catalog folder, with the hash of its bytes (line endings aside). */
/**
 * A catalog folder's record files, by path under it: their text (LF) and its hash, and the
 * size and time (ms, floored) the file had when it was read (none: not known).
 */
type DiskFiles = Map<string, { sha: string; text: string; size?: number; mtimeMs?: number }>;

/**
 * Whether a read of the folder (`readCatalogWithFiles`) found every record file `onDisk` holds,
 * and no other, each with the size and time it has there: then a read of the files again would
 * get each record from the parse cache that read filled (it keys a parse by them), so that read's
 * records are what it would give (beta.28.1: the guards and the map read 97,000 files again).
 */
function sameFilesAs(read: CatalogFilesRead | undefined, dir: string, onDisk: DiskFiles): boolean {
  if (!read || read.dir !== resolve(dir) || read.files.size !== onDisk.size) return false;
  for (const [p, f] of onDisk) {
    const r = read.files.get(p);
    if (!r || f.size === undefined || r.size < 0) return false;
    if (r.size !== f.size || r.mtimeMs !== f.mtimeMs) return false;
  }
  return true;
}

async function hashFiles(dir: string): Promise<DiskFiles> {
  // The paths first, in the walk's order; then the files read many at once (beta.28.1: one at
  // a time, 100,000 record files took 15 s) and put in the map in that order.
  const paths: string[] = [];
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
      else if (/\.ya?ml$/.test(e.name)) paths.push(r);
    }
  }
  await walk(dir, "");
  const texts = new Array<string>(paths.length);
  const stats = new Array<{ size: number; mtimeMs: number }>(paths.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(READ_AT_ONCE, paths.length) }, async () => {
      for (let k = next++; k < paths.length; k = next++) {
        // Its size and time from the open file, as readFile itself looks them up.
        const fh = await open(join(dir, ...paths[k]!.split("/")), "r");
        try {
          const s = await fh.stat();
          stats[k] = { size: s.size, mtimeMs: Math.floor(s.mtimeMs) };
          texts[k] = (await fh.readFile("utf8")).replace(/\r\n?/g, "\n");
        } finally {
          await fh.close();
        }
      }
    }),
  );
  const out: DiskFiles = new Map();
  paths.forEach((r, k) => out.set(r, { sha: sha(texts[k]!), text: texts[k]!, ...stats[k]! }));
  return out;
}
/** How many files a build reads at once (a few dozen: well under any open-files limit). */
const READ_AT_ONCE = 32;

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
    /** The target's build.json as read already, and the one this build writes (buildAndWrite's). */
    manifests?: { onDisk: string | undefined; mine: string };
    /**
     * The target's records as the caller read them (under its lock), used in place of a read
     * of the files again when every file still has the size and time it had (`sameFilesAs`).
     */
    lastRead?: CatalogFilesRead;
  },
): Promise<GuardResult> {
  const mark = phaseClock("guards: ");
  const root = b.root;
  const target = o.target ?? baselineTarget(root);
  const genRel = relOf(root, target.generated);
  const last = o.manifests
    ? buildManifestOfText(o.manifests.onDisk, o.manifests.mine, target.manifest)
    : await readBuildManifest(target.manifest);
  const onDisk = o.onDisk ?? (await hashFiles(target.generated));
  mark("build.json read");
  /** The target's records now: the caller's read where it still holds, else read again. */
  const lastRecords = async (): Promise<readonly CatalogRecord[]> =>
    sameFilesAs(o.lastRead, target.generated, onDisk)
      ? o.lastRead!.records
      : (await readCatalog(target.generated, { cacheRoot: root, fresh: true })).records;
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
      if (want !== undefined && fileShaOf(b, p, want) === f.sha) continue;
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
  mark("hand edits");
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
      for (const r of await lastRecords()) oldRecords.set(recordPath(r), r);
    }
    mark("last build's records read");
    const repoGone = (repo: string) => !b.sources.some((s) => s.repo === repo);
    // Each repo's slot files as this build read them, with their hashes.
    const slotNow = new Map<string, { path: string; sha256: string }[]>();
    // Most files share their sources: each distinct one is looked at once.
    const sawNow = new Set<string>();
    for (const f of b.manifest.files)
      for (const x of f.sources) {
        const key = `${x.path}\u0000${x.sha256}`;
        if (sawNow.has(key)) continue;
        sawNow.add(key);
        const m = /sources\/(?:readers|facts)\/(.+?)(?:\.meta\.json|\.jsonl|\.json)$/.exec(x.path);
        if (!m) continue;
        const xs = slotNow.get(m[1]!) ?? [];
        if (!xs.some((y) => y.path === x.path)) xs.push(x);
        slotNow.set(m[1]!, xs);
      }
    // Each slot file as the last build read it.
    const slotThen = new Set<string>();
    const sawThen = new Set<string>();
    for (const f of last.manifest.files)
      for (const x of f.sources) {
        const key = `${x.path}\u0000${x.sha256}`;
        if (sawThen.has(key)) continue;
        sawThen.add(key);
        if (/sources\/(?:readers|facts)\//.test(x.path)) slotThen.add(key);
      }
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
    // Every `/<kind>/<id>.yaml` tail of the last build's paths, once (ADR 0195 point 9: a search
    // of the whole list for each arrow was quadratic). A path ends with `/${rel}` exactly when
    // one of its tails at a `/` is `rel`.
    const lastTails = new Set<string>();
    for (const f of last.manifest.files)
      for (let k = f.path.indexOf("/"); k >= 0; k = f.path.indexOf("/", k + 1))
        lastTails.add(f.path.slice(k + 1));
    for (const x of b.records) {
      if (x.kind !== "Interface" || lastTails.has(recordPath(x))) continue;
      const i = x as unknown as { from?: string; to?: string };
      for (const [a, z] of [
        [i.from, i.to],
        [i.to, i.from],
      ] as const)
        if (a && z) {
          const l = newArrowsOf.get(a);
          if (l) l.push(z);
          else newArrowsOf.set(a, [z]);
        }
    }
    // beta.28: the records this build adds (none of the last build's paths), by the identity of
    // what each is, so a removal can say what comes back in its place; and their count by repo.
    // Components first: an arrow or an endpoint is compared through the component's new id.
    const addedNow = b.records.filter((x) => !lastTails.has(recordPath(x)));
    const addedBy = new Map<string, number>();
    for (const x of addedNow)
      for (const repo of repoOfEvidence(x)) addedBy.set(repo, (addedBy.get(repo) ?? 0) + 1);
    // What each record removed is to this build, where that is known.
    const rekeyedTo = oldRecords.size
      ? rekeyedWords([...oldRecords.values()], b.records)
      : new Map<string, string>();
    // The repos this build reads from their facts snapshot.
    const fromFacts = new Set(b.sources.filter((x) => x.source === "facts").map((x) => x.repo));
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
      const unslotted = r ? endsGone(r, b.unslottedEnds ?? new Map(), liveNow) : [];
      for (const repo of new Set([
        ...repos,
        ...(r ? endsGone(r, oldEnds, liveNow) : []),
        ...unslotted,
      ]))
        if (repoGone(repo)) {
          const archived = b.listed.includes(repo);
          // A repo whose slots are kept (orphaned) was archived or taken out of the manifests; one
          // whose slots went with it was renamed, its slots written under the new name, unless
          // the joins slot's inputs still name it (a prune took its orphaned slot: B2).
          if (!archived && !b.orphaned.some((o) => o.repo === repo) && !unslotted.includes(repo)) {
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
      // A legacy join that left without being derived: the call its caller's facts read placed.
      const left = b.retired.find((x) => x.call && x.id === id && x.kind === (r?.kind ?? kind));
      if (left?.call) {
        why.add(
          left.call.how === "guess"
            ? `a guess no complete read backs: ${decidingCallWords(left.call)}`
            : `its caller's facts place the call elsewhere: ${decidingCallWords(left.call)}`,
        );
        kinds.add("slot");
      }
      // Only the estate's slots as a whole changed: a join with another repo no longer forms.
      // Only a record a join derives can rest on another repo's slot: an arrow, a loose end, a
      // feature or a term traced through several repos, or an id two repos' records collided on
      // (evidence from more than one). Any other record comes from its own repo's slot, so this
      // explains nothing of it (the review: it explained every removal).
      // Beta.28.1 (seed 1423954245): an input that changed too (a curated decision of another
      // record, pending) or the build is true of every record, so neither stands in for the
      // join's slot; a manifest entry, a curated decision of its own or another slot does.
      const joinDerived = !!r && (JOIN_DERIVED.has(r.kind) || repos.length > 1);
      if (estate && ![...kinds].some((k) => k !== "input" && k !== "build") && joinDerived) {
        why.add("another repo's slot changed (a join with it)");
        kinds.add("slot");
      }
      // beta.28: what the removal is to this record, first, beside what changed (true of every
      // record of the repo): the same thing back under another id, or no fact of the repo's read
      // that makes it. Only for a removal something explains already: never a bug's excuse.
      const own: string[] = [];
      if (why.size && r) {
        const back = rekeyedTo.get(`${r.kind}/${r.id}`);
        if (back) own.push(back);
        // Only where the repo's read changed and nothing else is why: not a removal an answer,
        // a curated decision or a call the join placed elsewhere makes, nor one a join derives.
        else if (!kinds.has("curated") && !left?.call && !JOIN_DERIVED.has(r.kind))
          for (const repo of repos)
            if (fromFacts.has(repo) && slotChanged(repo))
              own.push(`no fact of ${repo}'s read makes it`);
      }
      const order: RemovalReason[] = ["manifest", "archived", "curated", "slot", "input", "build"];
      const removal: Removal = {
        path: f.path,
        kind: r?.kind ?? kind ?? "",
        id,
        repos,
        explainedBy: [...own, ...[...why].sort(cmpText)],
        reasons: order.filter((k) => kinds.has(k)),
      };
      (removal.explainedBy.length ? removals : unexplained).push(removal);
    }
    mark("removals explained");
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
      // beta.28: beside each repo's count, what the same build adds for it: a read switched to
      // another source that keys its records otherwise removes and adds about as many.
      const per = big.map(
        ([repo, n]) =>
          `${n} of ${repo}'s ${had.get(repo) ?? 0}${addedBy.get(repo) ? `, and adds ${addedBy.get(repo)}` : ""}`,
      );
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
  const hadCode = emptyNow && last.manifest ? (await lastRecords()).some(fromCode) : false;
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
  files: { path: string; before: "file" | "absent"; after?: string | null }[];
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
  extra: {
    nextManifest?: string;
    now?: Date;
    /** Files as the caller read them already (LF; null: not there), by absolute path. */
    known?: ReadonlyMap<string, string | null>;
  } = {},
): Promise<number | undefined> {
  // The bytes as they are on disk (a Windows checkout's CRLF kept), compared as text.
  // `before` "copy": a file the caller read already, copied by the system, not read again
  // (beta.28.1: build.json, 180 MB at 60 repos).
  const changes: {
    path: string;
    before: Buffer | "copy" | null;
    after: string | null;
    input?: true;
  }[] = [];
  for (const t of touched) {
    // A file the caller read already that the command leaves as it is isn't read again.
    const next = t.text === null ? null : t.text.replace(/\r\n?/g, "\n");
    if (extra.known?.has(t.path)) {
      const was = extra.known.get(t.path) ?? null;
      if (was === next) continue;
      changes.push({
        path: t.path,
        before: was === null ? null : "copy",
        after: next === null ? null : sha(next),
        ...(t.input ? { input: t.input } : {}),
      });
      continue;
    }
    const raw = await readFile(t.path).catch(() => undefined);
    const cur = raw?.toString("utf8").replace(/\r\n?/g, "\n");
    if ((cur ?? null) === next) continue;
    changes.push({
      path: t.path,
      before: raw ?? null,
      // What the command leaves there (its LF-normalised hash), so an undo can tell a later
      // hand edit from the command's own bytes.
      after: next === null ? null : sha(next),
      ...(t.input ? { input: t.input } : {}),
    });
  }
  if (!changes.length) return undefined;
  const listed = (cs: typeof changes) =>
    cs
      .map((c) => ({
        path: relOf(root, c.path),
        before: c.before === null ? ("absent" as const) : ("file" as const),
        after: c.after,
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
      if (c.before !== "copy") await writeFile(to, c.before);
      else
        try {
          await copyFile(c.path, to, fsConstants.COPYFILE_FICLONE);
        } catch (e) {
          // Gone since the caller read it: there is nothing to put back, as a read would find.
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          c.before = null;
        }
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
    /** The target's build.json as read already, and the one this build writes (buildAndWrite's). */
    manifests?: { onDisk: string | undefined; mine: string };
  },
): Promise<WriteResult> {
  if (o.guard.refused) throw new Error("writeBuiltCatalog: the build was refused");
  const root = b.root;
  const target = o.target ?? baselineTarget(root);
  const manifestText = o.manifests?.mine ?? serializeBuildManifest(manifestAt(b, target));
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
    ...(o.manifests ? { known: new Map([[target.manifest, o.manifests.onDisk ?? null]]) } : {}),
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
  const manifestNow = o.manifests ? o.manifests.onDisk : await readText(target.manifest);
  if (manifestNow !== manifestText) {
    // beta.28.1: the undo copy's next-build.json holds these bytes already (written just now,
    // under the lock): build.json is a copy of it, made by the system, not written again.
    const next = undo !== undefined ? join(o.undoDir, String(undo), "next-build.json") : undefined;
    const same =
      next !== undefined &&
      (await stat(next).then(
        (s) => s.size === Buffer.byteLength(manifestText, "utf8"),
        () => false,
      ));
    if (same) await copyFileAtomic(next, target.manifest);
    else await writeFileAtomic(target.manifest, manifestText);
  }
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

/**
 * The files an undo would put back that were changed since the command it takes back wrote them
 * (a hand edit, or a write no undo copy covers): each file's bytes now against what the newest
 * copy touching it says it left. Copies from before this was recorded say nothing, and are
 * trusted. `atticus catalog undo` refuses over them where the build's own hand-edit guard can't
 * see (a catalog with no build.json: an undo that took back the upgrade).
 */
export async function undoHandEdits(root: string, plan: UndoPlan): Promise<string[]> {
  const left = new Map<string, string | null>();
  const seen = new Set<string>();
  for (const c of plan.copies)
    for (const f of c.files) {
      if (seen.has(f.path)) continue;
      seen.add(f.path);
      if (f.after !== undefined) left.set(f.path, f.after);
    }
  const out: string[] = [];
  for (const [path, after] of left) {
    const now = await readText(join(root, ...path.split("/")));
    if ((now === undefined ? null : sha(now)) !== after) out.push(path);
  }
  return out.sort(cmpText);
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
  o: {
    commit: string;
    contracts: ContractsFileT | null;
    /** verify's verdict that every source file is read or reviewed (the meta's readComplete). */
    readComplete?: boolean;
  },
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
        ...(o.readComplete ? { readComplete: true as const } : {}),
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
  /**
   * After a write, with `read`: catalog/generated's records as `readCatalog` reads them, where
   * that read still matched the files (beta.28.1: so the caller doesn't read 97,000 files again).
   */
  catalog?: CatalogRecord[];
  /** With `check`: whether catalog/generated is what the slots build. */
  upToDate?: boolean;
  /**
   * With `expect`: what this build lists (its guard without the counts) isn't the list the
   * confirm was of, so nothing was written; `guard` is what it lists now.
   */
  changed?: true;
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
    /**
     * The app's confirm of a list (the review of beta.27: a confirm is of the list shown): told
     * this build's guard without the counts, which is what a refusal of it lists, and false when
     * that isn't the list the page showed. Then nothing is written (a refusal's report of what it
     * lists now is, so the page can show it) and the result says `changed`. The caller holds the
     * lock, so no writer comes between this check and the write.
     */
    expect?: (listed: GuardResult) => boolean;
    /**
     * Beta.28.1: told each step as it starts (`build` when it builds, then `check`: the files on
     * disk read, `guard`, and `write` with the files it writes, last before anything is written),
     * and awaited. Throwing from it stops there; at `write` nothing is written yet. It only
     * listens. `onPass` is the build's own (BuildProgress).
     */
    onStep?: (s: {
      step: "build" | "check" | "guard" | "write";
      files?: number;
    }) => void | Promise<void>;
    onPass?: BuildProgress["onPass"];
    /**
     * The target's records as the caller read them under its lock (`readCatalogWithFiles`): the
     * guards use them, and the result's `catalog` is worked out from them, where every file
     * still has the size and time that read found (beta.28.1: one read of the catalog a write).
     */
    read?: CatalogFilesRead;
  },
): Promise<BuildAndWrite> {
  const pack = await packOf(root);
  const undoDir = buildUndoDirOf(root, pack.stateDir);
  if (!o.build) await o.onStep?.({ step: "build" });
  const mark = phaseClock("write: ");
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
      o.onPass ? { onPass: o.onPass } : {},
    ));
  // The target's record files and build.json, read once for the guards, the report and the
  // write, and the build.json this build writes, serialized once (ADR 0195 point 9).
  await o.onStep?.({ step: "check" });
  mark("build");
  const target = o.target ?? baselineTarget(root);
  const onDisk = await hashFiles(target.generated);
  mark("hash catalog on disk");
  const manifestOnDisk = await readText(target.manifest);
  const manifests = {
    onDisk: manifestOnDisk,
    // The last build, kept whole, with the build.json it wrote there: that text, not serialized again.
    mine:
      hitManifestText(build, target.manifest, manifestOnDisk) ??
      serializeBuildManifest(manifestAt(build, target)),
  };
  await o.onStep?.({ step: "guard" });
  const guard = await guardBuild(build, {
    undoDir,
    command: o.command,
    onDisk,
    manifests,
    ...(o.read ? { lastRead: o.read } : {}),
    ...(o.target ? { target: o.target } : {}),
    ...(o.allowRemovals !== undefined ? { allowRemovals: o.allowRemovals } : {}),
    ...(o.discardEdits !== undefined ? { discardEdits: o.discardEdits } : {}),
  });
  mark("guards");
  // The confirm's list worked out again here, under the caller's lock: the guard as a refusal
  // would list it (no counts), compared with what the page showed.
  if (o.expect && !o.check) {
    const counted = o.allowRemovals !== undefined || o.discardEdits !== undefined;
    const listed = counted
      ? await guardBuild(build, {
          undoDir,
          command: o.command,
          onDisk,
          manifests,
          ...(o.read ? { lastRead: o.read } : {}),
          ...(o.target ? { target: o.target } : {}),
        })
      : guard;
    if (!o.expect(listed)) {
      if (listed.refused) {
        const report = await buildReportOf(root, build, listed, {
          onDisk,
          command: o.command,
          target: o.target ?? baselineTarget(root),
          ...(o.now ? { now: o.now } : {}),
        });
        await writeBuildReport(undoDir, report);
      }
      return { build, guard: listed, changed: true };
    }
  }
  if (o.check) {
    const same =
      onDisk.size === build.files.size &&
      [...build.files].every(([p, t]) => onDisk.get(p)?.sha === fileShaOf(build, p, t)) &&
      manifests.onDisk === manifests.mine;
    return { build, guard, upToDate: same };
  }
  const report = await buildReportOf(root, build, guard, {
    onDisk,
    command: o.command,
    target: o.target ?? baselineTarget(root),
    ...(o.now ? { now: o.now } : {}),
  });
  mark("report");
  // The build cache keeps what these inputs build, written or refused (point 9).
  await keepBuild(build as unknown as Parameters<typeof keepBuild>[0], {
    path: target.manifest,
    text: manifests.mine,
  });
  mark("keep build");
  if (guard.refused) {
    await writeBuildReport(undoDir, report);
    return { build, guard };
  }
  await o.onStep?.({ step: "write", files: build.files.size });
  let write: WriteResult;
  try {
    write = await writeBuiltCatalog(build, {
      undoDir,
      command: o.command,
      guard,
      onDisk,
      manifests,
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
  mark("write catalog");
  const changedNothing = write.written === 0 && write.removed === 0 && write.slots.length === 0;
  await writeBuildReport(undoDir, {
    ...report,
    outcome: changedNothing ? "unchanged" : "written",
    counts: { ...report.counts, written: write.written, unchanged: write.unchanged },
    slots: write.slots,
    ...(write.undo !== undefined ? { undo: write.undo } : {}),
    ...(write.discarded.length ? { discarded: write.discarded } : {}),
  });
  const catalog = catalogAfterWrite(build, target, onDisk, o.read);
  return { build, guard, write, ...(catalog ? { catalog } : {}) };
}

/**
 * The target's records after the write, as `readCatalog` would read them, from the caller's read
 * (`buildAndWrite`'s `read`): the write leaves exactly the build's files there, so a file it
 * left as it was is the record that read had (its size and time unchanged), and a file it wrote
 * is the parse of the text it wrote. Undefined when that read doesn't match the files.
 */
function catalogAfterWrite(
  b: Build,
  target: CatalogTarget,
  onDisk: DiskFiles,
  read: CatalogFilesRead | undefined,
): CatalogRecord[] | undefined {
  if (!sameFilesAs(read, target.generated, onDisk)) return undefined;
  const out: CatalogRecord[] = [];
  for (const [p, text] of b.files) {
    // writeCatalog's own test of a file it leaves as it is.
    if (onDisk.get(p)?.text.replace(/\r\n?/g, "\n") === text) {
      const r = read!.files.get(p)!.record;
      if (r) out.push(r);
      continue;
    }
    const r = deserializeRecord(text);
    if (r.ok) out.push(r.record);
  }
  return sortCatalogRecords(out);
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
    else if (was.sha !== fileShaOf(b, p, text)) changed.push(file(p));
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
      x.notJoined
        ? `A legacy join left catalog/sources/legacy/joins.json: ${x.kind}/${x.id}. ${x.call?.how === "guess" ? `${decidingCallWords(x.call)}` : `Its caller is read from facts now, and ${x.call ? `they place the call elsewhere: ${decidingCallWords(x.call)}` : "they don't join it"}`}.`
        : `A legacy join was derived again and left catalog/sources/legacy/joins.json: ${x.kind}/${x.id}${x.fields.length ? ` (it differed in ${x.fields.join(", ")})` : ""}.`,
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
