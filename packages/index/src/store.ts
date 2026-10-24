import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { splitForms, type CatalogRecord } from "@maycombhq/core";
import type { Db } from "./db.js";
import { nodeText } from "./vectors.js";
import {
  documentNodes,
  foldName,
  labelOf,
  readSource,
  type FileRead,
  type SourceFile,
} from "./sources.js";

/**
 * The index's tables and how they are kept up to date (ADR 0002, 0107). Each file the index
 * reads has a row in `files` with its size, time and content hash; an update re-reads only the
 * files whose size or time changed, and only when the content hash changed too does it replace
 * the file's rows. A removed file's rows go. The names the mentions are matched against are
 * hashed: when they change, every node's mentions are matched again, else only the changed
 * files' nodes are.
 */

/** Bumped when the index's tables change; an index of another version is rebuilt once. */
export const INDEX_VERSION = 3;

export const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE files (path TEXT PRIMARY KEY, source TEXT NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL, hash TEXT NOT NULL);
CREATE TABLE records (
  kind TEXT NOT NULL, id TEXT NOT NULL, status TEXT NOT NULL, confidence TEXT NOT NULL,
  name TEXT NOT NULL, system TEXT, file TEXT NOT NULL, stale INTEGER NOT NULL, json TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE INDEX records_id ON records (id);
CREATE INDEX records_system ON records (system);
CREATE INDEX records_file ON records (file);
CREATE TABLE refs (from_kind TEXT NOT NULL, from_id TEXT NOT NULL, field TEXT NOT NULL, to_id TEXT NOT NULL, file TEXT NOT NULL);
CREATE INDEX refs_to ON refs (to_id);
CREATE INDEX refs_from ON refs (from_id);
CREATE INDEX refs_file ON refs (file);
CREATE TABLE evidence (kind TEXT NOT NULL, id TEXT NOT NULL, source TEXT NOT NULL, repo TEXT, path TEXT, line INTEGER, file TEXT NOT NULL);
CREATE INDEX evidence_path ON evidence (repo, path);
CREATE INDEX evidence_file ON evidence (file);
CREATE TABLE nodes (
  key TEXT PRIMARY KEY, kind TEXT NOT NULL, id TEXT NOT NULL, grp TEXT NOT NULL, name TEXT NOT NULL,
  file TEXT NOT NULL, verified INTEGER NOT NULL, line TEXT NOT NULL, detail TEXT NOT NULL,
  body TEXT NOT NULL, mentions INTEGER NOT NULL, json TEXT
);
CREATE INDEX nodes_id ON nodes (id);
CREATE INDEX nodes_file ON nodes (file);
CREATE TABLE names (name TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, how TEXT NOT NULL, file TEXT NOT NULL);
CREATE INDEX names_name ON names (name);
CREATE INDEX names_id ON names (id);
CREATE INDEX names_file ON names (file);
CREATE TABLE links (from_key TEXT NOT NULL, to_ref TEXT NOT NULL, by TEXT NOT NULL, type TEXT NOT NULL, how TEXT NOT NULL, file TEXT NOT NULL, derived INTEGER NOT NULL);
CREATE INDEX links_from ON links (from_key);
CREATE INDEX links_to ON links (to_ref, by);
CREATE INDEX links_file ON links (file);
CREATE TABLE reviews (item TEXT NOT NULL, verdict TEXT NOT NULL, by TEXT NOT NULL, at TEXT NOT NULL, file TEXT NOT NULL);
CREATE INDEX reviews_item ON reviews (item);
CREATE INDEX reviews_file ON reviews (file);
CREATE VIRTUAL TABLE fts USING fts5(key UNINDEXED, name, ids, body, words, tokenize = 'porter unicode61');
CREATE TABLE selections (key TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE node_text (key TEXT PRIMARY KEY, text_sha TEXT NOT NULL, text TEXT NOT NULL, file TEXT NOT NULL);
CREATE INDEX node_text_file ON node_text (file);
`;

/** The kinds a mention can name (ADR 0107): systems, components, vendors and teams, products. */
export const NAMEABLE_KINDS = ["System", "Component", "Party", "Product"];

export interface IndexProblem {
  file: string;
  message: string;
}

export interface UpdateResult {
  /** Files whose rows were written (new or changed). */
  changed: string[];
  removed: string[];
  problems: IndexProblem[];
  /** Whether every node's mentions were matched again (the names changed). */
  rematched: boolean;
}

const meta = (db: Db, key: string): string | undefined =>
  (db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)
    ?.value;

/** Create the tables, or drop and create them when the index is of another version. */
export function ensureSchema(db: Db, rebuild = false): boolean {
  let version: string | undefined;
  try {
    version = meta(db, "version");
  } catch {
    version = undefined;
  }
  if (!rebuild && version === String(INDEX_VERSION)) return false;
  const objects = db
    .prepare(
      "SELECT type, name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all() as { type: string; name: string }[];
  db.exec("BEGIN IMMEDIATE");
  try {
    // A virtual table drops its own shadow tables.
    const virtual = objects.filter((o) =>
      /VIRTUAL/i.test(
        (
          db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(o.name) as
            { sql: string | null } | undefined
        )?.sql ?? "",
      ),
    );
    for (const v of virtual) db.exec(`DROP TABLE IF EXISTS "${v.name}"`);
    for (const o of objects) db.exec(`DROP TABLE IF EXISTS "${o.name}"`);
    db.exec(SCHEMA);
    db.prepare("INSERT INTO meta VALUES ('version', ?)").run(String(INDEX_VERSION));
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return true;
}

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * The system each record belongs to: a system itself; a component's system; for records of a
 * component (endpoints, settings, deployments, tables it owns...) that component's system; an
 * interface belongs to its caller's system.
 */
export function systemsOf(records: CatalogRecord[]): Map<string, string> {
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

/** The names mentions are matched against, as a map name → [id, how]. */
export function mentionNames(db: Db): Map<string, { id: string; how: string }[]> {
  const rows = db
    .prepare(
      `SELECT DISTINCT n.name AS name, n.id AS id, n.how AS how FROM names n
       WHERE length(n.name) >= 3 AND n.how != 'endpoint'
         AND EXISTS (SELECT 1 FROM nodes d WHERE d.id = n.id AND d.kind IN (${NAMEABLE_KINDS.map(() => "?").join(", ")}))
       ORDER BY n.name, n.id, n.how`,
    )
    .all(...NAMEABLE_KINDS) as { name: string; id: string; how: string }[];
  const out = new Map<string, { id: string; how: string }[]>();
  for (const r of rows) {
    if (/^\d+$/.test(r.name)) continue;
    const l = out.get(r.name) ?? [];
    // One link per id: the first way it is named (id, then name, then an alias), sorted.
    if (!l.some((x) => x.id === r.id)) l.push({ id: r.id, how: r.how });
    out.set(r.name, l);
  }
  return out;
}

/** Words of a text as the names are compared: lower case, with surrounding punctuation off. */
export function nameTokens(text: string): string[] {
  return foldName(text)
    .split(/[\s,;()[\]"`*|<>!?]+/)
    .map((t) =>
      t
        .replace(/^[^a-z0-9/{]+/, "")
        .replace(/'s$/, "")
        .replace(/[^a-z0-9}]+$/, ""),
    )
    .filter(Boolean);
}

