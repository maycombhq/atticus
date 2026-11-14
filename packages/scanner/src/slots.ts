import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  canonicalize,
  catalogDirOf,
  cmpText,
  ContractsFile,
  factsDirOf,
  FACTS_SCHEMA_VERSION,
  parseFacts,
  parseRecord,
  RecordId,
  SCHEMA_VERSION,
  serializeFacts,
  staleCite,
  toCanonicalYaml,
  writeFileAtomic,
  type CatalogRecord,
  type ContractsFileT,
  type Fact,
} from "@maycombhq/core";
import { changesSince, type GitRunner } from "@maycombhq/workspace";

/**
 * Source slots (ADR 0195 point 1): what was last observed of each repo, committed in the
 * metarepo beside the catalog under `catalog/sources/`. The readers slot is a scan's full read
 * of a repo at a commit; the facts slot is the snapshot a successful `atticus verify <repo>
 * --write` takes of the repo's kept facts, with a meta that projects them without the clone;
 * the legacy joins slot holds what `atticus upgrade` adopted that no single repo owns. The
 * build manifest (`catalog/sources/build.json`) lists what the last build wrote, and the
 * cross-check's dismissals (`facts/<repo>.crosscheck.yaml`) what a person dismissed. These are
 * new formats, not contracts, versioned here. Every one is canonical (keys in a fixed order,
 * two-space indent, LF, one trailing newline) and holds no time, so the same observation writes
 * the same bytes, and reading a file and writing it again gives it back byte for byte.
 */

/** The version of the readers, facts and legacy joins slots. */
export const SLOT_VERSION = 1 as const;
/** The version of `catalog/sources/build.json`. */
export const BUILD_MANIFEST_VERSION = 1 as const;
/**
 * The build's own version (ADR 0195 point 4, review of CS1): bumped whenever the build's passes
 * change what the same slots and inputs give, so a removal an Atticus upgrade makes is explained
 * by it (`build.json`'s `buildVersion`).
 */
export const BUILD_VERSION = "2.0.0-beta.28.1";
/** The version of `facts/<repo>.crosscheck.yaml`. */
export const DISMISSALS_VERSION = 1 as const;

const SHA256 = z.string().regex(/^[0-9a-f]{64}$/, "a SHA-256, 64 lowercase hex digits");
/** A repo id as the manifests hold it (a record id's slug). */
const REPO = RecordId;
/** The commit read; a legacy slot's may be `unknown` (ADR 0195 point 6). */
const COMMIT = z.string().min(1);
/** A record of contract C1, in its own shape at its own schemaVersion; checked with parseRecord. */
const RECORD = z
  .record(z.string(), z.unknown())
  .describe("A catalog record of contract C1 (schema/catalog/<kind>.json), checked as one");
const PATH = z.string().min(1).describe("A metarepo-relative path, '/'-separated");

export const ReadersSlot = z
  .strictObject({
    slotVersion: z.literal(SLOT_VERSION),
    kind: z.literal("readers"),
    repo: REPO,
    commit: COMMIT,
    /** `read`: a full read. `legacy`: adopted by `atticus upgrade`. There is no partial. */
    status: z.enum(["read", "legacy"]),
    /** Each extractor that ran, sorted; none for a legacy slot (no reader ran). */
    extractors: z.array(z.strictObject({ id: z.string().min(1), version: z.string().min(1) })),
    /**
     * A hash of what steered the readers: the repo's scan settings, the rule files, the plugins
     * and their pins. Null for a legacy slot: nothing steered an adoption.
     */
    settings: SHA256.nullable(),
    /** The repo's records as the readers produced them, before the merge, sorted by kind then id. */
    records: z.array(RECORD),
  })
  .refine((s) => s.status === "legacy" || s.commit !== "unknown", {
    message: "a read slot names the commit it read",
    path: ["commit"],
  })
  .refine((s) => (s.status === "legacy") === (s.settings === null), {
    message: "a read slot has a settings hash, and a legacy slot has none (null)",
    path: ["settings"],
  })
  .refine((s) => s.status === "read" || s.extractors.length === 0, {
    message: "a legacy slot lists no extractors: no reader ran",
    path: ["extractors"],
  });
export type ReadersSlotT = Omit<z.infer<typeof ReadersSlot>, "records"> & {
  records: CatalogRecord[];
};

