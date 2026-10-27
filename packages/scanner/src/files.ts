import { readdir, readFile, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  deserializeRecord,
  readParsedFiles,
  SCHEMA_VERSION,
  writeFileAtomic,
  recordPath,
  serializeRecord,
  type CatalogRecord,
} from "@maycombhq/core";

type CatalogRead = { records: CatalogRecord[]; problems: { file: string; message: string }[] };

/**
 * Catalogs a long-running process read, kept until it is told the files changed (ADR 0119). The
 * local server turns this on and forgets on every file change its watcher sees: a metarepo's
 * 1,500 records took seconds to read on every request. A one-shot command reads the files.
 */
const kept = new Map<string, Promise<CatalogRead>>();
let keeping = false;

/** Keep catalogs read in memory (the local server), or read the files every time (the default). */
export function keepCatalogsInMemory(on = true): void {
  keeping = on;
  if (!on) kept.clear();
}

/** The files changed: the next read reads them again. */
export function forgetCatalogs(): void {
  kept.clear();
}

/**
 * Read every record file under a catalog folder. Files that fail C1 are reported, not returned.
 * `cacheRoot` is the metarepo this run is working in, and the only place the parses are kept
 * (record-cache.ts): a catalog read out of another team's estate names no root, so nothing of
 * ours is written into it.
 */
export async function readCatalog(
  dir: string,
  o: { cacheRoot?: string } = {},
): Promise<CatalogRead> {
  if (!keeping) return readCatalogFiles(dir, o.cacheRoot);
  const key = resolve(dir);
  let read = kept.get(key);
  if (!read) {
    read = readCatalogFiles(dir, o.cacheRoot);
    kept.set(key, read);
    read.catch(() => kept.delete(key));
  }
  const r = await read;
  // Each caller gets its own copy: one that sorts or changes records never changes the next's.
  return { records: structuredClone(r.records), problems: r.problems.map((p) => ({ ...p })) };
}

/**
 * Bumped when what a kept parse holds changes, so a cache written by an older Atticus is read
 * from the files again: the records are C1, so its version is the one to follow.
 */
const CATALOG_CACHE_VERSION = `c1@${SCHEMA_VERSION}`;

async function readCatalogFiles(dir: string, cacheRoot?: string): Promise<CatalogRead> {
  const records: CatalogRecord[] = [];
  const problems: { file: string; message: string }[] = [];
  const files: string[] = [];
  async function walk(d: string) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (/\.ya?ml$/.test(e.name)) files.push(relative(dir, full).split(sep).join("/"));
    }
  }
  await walk(dir);
  // The files are read at once, and a file whose size and time haven't changed since the last
  // run isn't parsed again (ADR 0119): 1,500 records took seconds on every command.
  for (const p of await readParsedFiles<CatalogRecord>({
    dir,
    files,
    name: "catalog",
    version: CATALOG_CACHE_VERSION,
    cacheRoot,
    parse: (text) => {
      const r = deserializeRecord(text);
      return r.ok
        ? { ok: true, value: r.record }
        : { ok: false, message: r.issues.map((i) => `${i.path}: ${i.message}`).join("; ") };
    },
  })) {
    if (p.problem === undefined) records.push(p.value!);
    else problems.push({ file: p.rel, message: p.problem });
  }
  // The same order as a scan's records (kind, then id), whatever the file names sort to.
  records.sort((a, b) =>
    a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind.localeCompare(b.kind),
  );
  return { records, problems };
}

/**
 * Write the catalog as one canonical file per record at <kind>/<id>.yaml. Files whose
 * content is unchanged are not touched; records that disappeared are removed. Only ever
 * writes inside `dir` (catalog/generated); curated decisions live elsewhere.
 */
export async function writeCatalog(
  dir: string,
  records: CatalogRecord[],
): Promise<{ written: number; unchanged: number; removed: number }> {
  // What a reader kept is out of date once this writes.
  forgetCatalogs();
  const wanted = new Map(records.map((r) => [recordPath(r), serializeRecord(r)]));
  let written = 0;
  let unchanged = 0;
  for (const [rel, text] of wanted) {
    const full = join(dir, ...rel.split("/"));
    const current = await readFile(full, "utf8").catch(() => undefined);
    if (current === text) {
      unchanged++;
      continue;
    }
    // One record at a time, each whole: a scan cut short leaves every file readable, and the
    // next scan finishes the job.
    await writeFileAtomic(full, text);
    written++;
  }
  let removed = 0;
  const existing = await readCatalogPaths(dir);
  for (const rel of existing) {
    if (!wanted.has(rel)) {
      await rm(join(dir, ...rel.split("/")), { force: true });
      removed++;
    }
  }
  return { written, unchanged, removed };
}

async function readCatalogPaths(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (/\.ya?ml$/.test(e.name)) out.push(relative(dir, full).split(sep).join("/"));
    }
  }
  await walk(dir);
  return out;
}

export interface CatalogDiff {
  added: { kind: string; id: string }[];
  removed: { kind: string; id: string }[];
  /** Records whose facts changed (fields other than evidence). */
  changed: { kind: string; id: string; fields: string[] }[];
  /** Records where only the evidence changed (e.g. a new commit, a moved line). */
  evidenceOnly: { kind: string; id: string }[];
}

/**
 * JSON with object keys sorted at every level, so a record compares equal to the same record
 * read back from its canonical file (which sorts free-form keys such as `details`). Array
 * order still counts.
 */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : x,
  );
}

/** Compare two catalogs record by record. */
export function diffCatalogs(before: CatalogRecord[], after: CatalogRecord[]): CatalogDiff {
  const key = (r: CatalogRecord) => `${r.kind}|${r.id}`;
  const a = new Map(before.map((r) => [key(r), r]));
  const b = new Map(after.map((r) => [key(r), r]));
  const diff: CatalogDiff = { added: [], removed: [], changed: [], evidenceOnly: [] };
  for (const [k, r] of b) {
    const old = a.get(k);
    if (!old) {
      diff.added.push({ kind: r.kind, id: r.id });
      continue;
    }
    const fields = [...new Set([...Object.keys(old), ...Object.keys(r)])]
      .filter(
        (f) =>
          f !== "evidence" &&
          canonical((old as Record<string, unknown>)[f]) !==
            canonical((r as Record<string, unknown>)[f]),
      )
      .sort();
    if (fields.length > 0) diff.changed.push({ kind: r.kind, id: r.id, fields });
    else if (canonical(old.evidence) !== canonical(r.evidence))
      diff.evidenceOnly.push({ kind: r.kind, id: r.id });
  }
  for (const [k, r] of a) if (!b.has(k)) diff.removed.push({ kind: r.kind, id: r.id });
  const sort = <T extends { kind: string; id: string }>(xs: T[]) =>
    xs.sort((x, y) =>
      x.kind === y.kind ? x.id.localeCompare(y.id) : x.kind.localeCompare(y.kind),
    );
  sort(diff.added);
  sort(diff.removed);
  sort(diff.changed);
  sort(diff.evidenceOnly);
  return diff;
}

export function diffIsEmpty(d: CatalogDiff): boolean {
  return d.added.length + d.removed.length + d.changed.length + d.evidenceOnly.length === 0;
}
