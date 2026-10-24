import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parse } from "yaml";
import { parseRecord } from "./catalog.js";
import { SCHEMA_VERSION } from "./schema/common.js";
import { FLOW_SCHEMA_VERSION, RECORD_KINDS } from "./schema/kinds.js";
import { serializeRecord } from "./serialize.js";
import { writeFileAtomic } from "./fs.js";

export interface MigrationResult {
  /** Files rewritten at the current schema version (relative to the folder, "/"-separated). */
  migrated: string[];
  /** Record files already at the current version, left alone. */
  current: string[];
  /** Old record files that don't pass C1: left exactly as they are, with why. */
  problems: { file: string; message: string }[];
}

const isRecordKind = (k: unknown): boolean =>
  typeof k === "string" && (RECORD_KINDS as string[]).includes(k);

async function yamlFiles(dir: string): Promise<string[]> {
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
      else if (/\.ya?ml$/.test(e.name)) out.push(full);
    }
  }
  await walk(dir);
  return out.sort();
}

/**
 * Rewrite every older record file under a catalog folder (generated and curated) at the
 * current schema version, in canonical form. Readers accept old files anyway; migrating once
 * keeps diffs clean afterwards. A file that isn't a catalog record (no known `kind`) is not
 * touched, nor is an old one that fails C1: it is reported, so nothing is half-migrated.
 * Version 1 → 2 (ADR 0031) and 2 → 3 (ADR 0125) change only `schemaVersion`: version 3 adds
 * `required` on a Schema field, and a migrated record gains none, since nothing knew it. The
 * canonical form also writes list defaults a hand-written file left out, exactly as a scan
 * would write the record. `versions` limits it to files at those versions (each `atticus
 * upgrade` step lists its own); what it writes is always the current version.
 */
export async function migrateCatalog(
  dir: string,
  o: { dryRun?: boolean; versions?: readonly number[] } = {},
): Promise<MigrationResult> {
  const res: MigrationResult = { migrated: [], current: [], problems: [] };
  for (const full of await yamlFiles(dir)) {
    const file = relative(dir, full).split(sep).join("/");
    const text = await readFile(full, "utf8");
    let data: unknown;
    try {
      data = parse(text);
    } catch {
      continue;
    }
    if (
      typeof data !== "object" ||
      data === null ||
      !isRecordKind((data as { kind?: unknown }).kind)
    )
      continue;
    const version = (data as { schemaVersion?: unknown }).schemaVersion;
    const kind = (data as { kind?: unknown }).kind;
    // A Flow has its own schema version (ADR 0079); version 1 is current.
    if (version === (kind === "Flow" ? FLOW_SCHEMA_VERSION : SCHEMA_VERSION)) {
      res.current.push(file);
      continue;
    }
    if (o.versions && !(typeof version === "number" && o.versions.includes(version))) continue;
    const p = parseRecord(data);
    if (!p.ok) {
      res.problems.push({
        file,
        message: p.issues.map((i) => `${i.path}: ${i.message}`).join("; "),
      });
      continue;
    }
    if (!o.dryRun) await writeFileAtomic(full, serializeRecord(p.record));
    res.migrated.push(file);
  }
  return res;
}