export const FactsSlotMeta = z.strictObject({
  slotVersion: z.literal(SLOT_VERSION),
  kind: z.literal("facts"),
  repo: REPO,
  commit: COMMIT,
  factsSchemaVersion: z.number().int().positive(),
  /** The SHA-256 of the snapshot's bytes (`<repo>.jsonl`). */
  factsHash: SHA256,
  /** The repo's `<repo>.contracts.yaml` as read at the facts' commit (ADR 0151), or null. */
  contracts: ContractsFile.nullable(),
  /**
   * Beta.27.2 (ADR 0195 addendum "a legacy join its caller's facts place elsewhere"): verify's
   * own verdict that the read is complete, every source file read or reviewed. Left out for a
   * read in parts (never false), so a meta written before it reads as one.
   */
  readComplete: z.literal(true).optional(),
});
export type FactsSlotMetaT = z.infer<typeof FactsSlotMeta>;

export const LegacyJoinsSlot = z.strictObject({
  slotVersion: z.literal(SLOT_VERSION),
  kind: z.literal("legacy-joins"),
  status: z.literal("legacy"),
  /** Records with evidence from several repos, or none, adopted at the upgrade; by kind then id. */
  records: z.array(RECORD),
  /** The hash of each slot and build input as it was at the upgrade, by its path. */
  inputs: z.record(PATH, SHA256),
});
export type LegacyJoinsSlotT = Omit<z.infer<typeof LegacyJoinsSlot>, "records"> & {
  records: CatalogRecord[];
};

const HASHED = z.strictObject({ path: PATH, sha256: SHA256 });
export const BuildManifest = z.strictObject({
  version: z.literal(BUILD_MANIFEST_VERSION),
  /** The build that wrote it (`BUILD_VERSION`): a change of it explains a removal. */
  buildVersion: z.string().min(1),
  /** Every file the last build wrote under catalog/generated/, with the sources it came from. */
  files: z.array(z.strictObject({ path: PATH, sha256: SHA256, sources: z.array(HASHED) })),
});
export type BuildManifestT = z.infer<typeof BuildManifest>;

export const CrossCheckDismissals = z.strictObject({
  version: z.literal(DISMISSALS_VERSION),
  /** Each dismissed cross-check item: its key, and the readers' value it was dismissed at. */
  dismissed: z.array(
    z.strictObject({
      key: z.string().min(1),
      // Required: the readers' value it was dismissed at (null when they found none).
      readers: z.unknown().refine((v) => v !== undefined, "the readers' value is required"),
    }),
  ),
});
export type CrossCheckDismissalsT = z.infer<typeof CrossCheckDismissals>;

export type SlotParse<T> =
  { ok: true; slot: T } | { ok: false; issues: { path: string; message: string }[] };

// ------------------------------------------------------------------ canonical form

const byKindThenId = (a: CatalogRecord, b: CatalogRecord) =>
  a.kind === b.kind ? cmpText(a.id, b.id) : cmpText(a.kind, b.kind);

