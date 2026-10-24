import { identifierWords } from "@maycombhq/core";
import { dotInt8, textSha, type Embedder, type EmbedKind, type QuantVector } from "@maycombhq/ai";
import type { Db } from "./db.js";
import { ASKED_ONLY_KINDS } from "./sources.js";

/**
 * Vectors for "similar in meaning" (ADR 0116), in their own file beside the index
 * (`.index/vectors.sqlite`, attached as `vec`), so an index rebuild doesn't throw them away. A
 * vector is keyed by the model's id and the hash of the text embedded, not by file: an unchanged
 * text in a changed file isn't embedded again and moving a file costs nothing. Queries are kept
 * the same way, so a repeated search doesn't load the model. Stored as int8 with one scale per
 * vector; scored by an exact integer dot product, ties by key.
 */

export const VECTORS_SCHEMA = `
CREATE TABLE IF NOT EXISTS vec.vectors (
  model TEXT NOT NULL, text_sha TEXT NOT NULL, kind TEXT NOT NULL, dim INTEGER NOT NULL,
  scale REAL NOT NULL, q BLOB NOT NULL, PRIMARY KEY (model, text_sha, kind)
);
`;

/**
 * What a node is embedded as: its kind, its name and id as words, then its text, cut. An id that
 * is a file's path (a document's section) is left out: where a text is says nothing of what it
 * means, and a moved file keeps its vectors.
 */
export function nodeText(n: { kind: string; name: string; ids: string; body: string }): string {
  const words = (s: string) => identifierWords(s).join(" ");
  const id = n.ids.split(" ")[0] ?? "";
  return `${n.kind}: ${words(n.name) || n.name}. ${id.includes("/") ? "" : words(id)}. ${n.body}`
    .replace(/\s+/g, " ")
    .slice(0, 2000);
}

/** How far the vectors are: on only when every node of the index has one for this model. */
export interface MeaningState {
  on: boolean;
  model?: string;
  embedded: number;
  total: number;
  /** Said in a selection and by doctor. */
  note: string;
}

export function attachVectors(db: Db, file: string): void {
  db.exec(`ATTACH DATABASE '${file.replace(/'/g, "''")}' AS vec`);
  db.exec(VECTORS_SCHEMA);
}

export function meaningState(db: Db, embedder: Embedder | undefined, why?: string): MeaningState {
  const total = (db.prepare("SELECT count(*) AS n FROM node_text").get() as { n: number }).n;
  if (!embedder)
    return {
      on: false,
      embedded: 0,
      total,
      note: `similar in meaning is off: ${why ?? "no embedding model"}`,
    };
  const embedded = (
    db
      .prepare(
        "SELECT count(*) AS n FROM node_text t JOIN vec.vectors v ON v.model = ? AND v.text_sha = t.text_sha AND v.kind = 'document'",
      )
      .get(embedder.id) as { n: number }
  ).n;
  const on = total > 0 && embedded === total;
  return {
    on,
    model: embedder.id,
    embedded,
    total,
    note: on
      ? `similar in meaning by ${embedder.id} (${total} nodes)`
      : `similar in meaning is off until every node is embedded: ${embedded} of ${total} by ${embedder.id} (atticus index embed)`,
  };
}

const toBlob = (v: QuantVector) => Buffer.from(v.q.buffer, v.q.byteOffset, v.q.byteLength);