/** The names a text uses, exactly, case-insensitively: each name, longest first at a place. */
export function namesIn(
  text: string,
  dict: Map<string, unknown>,
  maxWords: number,
): { name: string; at: number }[] {
  const toks = nameTokens(text);
  const out: { name: string; at: number }[] = [];
  for (let i = 0; i < toks.length; i++) {
    for (let n = Math.min(maxWords, toks.length - i); n >= 1; n--) {
      const cand = toks.slice(i, i + n).join(" ");
      if (dict.has(cand)) {
        out.push({ name: cand, at: i });
        break;
      }
    }
  }
  return out;
}

const maxWordsOf = (dict: Map<string, unknown>) =>
  Math.min(8, Math.max(1, ...[...dict.keys()].map((k) => k.split(" ").length)));

/** Read the changed files and write their rows; remove the rows of removed files. */
export async function updateIndex(
  db: Db,
  root: string,
  files: SourceFile[],
  o: { force?: boolean } = {},
): Promise<UpdateResult> {
  const known = new Map(
    (
      db.prepare("SELECT path, size, mtime, hash FROM files").all() as {
        path: string;
        size: number;
        mtime: number;
        hash: string;
      }[]
    ).map((r) => [r.path, r]),
  );
  const present = new Set(files.map((f) => f.path));
  const removed = [...known.keys()].filter((p) => !present.has(p)).sort();
  const stale = files.filter((f) => {
    const k = known.get(f.path);
    return o.force || !k || k.size !== f.size || k.mtime !== f.mtimeMs;
  });
  const result: UpdateResult = { changed: [], removed, problems: [], rematched: false };
  if (!stale.length && !removed.length) return result;
  const reads: { f: SourceFile; text: string; bytes: Buffer; hash: string }[] = [];
  for (const f of stale) {
    const bytes = await readFile(join(root, ...f.path.split("/"))).catch(() => undefined);
    if (bytes === undefined) continue;
    reads.push({
      f,
      bytes,
      text: bytes.toString("utf8"),
      hash: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  // Documents are read from their bytes, before the transaction (the ingestors load lazily).
  const documents = new Map<string, FileRead>();
  for (const r of reads)
    if (r.f.source === "document" && (o.force || known.get(r.f.path)?.hash !== r.hash))
      documents.set(r.f.path, await documentNodes(r.f.path, r.bytes));
  const touched = new Set(
    reads.filter((r) => o.force || known.get(r.f.path)?.hash !== r.hash).map((r) => r.f.path),
  );

  db.exec("BEGIN IMMEDIATE");
  try {
    const drop = (path: string) => {
      for (const t of [
        "records",
        "refs",
        "evidence",
        "nodes",
        "names",
        "links",
        "reviews",
        "node_text",
      ])
        db.prepare(`DELETE FROM ${t} WHERE file = ?`).run(path);
    };
    const dropFts = db.prepare(
      "DELETE FROM fts WHERE key IN (SELECT key FROM nodes WHERE file = ?)",
    );
    for (const p of removed) {
      dropFts.run(p);
      drop(p);
      db.prepare("DELETE FROM files WHERE path = ?").run(p);
    }
    const insRec = db.prepare(
      "INSERT OR REPLACE INTO records VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)",
    );
    const insRef = db.prepare("INSERT INTO refs VALUES (?, ?, ?, ?, ?)");
    const insEv = db.prepare("INSERT INTO evidence VALUES (?, ?, ?, ?, ?, ?, ?)");
    const insNode = db.prepare(
      "INSERT OR REPLACE INTO nodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const insName = db.prepare("INSERT INTO names VALUES (?, ?, ?, ?, ?)");
    const insLink = db.prepare("INSERT INTO links VALUES (?, ?, ?, ?, ?, ?, ?)");
    const insReview = db.prepare("INSERT INTO reviews VALUES (?, ?, ?, ?, ?)");
    const insFts = db.prepare(
      "INSERT INTO fts (key, name, ids, body, words) VALUES (?, ?, ?, ?, ?)",
    );
    const delFtsKey = db.prepare("DELETE FROM fts WHERE key = ?");
    // ADR 0116: what each node is embedded as, by the hash its vector is kept under.
    const insText = db.prepare("INSERT OR REPLACE INTO node_text VALUES (?, ?, ?, ?)");
    const upFile = db.prepare("INSERT OR REPLACE INTO files VALUES (?, ?, ?, ?, ?)");
    let catalogChanged = removed.some((p) => known.has(p));
    const fresh: string[] = [];
    for (const { f, text, hash } of reads) {
      if (!touched.has(f.path)) {
        // The time changed, the content didn't: nothing to read again.
        upFile.run(f.path, f.source, f.size, f.mtimeMs, hash);
        continue;
      }
      dropFts.run(f.path);
      drop(f.path);
      const r: FileRead = documents.get(f.path) ?? readSource(root, f, text);
      if (r.problem) result.problems.push({ file: f.path, message: r.problem });
      if (f.source === "catalog") catalogChanged = true;
      if (r.record) {
        const rec = r.record;
        insRec.run(
          rec.kind,
          rec.id,
          rec.status,
          rec.confidence,
          labelOf(rec as unknown as Record<string, unknown>),
          f.path,
          (rec.flags ?? []).includes("stale") ? 1 : 0,
          JSON.stringify(rec),
        );
        for (const l of r.links.filter((x) => x.type === "ref"))
          insRef.run(rec.kind, rec.id, l.how.replace(/^field:/, ""), l.to, f.path);
        for (const e of rec.evidence as Record<string, unknown>[])
          insEv.run(
            rec.kind,
            rec.id,
            String(e.source),
            (e.repo as string) ?? null,
            (e.path as string) ?? null,
            typeof e.line === "number" ? e.line : null,
            f.path,
          );
      }
      for (const n of r.nodes) {
        delFtsKey.run(n.key);
        insNode.run(
          n.key,
          n.kind,
          n.id,
          n.grp,
          n.name,
          f.path,
          n.verified ? 1 : 0,
          n.line,
          n.detail,
          n.body,
          n.mentions ? 1 : 0,
          n.json ?? null,
        );
        const t = nodeText(n);
        insText.run(n.key, sha(t), t, f.path);
        // ADR 0116: the words its identifiers are made of (renamedAt → renamed at), searched too.
        insFts.run(
          n.key,
          n.names,
          n.ids,
          n.body,
          splitForms(`${n.name}\n${n.names}\n${n.ids}\n${n.body}`).join("\n"),
        );
      }
      for (const n of r.names) insName.run(n.name, n.id, n.kind, n.how, f.path);
      for (const l of r.links) insLink.run(l.from, l.to, l.by, l.type, l.how, f.path, 0);
      if (r.review)
        insReview.run(r.review.item, r.review.verdict, r.review.by, r.review.at, f.path);
      upFile.run(f.path, f.source, f.size, f.mtimeMs, hash);
      fresh.push(f.path);
    }
    result.changed = fresh.sort();

    // The system each catalog record belongs to depends on other records: worked out again.
    if (catalogChanged) {
      const all = (db.prepare("SELECT json FROM records").all() as { json: string }[]).map(
        (x) => JSON.parse(x.json) as CatalogRecord,
      );
      const systems = systemsOf(all);
      const setSys = db.prepare("UPDATE records SET system = ? WHERE kind = ? AND id = ?");
      for (const r of all) setSys.run(systems.get(`${r.kind}|${r.id}`) ?? null, r.kind, r.id);
    }

    // Mentions: the names a node's text uses, exactly.
    const dict = mentionNames(db);
    const dictHash = sha(
      [...dict].map(([k, v]) => `${k}\t${v.map((x) => `${x.id}/${x.how}`).join(",")}`).join("\n"),
    );
    const all = meta(db, "names") !== dictHash;
    result.rematched = all;
    if (all) db.exec("DELETE FROM links WHERE derived = 1");
    const sources = (
      all
        ? db
            .prepare("SELECT key, id, name, body, file FROM nodes WHERE mentions = 1 ORDER BY key")
            .all()
        : fresh.length
          ? db
              .prepare(
                `SELECT key, id, name, body, file FROM nodes WHERE mentions = 1 AND file IN (${fresh.map(() => "?").join(", ")}) ORDER BY key`,
              )
              .all(...fresh)
          : []
    ) as { key: string; id: string; name: string; body: string; file: string }[];
    const maxWords = maxWordsOf(dict);
    for (const n of sources) {
      const seen = new Set<string>();
      for (const m of namesIn(`${n.name}\n${n.body}`, dict, maxWords))
        for (const t of dict.get(m.name) ?? []) {
          if (t.id === n.id || seen.has(t.id)) continue;
          seen.add(t.id);
          insLink.run(n.key, t.id, "id", "names", `mention ${t.how}`, n.file, 1);
        }
    }
    const setMeta = db.prepare("INSERT OR REPLACE INTO meta VALUES (?, ?)");
    setMeta.run("names", dictHash);
    // The index's version: what it was built from, the same on every machine for the same files.
    const fileRows = db.prepare("SELECT path, hash FROM files ORDER BY path").all() as {
      path: string;
      hash: string;
    }[];
    const gen = createHash("sha256").update(`v${INDEX_VERSION}\n`);
    for (const f of fileRows) gen.update(`${f.path}\t${f.hash}\n`);
    setMeta.run("generation", gen.digest("hex").slice(0, 16));
    setMeta.run(
      "records",
      String((db.prepare("SELECT count(*) AS n FROM records").get() as { n: number }).n),
    );
    db.exec("DELETE FROM selections");
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return result;
}