/** A record as its canonical file holds it (serializeRecord's order and version), as JSON data. */
function recordData(r: CatalogRecord): unknown {
  return canonicalize(r.kind === "Flow" ? r : { ...r, schemaVersion: SCHEMA_VERSION });
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

const sortedRecords = (records: readonly CatalogRecord[]) =>
  [...records].sort(byKindThenId).map(recordData);

/** The readers slot as stored: its records and extractors sorted. */
export function readersSlotOf(s: ReadersSlotT): ReadersSlotT {
  return {
    ...s,
    extractors: [...s.extractors].sort((a, b) =>
      a.id === b.id ? cmpText(a.version, b.version) : cmpText(a.id, b.id),
    ),
    records: [...s.records].sort(byKindThenId),
  };
}

export function serializeReadersSlot(s: ReadersSlotT): string {
  const x = readersSlotOf(s);
  return json({
    slotVersion: x.slotVersion,
    kind: x.kind,
    repo: x.repo,
    commit: x.commit,
    status: x.status,
    extractors: x.extractors.map((e) => ({ id: e.id, version: e.version })),
    settings: x.settings,
    records: sortedRecords(x.records),
  });
}

export function serializeFactsSlotMeta(m: FactsSlotMetaT): string {
  return json({
    slotVersion: m.slotVersion,
    kind: m.kind,
    repo: m.repo,
    commit: m.commit,
    factsSchemaVersion: m.factsSchemaVersion,
    factsHash: m.factsHash,
    contracts: m.contracts === null ? null : canonicalize(m.contracts, ["schemaVersion"]),
    ...(m.readComplete ? { readComplete: true } : {}),
  });
}

/** The facts snapshot: the kept facts as verify writes them, one canonical line each, by id. */
export function serializeFactsSnapshot(facts: readonly Fact[]): string {
  return serializeFacts(facts);
}

export function serializeLegacyJoins(s: LegacyJoinsSlotT): string {
  return json({
    slotVersion: s.slotVersion,
    kind: s.kind,
    status: s.status,
    records: sortedRecords(s.records),
    inputs: Object.fromEntries(Object.entries(s.inputs).sort(([a], [b]) => cmpText(a, b))),
  });
}

export function serializeBuildManifest(m: BuildManifestT): string {
  return json({
    version: m.version,
    buildVersion: m.buildVersion,
    files: [...m.files]
      .sort((a, b) => cmpText(a.path, b.path))
      .map((f) => ({
        path: f.path,
        sha256: f.sha256,
        sources: [...f.sources]
          .sort((a, b) => cmpText(a.path, b.path))
          .map((s) => ({ path: s.path, sha256: s.sha256 })),
      })),
  });
}

export function serializeDismissals(d: CrossCheckDismissalsT): string {
  return toCanonicalYaml(
    {
      version: d.version,
      dismissed: [...d.dismissed]
        .sort((a, b) => cmpText(a.key, b.key))
        .map((x) => ({ key: x.key, readers: x.readers })),
    },
    ["version", "key", "readers"],
  );
}

// ------------------------------------------------------------------ reading

type Issue = { path: string; message: string };
const zodIssues = (e: z.ZodError): Issue[] =>
  e.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message }));

function parseJson(text: string): { ok: true; value: unknown } | { ok: false; issues: Issue[] } {
  try {
    // A Windows checkout (core.autocrlf) reads the same as the file written.
    const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    return { ok: true, value: JSON.parse(t.replace(/\r\n?/g, "\n")) };
  } catch (e) {
    return { ok: false, issues: [{ path: "", message: `not JSON: ${(e as Error).message}` }] };
  }
}

/** Each record parsed as C1; any that isn't is an issue, so a slot never hands on a bad record. */
function parseRecords(
  rows: readonly Record<string, unknown>[],
): { ok: true; records: CatalogRecord[] } | { ok: false; issues: Issue[] } {
  const records: CatalogRecord[] = [];
  const issues: Issue[] = [];
  rows.forEach((row, i) => {
    const p = parseRecord(row);
    if (p.ok) records.push(p.record);
    else
      for (const x of p.issues)
        issues.push({ path: `records.${i}${x.path ? `.${x.path}` : ""}`, message: x.message });
  });
  return issues.length ? { ok: false, issues } : { ok: true, records };
}

export function parseReadersSlot(text: string, repo?: string): SlotParse<ReadersSlotT> {
  const j = parseJson(text);
  if (!j.ok) return j;
  const s = ReadersSlot.safeParse(j.value);
  if (!s.success) return { ok: false, issues: zodIssues(s.error) };
  const r = parseRecords(s.data.records);
  if (!r.ok) return r;
  // The slot is one repo's (locality rests on it): its file's name, and every record's evidence.
  const issues: Issue[] = [];
  if (repo !== undefined && s.data.repo !== repo)
    issues.push({ path: "repo", message: `names ${s.data.repo}, but the file is ${repo}'s` });
  if (s.data.status === "read")
    r.records.forEach((rec, i) => {
      const other = rec.evidence.find((e) => e.repo !== undefined && e.repo !== s.data.repo);
      if (other)
        issues.push({
          path: `records.${i}.evidence`,
          message: `cites ${other.repo}, not the slot's repo ${s.data.repo}`,
        });
    });
  return issues.length
    ? { ok: false, issues }
    : { ok: true, slot: { ...s.data, records: r.records } };
}

