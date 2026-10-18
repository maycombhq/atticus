import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import {
  deserializeRecord,
  layoutOf,
  recordReferences,
  stateDirOf,
  type CatalogRecord,
  type RecordKind,
} from "@maycombhq/core";
import { openDb, type Db } from "./db.js";
import { compileQuery, parseQuery } from "./query.js";

/** Bumped when the index's tables change; an index built by another version is rebuilt. */
export const INDEX_VERSION = 1;

export interface CatalogFile {
  /** Path relative to the metarepo, e.g. catalog/generated/interface/if-1.yaml. */
  path: string;
  size: number;
  mtimeMs: number;
}

export interface IndexProblem {
  file: string;
  message: string;
}

/** The folders the index reads, relative to the metarepo. */
export const CATALOG_DIRS = ["catalog/generated", "catalog/curated"];

async function listFiles(root: string): Promise<CatalogFile[]> {
  const out: CatalogFile[] = [];
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
      else if (/\.ya?ml$/.test(e.name)) {
        const s = await stat(full);
        out.push({
          path: relative(root, full).split(sep).join("/"),
          size: s.size,
          mtimeMs: Math.floor(s.mtimeMs),
        });
      }
    }
  }
  // The catalog folder follows sources.yaml layout (catalog/ unless the org pack says otherwise).
  const catalog = layoutOf(root).catalog;
  for (const d of CATALOG_DIRS)
    await walk(join(root, ...d.replace(/^catalog\//, `${catalog}/`).split("/")));
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** A cheap fingerprint of the catalog files: names, sizes and modification times. */
function fingerprint(files: CatalogFile[]): string {
  const h = createHash("sha256").update(`v${INDEX_VERSION}\n`);
  for (const f of files) h.update(`${f.path}\t${f.size}\t${f.mtimeMs}\n`);
  return h.digest("hex");
}

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE records (
  kind TEXT NOT NULL, id TEXT NOT NULL, status TEXT NOT NULL, confidence TEXT NOT NULL,
  name TEXT NOT NULL, system TEXT, file TEXT NOT NULL, stale INTEGER NOT NULL, json TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE INDEX records_id ON records (id);
CREATE INDEX records_system ON records (system);
CREATE TABLE refs (from_kind TEXT NOT NULL, from_id TEXT NOT NULL, field TEXT NOT NULL, to_id TEXT NOT NULL);
CREATE INDEX refs_to ON refs (to_id);
CREATE INDEX refs_from ON refs (from_id);
CREATE TABLE evidence (kind TEXT NOT NULL, id TEXT NOT NULL, source TEXT NOT NULL, repo TEXT, path TEXT, line INTEGER);
CREATE INDEX evidence_path ON evidence (repo, path);
`;

/** A short label for a record: its name or title, else what it is about, else its id. */
export function labelOf(r: Record<string, unknown>): string {
  for (const f of ["name", "title", "pathOrTopic", "key", "raw"])
    if (typeof r[f] === "string" && r[f]) return r[f] as string;
  if (r.kind === "Interface")
    return `${String(r.from)} → ${String(r.to)}${r.method ? ` ${String(r.method)}` : ""} ${String(r.normalizedPath ?? "")}`.trim();
  return String(r.id);
}

/**
 * The system each record belongs to: a system itself; a component's system; for records of a
 * component (endpoints, settings, deployments, tables it owns...) that component's system; an
 * interface belongs to its caller's system.
 */
function systemsOf(records: CatalogRecord[]): Map<string, string> {
  const key = (r: { kind: string; id: string }) => `${r.kind}|${r.id}`;
  const systems = new Set(records.filter((r) => r.kind === "System").map((r) => r.id));
  const componentSystem = new Map<string, string>();
  for (const r of records) if (r.kind === "Component") componentSystem.set(r.id, r.system);
  const ofId = (id: unknown): string | undefined => {
    if (typeof id !== "string") return undefined;
    return componentSystem.get(id) ?? (systems.has(id) ? id : undefined);
  };
  const out = new Map<string, string>();
  const tables = new Map<string, string>();
  const stores = new Map<string, string>();
  for (const r of records) {
    const x = r as unknown as Record<string, unknown>;
    let s: string | undefined;
    if (r.kind === "System") s = r.id;
    else if (r.kind === "Component") s = r.system;
    else if (r.kind === "Interface") s = ofId(r.from);
    else
      s =
        ofId(x.component) ??
        ofId(x.ownerComponent) ??
        ofId(x.owner) ??
        (typeof x.system === "string" ? x.system : undefined);
    if (s) out.set(key(r), s);
    if (r.kind === "DataStore" && s) stores.set(r.id, s);
  }
  for (const r of records)
    if (r.kind === "Table" && !out.has(key(r)) && stores.has(r.dataStore))
      out.set(key(r), stores.get(r.dataStore)!);
  for (const r of records)
    if (r.kind === "Table" && out.has(key(r))) tables.set(r.id, out.get(key(r))!);
  for (const r of records) {
    const x = r as unknown as Record<string, unknown>;
    if (out.has(key(r))) continue;
    const s =
      (typeof x.table === "string" && tables.get(x.table)) ||
      (typeof x.dataStore === "string" && stores.get(x.dataStore)) ||
      undefined;
    if (s) out.set(key(r), s);
  }
  return out;
}

/** Build a fresh index file from records. Written beside the target, then moved into place. */
export async function buildIndexFile(
  file: string,
  records: { record: CatalogRecord; file: string }[],
  fp: string,
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await rm(tmp, { force: true });
  const db = openDb(tmp);
  try {
    db.exec(SCHEMA);
    const systems = systemsOf(records.map((r) => r.record));
    const insRec = db.prepare("INSERT OR REPLACE INTO records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const insRef = db.prepare("INSERT INTO refs VALUES (?, ?, ?, ?)");
    const insEv = db.prepare("INSERT INTO evidence VALUES (?, ?, ?, ?, ?, ?)");
    db.exec("BEGIN");
    for (const { record: r, file: f } of records) {
      const x = r as unknown as Record<string, unknown>;
      insRec.run(
        r.kind,
        r.id,
        r.status,
        r.confidence,
        labelOf(x),
        systems.get(`${r.kind}|${r.id}`) ?? null,
        f,
        (r.flags ?? []).includes("stale") ? 1 : 0,
        JSON.stringify(r),
      );
      for (const ref of recordReferences(r)) insRef.run(r.kind, r.id, ref.field, ref.id);
      for (const e of r.evidence as Record<string, unknown>[])
        insEv.run(
          r.kind,
          r.id,
          String(e.source),
          (e.repo as string) ?? null,
          (e.path as string) ?? null,
          typeof e.line === "number" ? e.line : null,
        );
    }
    const meta = db.prepare("INSERT INTO meta VALUES (?, ?)");
    meta.run("version", String(INDEX_VERSION));
    meta.run("fingerprint", fp);
    meta.run("records", String(records.length));
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  await rm(file, { force: true });
  await rename(tmp, file);
}

export interface OpenOptions {
  /** Index file; default <root>/.index/catalog.sqlite. */
  file?: string;
  /** Rebuild even when the files look unchanged. */
  rebuild?: boolean;
}

/**
 * The local index: a disposable SQLite view of the catalog files (ADR 0003). Opening it checks
 * the files' fingerprint and rebuilds when anything changed, so it is never out of date.
 */
export async function openIndex(root: string, o: OpenOptions = {}): Promise<CatalogIndex> {
  const file = o.file ?? join(stateDirOf(root), ".index", "catalog.sqlite");
  const files = await listFiles(root);
  const fp = fingerprint(files);
  let current: string | undefined;
  if (!o.rebuild) {
    try {
      const db = openDb(file);
      try {
        current = (
          db.prepare("SELECT value FROM meta WHERE key = 'fingerprint'").get() as
            { value: string } | undefined
        )?.value;
      } finally {
        db.close();
      }
    } catch {
      current = undefined;
    }
  }
  const problems: IndexProblem[] = [];
  let rebuilt = false;
  if (current !== fp) {
    const records: { record: CatalogRecord; file: string }[] = [];
    for (const f of files) {
      const r = deserializeRecord(await readFile(join(root, ...f.path.split("/")), "utf8"));
      if (r.ok) records.push({ record: r.record, file: f.path });
      else
        problems.push({
          file: f.path,
          message: r.issues.map((i) => `${i.path}: ${i.message}`).join("; "),
        });
    }
    await buildIndexFile(file, records, fp);
    rebuilt = true;
  }
  return new CatalogIndex(openDb(file), file, problems, rebuilt);
}

export interface Row {
  kind: RecordKind;
  id: string;
  status: string;
  confidence: string;
  name: string;
  system: string | null;
  file: string;
}

/** Queries over the index. Close it when done. */
export class CatalogIndex {
  constructor(
    readonly db: Db,
    readonly file: string,
    /** Catalog files that failed C1 and were left out (only reported on the build that met them). */
    readonly problems: IndexProblem[],
    readonly rebuilt: boolean,
  ) {}

  close(): void {
    this.db.close();
  }

  /** Records matching a query in the catalog query language, ordered by kind and id. */
  query(text: string, o: { limit?: number; offset?: number } = {}): { rows: Row[]; total: number } {
    const { where, params } = compileQuery(parseQuery(text));
    const total = (
      this.db.prepare(`SELECT count(*) AS n FROM records r WHERE ${where}`).get(...params) as {
        n: number;
      }
    ).n;
    const rows = this.db
      .prepare(
        `SELECT kind, id, status, confidence, name, system, file FROM records r WHERE ${where} ORDER BY kind, id LIMIT ? OFFSET ?`,
      )
      .all(...params, o.limit ?? 100, o.offset ?? 0) as unknown as Row[];
    return { rows, total };
  }

  /** The full records for rows. */
  records(rows: { kind: string; id: string }[]): CatalogRecord[] {
    const get = this.db.prepare("SELECT json FROM records WHERE kind = ? AND id = ?");
    return rows.map(
      (r) => JSON.parse((get.get(r.kind, r.id) as { json: string }).json) as CatalogRecord,
    );
  }

  /** One record, or undefined. */
  get(kind: string, id: string): CatalogRecord | undefined {
    const row = this.db
      .prepare("SELECT json FROM records WHERE kind = ? AND id = ?")
      .get(kind, id) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as CatalogRecord) : undefined;
  }

  /** Every record with this id, whatever its kind. */
  find(id: string): CatalogRecord[] {
    return (
      this.db.prepare("SELECT json FROM records WHERE id = ? ORDER BY kind").all(id) as {
        json: string;
      }[]
    ).map((r) => JSON.parse(r.json) as CatalogRecord);
  }

  /** The system a record belongs to, as worked out when the index was built. */
  systemOf(kind: string, id: string): string | undefined {
    return (
      (
        this.db.prepare("SELECT system FROM records WHERE kind = ? AND id = ?").get(kind, id) as
          { system: string | null } | undefined
      )?.system ?? undefined
    );
  }

  /** Records that refer to id: which record, by which field. */
  referencesTo(id: string): { kind: RecordKind; id: string; field: string }[] {
    return this.db
      .prepare(
        "SELECT from_kind AS kind, from_id AS id, field FROM refs WHERE to_id = ? ORDER BY from_kind, from_id, field",
      )
      .all(id) as unknown as { kind: RecordKind; id: string; field: string }[];
  }

  /** Count per kind, with how many are flagged stale. */
  kinds(): { kind: RecordKind; count: number; stale: number }[] {
    return this.db
      .prepare(
        "SELECT kind, count(*) AS count, sum(stale) AS stale FROM records GROUP BY kind ORDER BY kind",
      )
      .all() as unknown as { kind: RecordKind; count: number; stale: number }[];
  }

  /** Records of one kind, filtered and paged by id (the API's listRecords). */
  list(
    kind: string,
    o: { status?: string; system?: string; q?: string; limit?: number; cursor?: string } = {},
  ): { items: CatalogRecord[]; total: number; next?: string } {
    const where = ["kind = ?"];
    const params: (string | number)[] = [kind];
    if (o.status) {
      where.push("status = ?");
      params.push(o.status);
    }
    if (o.system) {
      where.push("system = ?");
      params.push(o.system);
    }
    if (o.q) {
      where.push("(lower(id) LIKE ? OR lower(name) LIKE ?)");
      params.push(`%${o.q.toLowerCase()}%`, `%${o.q.toLowerCase()}%`);
    }
    const total = (
      this.db
        .prepare(`SELECT count(*) AS n FROM records WHERE ${where.join(" AND ")}`)
        .get(...params) as { n: number }
    ).n;
    const after = o.cursor ? Buffer.from(o.cursor, "base64url").toString("utf8") : undefined;
    const limit = Math.min(Math.max(o.limit ?? 50, 1), 500);
    const rows = this.db
      .prepare(
        `SELECT id, json FROM records WHERE ${where.join(" AND ")}${after !== undefined ? " AND id > ?" : ""} ORDER BY id LIMIT ?`,
      )
      .all(...params, ...(after !== undefined ? [after] : []), limit + 1) as {
      id: string;
      json: string;
    }[];
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => JSON.parse(r.json) as CatalogRecord),
      total,
      ...(rows.length > limit
        ? { next: Buffer.from(page[page.length - 1]!.id, "utf8").toString("base64url") }
        : {}),
    };
  }
}