function store(db: Db, embedder: Embedder, kind: EmbedKind, shas: string[], vs: QuantVector[]) {
  const ins = db.prepare("INSERT OR REPLACE INTO vec.vectors VALUES (?, ?, ?, ?, ?, ?)");
  db.exec("BEGIN IMMEDIATE");
  try {
    vs.forEach((v, i) => ins.run(embedder.id, shas[i]!, kind, v.q.length, v.scale, toBlob(v)));
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Embed the nodes that have no vector for this model, at most `max`, in key order. */
export async function embedMissing(
  db: Db,
  embedder: Embedder,
  o: { max?: number; batch?: number; progress?: (done: number, of: number) => void } = {},
): Promise<number> {
  const rows = db
    .prepare(
      `SELECT DISTINCT t.text_sha AS sha, t.text AS text FROM node_text t
       WHERE NOT EXISTS (SELECT 1 FROM vec.vectors v WHERE v.model = ? AND v.text_sha = t.text_sha AND v.kind = 'document')
       ORDER BY t.text_sha`,
    )
    .all(embedder.id) as { sha: string; text: string }[];
  const todo = rows.slice(0, o.max ?? rows.length);
  const batch = o.batch ?? 16;
  for (let i = 0; i < todo.length; i += batch) {
    const part = todo.slice(i, i + batch);
    const vs = await embedder.embed(
      part.map((r) => r.text),
      "document",
    );
    store(
      db,
      embedder,
      "document",
      part.map((r) => r.sha),
      vs,
    );
    o.progress?.(Math.min(i + batch, todo.length), todo.length);
  }
  return todo.length;
}

/** The vectors of these query texts, embedding (and keeping) the ones not seen before. */
export async function queryVectors(
  db: Db,
  embedder: Embedder,
  texts: string[],
): Promise<QuantVector[]> {
  const shas = texts.map(textSha);
  const missing = texts.filter((_, i) => !cachedQuery(db, embedder.id, shas[i]!));
  if (missing.length) {
    const vs = await embedder.embed(missing, "query");
    store(db, embedder, "query", missing.map(textSha), vs);
  }
  return shas.map((s) => cachedQuery(db, embedder.id, s)!);
}

/** A query's vector, if it was embedded before. */
export function cachedQuery(db: Db, model: string, sha: string): QuantVector | undefined {
  const r = db
    .prepare("SELECT scale, q FROM vec.vectors WHERE model = ? AND text_sha = ? AND kind = 'query'")
    .get(model, sha) as { scale: number; q: Uint8Array } | undefined;
  return r
    ? { scale: r.scale, q: new Int8Array(r.q.buffer, r.q.byteOffset, r.q.byteLength) }
    : undefined;
}

/** Every node's vector in one block, loaded once per open index. */
export interface Matrix {
  keys: string[];
  kinds: string[];
  scales: Float64Array;
  q: Int8Array;
  dim: number;
}

export function loadMatrix(db: Db, model: string): Matrix {
  const rows = db
    .prepare(
      `SELECT t.key AS key, n.kind AS kind, v.scale AS scale, v.q AS q, v.dim AS dim FROM node_text t
       JOIN nodes n ON n.key = t.key
       JOIN vec.vectors v ON v.model = ? AND v.text_sha = t.text_sha AND v.kind = 'document'
       ORDER BY t.key`,
    )
    .all(model) as { key: string; kind: string; scale: number; q: Uint8Array; dim: number }[];
  const dim = rows[0]?.dim ?? 0;
  const q = new Int8Array(rows.length * dim);
  const scales = new Float64Array(rows.length);
  rows.forEach((r, i) => {
    q.set(new Int8Array(r.q.buffer, r.q.byteOffset, r.q.byteLength), i * dim);
    scales[i] = r.scale;
  });
  return { keys: rows.map((r) => r.key), kinds: rows.map((r) => r.kind), scales, q, dim };
}

/**
 * The nodes nearest the queries: each node's best cosine over the queries, those at or above
 * the floor, best first, ties by key. Exact integer dot products, so the order is the same on
 * every machine for the same stored vectors.
 */
export function nearest(
  m: Matrix,
  queries: QuantVector[],
  o: { floor: number; limit: number; kinds?: string[]; exclude?: Set<string> },
): { key: string; cos: number }[] {
  const kinds = o.kinds?.length ? new Set(o.kinds) : undefined;
  const out: { key: string; cos: number }[] = [];
  for (let i = 0; i < m.keys.length; i++) {
    if (kinds ? !kinds.has(m.kinds[i]!) : ASKED_ONLY_KINDS.has(m.kinds[i]!)) continue;
    if (o.exclude?.has(m.keys[i]!)) continue;
    let best = -Infinity;
    for (const qv of queries) {
      const c = dotInt8(qv.q, m.q, i * m.dim) * qv.scale * m.scales[i]!;
      if (c > best) best = c;
    }
    if (best >= o.floor) out.push({ key: m.keys[i]!, cos: Math.round(best * 1e4) / 1e4 });
  }
  return out
    .sort((a, b) => b.cos - a.cos || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, o.limit);
}

/** The pieces of an input embedded as queries: its title, then each paragraph, at most 20. */
export function queryChunks(input: { text: string; title?: string }): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    const t = s.replace(/\s+/g, " ").trim().slice(0, 1000);
    if (t.length >= 3 && !out.includes(t)) out.push(t);
  };
  if (input.title) push(input.title);
  for (const p of input.text.split(/\n\s*\n/)) push(p.replace(/^#+\s*/gm, ""));
  return out.slice(0, 20);
}