/** A repo's readers slot as stored, checked against its file name and its records' evidence. */
export async function readReadersSlot(
  root: string,
  repo: string,
): Promise<SlotParse<ReadersSlotT> | undefined> {
  const text = await readFile(readersSlotPath(root, repo), "utf8").catch(() => undefined);
  return text === undefined ? undefined : parseReadersSlot(text, repo);
}

export function parseFactsSlotMeta(text: string): SlotParse<FactsSlotMetaT> {
  const j = parseJson(text);
  if (!j.ok) return j;
  const s = FactsSlotMeta.safeParse(j.value);
  return s.success ? { ok: true, slot: s.data } : { ok: false, issues: zodIssues(s.error) };
}

export function parseFactsSnapshot(
  text: string,
): { ok: true; facts: Fact[] } | { ok: false; issues: Issue[] } {
  const p = parseFacts(text.replace(/\r\n?/g, "\n"));
  if (!p.ok) return { ok: false, issues: p.issues.map((i) => ({ path: "", message: i.message })) };
  // A snapshot holds only facts this version reads: a newer kind is a newer snapshot.
  if (p.newer?.length)
    return {
      ok: false,
      issues: [{ path: "", message: "holds facts of a kind a newer Atticus wrote" }],
    };
  return { ok: true, facts: p.facts };
}

export function parseLegacyJoins(text: string): SlotParse<LegacyJoinsSlotT> {
  const j = parseJson(text);
  if (!j.ok) return j;
  const s = LegacyJoinsSlot.safeParse(j.value);
  if (!s.success) return { ok: false, issues: zodIssues(s.error) };
  const r = parseRecords(s.data.records);
  return r.ok ? { ok: true, slot: { ...s.data, records: r.records } } : r;
}

export function parseBuildManifest(text: string): SlotParse<BuildManifestT> {
  const j = parseJson(text);
  if (!j.ok) return j;
  const s = BuildManifest.safeParse(j.value);
  return s.success ? { ok: true, slot: s.data } : { ok: false, issues: zodIssues(s.error) };
}

export function parseDismissals(text: string): SlotParse<CrossCheckDismissalsT> {
  let data: unknown;
  try {
    data = parseYaml(text.replace(/\r\n?/g, "\n"));
  } catch (e) {
    return { ok: false, issues: [{ path: "", message: `not YAML: ${(e as Error).message}` }] };
  }
  const s = CrossCheckDismissals.safeParse(data);
  return s.success ? { ok: true, slot: s.data } : { ok: false, issues: zodIssues(s.error) };
}

/** JSON Schema for the slot formats, generated from their zod schemas (`atticus schema export`). */
export function slotJsonSchemas(): Record<string, object> {
  const files: Record<string, z.ZodType> = {
    ReadersSlot,
    FactsSlotMeta,
    LegacyJoinsSlot,
    BuildManifest,
    CrossCheckDismissals,
  };
  const out: Record<string, object> = {};
  for (const [name, schema] of Object.entries(files))
    out[name] = {
      $id: `https://maycombhq.github.io/atticus/schema/sources/v1/${name}.json`,
      title: name,
      ...z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }),
    };
  return out;
}

// ------------------------------------------------------------------ where they are

/** `catalog/sources`, relative to the root, '/'-separated (the layout's catalog folder). */
export function sourcesRelOf(root: string): string {
  return [...relative(root, catalogDirOf(root)).split(sep), "sources"].filter(Boolean).join("/");
}

export function sourcesDirOf(root: string): string {
  return join(catalogDirOf(root), "sources");
}

export function readersSlotPath(root: string, repo: string): string {
  return join(sourcesDirOf(root), "readers", `${repo}.json`);
}

export function factsSlotPaths(root: string, repo: string): { facts: string; meta: string } {
  return {
    facts: join(sourcesDirOf(root), "facts", `${repo}.jsonl`),
    meta: join(sourcesDirOf(root), "facts", `${repo}.meta.json`),
  };
}

export function legacyJoinsPath(root: string): string {
  return join(sourcesDirOf(root), "legacy", "joins.json");
}

export function buildManifestPath(root: string): string {
  return join(sourcesDirOf(root), "build.json");
}

export function dismissalsPath(root: string, repo: string): string {
  return join(factsDirOf(root), `${repo}.crosscheck.yaml`);
}

// ------------------------------------------------------------------ writing

export const sha256Of = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

