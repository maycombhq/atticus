import { readdir, readFile, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
  deserializeRecord,
  writeFileAtomic,
  recordPath,
  serializeRecord,
  type CatalogRecord,
} from "@maycombhq/core";

/** Read every record file under a catalog folder. Files that fail C1 are reported, not returned. */
export async function readCatalog(
  dir: string,
): Promise<{ records: CatalogRecord[]; problems: { file: string; message: string }[] }> {
  const records: CatalogRecord[] = [];
  const problems: { file: string; message: string }[] = [];
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
      else if (/\.ya?ml$/.test(e.name)) {
        const r = deserializeRecord(await readFile(full, "utf8"));
        if (r.ok) records.push(r.record);
        else
          problems.push({
            file: relative(dir, full).split(sep).join("/"),
            message: r.issues.map((i) => `${i.path}: ${i.message}`).join("; "),
          });
      }
    }
  }
  await walk(dir);
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
          JSON.stringify((old as Record<string, unknown>)[f]) !==
            JSON.stringify((r as Record<string, unknown>)[f]),
      )
      .sort();
    if (fields.length > 0) diff.changed.push({ kind: r.kind, id: r.id, fields });
    else if (JSON.stringify(old.evidence) !== JSON.stringify(r.evidence))
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