/** Write a slot file whole (by rename) unless it already holds these bytes, line endings aside. */
export async function writeSlotFile(path: string, text: string): Promise<"written" | "unchanged"> {
  const current = await readFile(path, "utf8").catch(() => undefined);
  if (current?.replace(/\r\n?/g, "\n") === text) return "unchanged";
  await writeFileAtomic(path, text);
  return "written";
}

/** Why a scan has no observation of a repo: anything less than a full read writes nothing. */
export type NotObserved =
  | "not-cloned"
  | "unreadable"
  | "run-failed"
  | "not-asked"
  | "plugin-refused"
  | "readers-off"
  | "dirty";

/** What a scan observed of a production repo: its full read, as a slot, or why there is none. */
export type ReadersObservation =
  | { repo: string; full: true; slot: ReadersSlotT; factsStale?: FactsStaleness }
  | { repo: string; full: false; why: NotObserved; detail?: string; factsStale?: FactsStaleness };

/** One repo's readers slot after a scan (`atticus scan --json`'s `sources[].slot`). */
export interface ReadersSlotOutcome {
  repo: string;
  slot: "written" | "unchanged" | "kept-last-good" | "none";
  /** The commit the slot on disk is of (written, unchanged or kept). */
  commit?: string;
  /** Why it kept its last good read, or has none: a NotObserved, `refused` or `dry-run`. */
  reason?: NotObserved | "refused" | "dry-run";
  detail?: string;
}

/**
 * The readers slots a scan writes (ADR 0195 point 1): each repo read in full, at its commit;
 * every other repo's slot is left byte for byte, its last good read kept. With `hold` the scan
 * writes nothing (a refused scan, a dry run), and says each slot kept why.
 */
export async function writeReadersSlots(
  root: string,
  observations: readonly ReadersObservation[],
  o: { hold?: "refused" | "dry-run" } = {},
): Promise<ReadersSlotOutcome[]> {
  const out: ReadersSlotOutcome[] = [];
  for (const x of observations) {
    const path = readersSlotPath(root, x.repo);
    const onDisk = await readFile(path, "utf8").catch(() => undefined);
    const kept = (reason: ReadersSlotOutcome["reason"], detail?: string): ReadersSlotOutcome => {
      const p = onDisk === undefined ? undefined : parseReadersSlot(onDisk);
      return {
        repo: x.repo,
        slot: onDisk === undefined ? "none" : "kept-last-good",
        ...(p?.ok ? { commit: p.slot.commit } : {}),
        ...(reason ? { reason } : {}),
        ...(detail ? { detail } : {}),
      };
    };
    if (!x.full) {
      out.push(kept(x.why, x.detail));
      continue;
    }
    const text = serializeReadersSlot(x.slot);
    // A writer reads back what it serialized before writing it: a slot that doesn't read is a bug.
    const back = parseReadersSlot(text, x.repo);
    if (!back.ok)
      throw new Error(
        `The readers slot of ${x.repo} doesn't read back: ${back.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
      );
    if (onDisk?.replace(/\r\n?/g, "\n") === text) {
      out.push({ repo: x.repo, slot: "unchanged", commit: x.slot.commit });
      continue;
    }
    if (o.hold) {
      out.push(kept(o.hold));
      continue;
    }
    await writeFileAtomic(path, text);
    out.push({ repo: x.repo, slot: "written", commit: x.slot.commit });
  }
  return out;
}

/**
 * The facts snapshot of a successful `atticus verify <repo> --write` (ADR 0195 point 1): the
 * kept facts, then the meta with their hash, each written whole. The meta goes last, so a write
 * cut short between them leaves a snapshot whose hash doesn't match: not current, and said.
 */
export async function writeFactsSlot(
  root: string,
  s: {
    repo: string;
    commit: string;
    facts: readonly Fact[];
    contracts: ContractsFileT | null;
    /** verify's verdict that every source file is read or reviewed. */
    readComplete?: boolean;
  },
): Promise<{ facts: "written" | "unchanged"; meta: "written" | "unchanged"; count: number }> {
  const paths = factsSlotPaths(root, s.repo);
  const text = serializeFactsSnapshot(s.facts);
  const meta = serializeFactsSlotMeta({
    slotVersion: SLOT_VERSION,
    kind: "facts",
    repo: s.repo,
    commit: s.commit,
    factsSchemaVersion: FACTS_SCHEMA_VERSION,
    factsHash: sha256Of(text),
    contracts: s.contracts,
    ...(s.readComplete ? { readComplete: true as const } : {}),
  });
  const facts = await writeSlotFile(paths.facts, text);
  return { facts, meta: await writeSlotFile(paths.meta, meta), count: s.facts.length };
}

/** A repo's facts snapshot as stored, when it reads and its hash matches; else why not. */
export async function readFactsSlot(
  root: string,
  repo: string,
): Promise<
  { ok: true; meta: FactsSlotMetaT; facts: Fact[] } | { ok: false; problem: string } | undefined
> {
  const paths = factsSlotPaths(root, repo);
  const [text, metaText] = await Promise.all([
    readFile(paths.facts, "utf8").catch(() => undefined),
    readFile(paths.meta, "utf8").catch(() => undefined),
  ]);
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
  if (meta.slot.factsSchemaVersion > FACTS_SCHEMA_VERSION)
    return {
      ok: false,
      problem: `a newer Atticus wrote it (facts version ${meta.slot.factsSchemaVersion})`,
    };
  if (sha256Of(text.replace(/\r\n?/g, "\n")) !== meta.slot.factsHash)
    return { ok: false, problem: "its facts aren't the ones its meta hashed" };
  const facts = parseFactsSnapshot(text);
  if (!facts.ok)
    return {
      ok: false,
      problem: `its facts don't read (${facts.issues[0]?.message ?? "invalid"})`,
    };
  return { ok: true, meta: meta.slot, facts: facts.facts };
}

/**
 * A repo's facts snapshot against its clone (ADR 0195 points 1 and 5): the facts that cite a
 * file changed between the snapshot's commit and HEAD, by file. Nothing is written: only a
 * successful `atticus verify <repo> --write` refreshes the snapshot, and this says to run it.
 */
export interface FactsStaleness {
  repo: string;
  /** The snapshot's commit. */
  commit: string;
  head: string;
  /** Each changed file the facts cite, how it changed, and the facts citing it. */
  files: { path: string; how: "edited" | "renamed" | "deleted"; to?: string; facts: string[] }[];
  /** How many facts cite a changed file. */
  facts: number;
  /** The snapshot's commit isn't an earlier commit of HEAD here, so nothing can be compared. */
  notComparable?: true;
  /** The snapshot doesn't read or its hash doesn't match: what is wrong with it. */
  unusable?: string;
  command: string;
}

export async function factsSlotStaleness(
  root: string,
  repo: string,
  at: { dir: string; head: string; git?: GitRunner },
): Promise<FactsStaleness | undefined> {
  const slot = await readFactsSlot(root, repo);
  if (!slot) return undefined;
  const command = `atticus verify ${repo} --write`;
  if (!slot.ok)
    return {
      repo,
      commit: "unknown",
      head: at.head,
      files: [],
      facts: 0,
      unusable: slot.problem,
      command,
    };
  const commit = slot.meta.commit;
  if (commit === at.head || at.head.startsWith(commit) || commit.startsWith(at.head))
    return undefined;
  const diff =
    commit === "unknown"
      ? { changes: {}, missing: [commit] }
      : await changesSince(at.dir, [commit], at.head, at.git).catch(() => ({
          changes: {},
          missing: [commit],
        }));
  if (diff.missing.length)
    return { repo, commit, head: at.head, files: [], facts: 0, notComparable: true, command };
  const changes = Object.values(diff.changes)[0] ?? [];
  const byFile = new Map<string, FactsStaleness["files"][number]>();
  let stale = 0;
  for (const f of slot.facts) {
    const s = staleCite(f, changes);
    if (!s) continue;
    stale++;
    const e = byFile.get(s.file) ?? {
      path: s.file,
      how: s.how,
      ...(s.to !== undefined ? { to: s.to } : {}),
      facts: [],
    };
    e.facts.push(f.id);
    byFile.set(s.file, e);
  }
  if (!stale) return undefined;
  return {
    repo,
    commit,
    head: at.head,
    files: [...byFile.values()]
      .sort((a, b) => cmpText(a.path, b.path))
      .map((e) => ({ ...e, facts: [...e.facts].sort(cmpText) })),
    facts: stale,
    command,
  };
}
