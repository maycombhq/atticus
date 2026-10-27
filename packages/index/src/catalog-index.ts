import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stateDirOf, type CatalogRecord, type RecordKind } from "@maycombhq/core";
import { textSha, type Embedder, type QuantVector } from "@maycombhq/ai";
import { openDb, type Db } from "./db.js";
import {
  attachVectors,
  cachedQuery,
  cosines,
  embedMissing,
  loadMatrix,
  meaningState,
  nearest,
  queryChunks,
  queryVectors,
  type Matrix,
  type MeaningState,
} from "./vectors.js";
import { compileQuery, parseQuery } from "./query.js";
import { listSources } from "./sources.js";
import { ensureSchema, updateIndex, type IndexProblem, type UpdateResult } from "./store.js";
import {
  MEANING_FLOOR,
  linksOf,
  nodesById,
  searchIndex,
  selectContext,
  type ContextInput,
  type ContextSelection,
  type GraphNodeRow,
  type NodeLink,
  type SearchHit,
  type SearchOptions,
  type SelectOptions,
} from "./select.js";

export { INDEX_VERSION, type IndexProblem } from "./store.js";
export { CATALOG_DIRS, labelOf } from "./sources.js";

export interface OpenOptions {
  /** Index file; default <root>/.index/catalog.sqlite. */
  file?: string;
  /** Rebuild even when the files look unchanged. */
  rebuild?: boolean;
  /**
   * The embedding model for "similar in meaning" (ADR 0116): "auto" (the default) reads
   * runtime.yaml's retrieval.embeddings (the bundled model unless it says otherwise; where the
   * model or onnxruntime isn't installed, words and names only, and the selection says why), "off",
   * or an embedder (tests, the eval).
   */
  embeddings?: "auto" | "off" | Embedder;
  /**
   * At most this many nodes without a vector are embedded on opening (default 500, under a minute on a slow laptop):
   * a step keeps an index's vectors up to date; a first build of a big estate is
   * `atticus index embed`. Until every node has one, similarity stays off and says so.
   */
  embedOnOpen?: number;
  /**
   * Where the embedding plugin comes from (ADR 0124 addendum D-bundle): `@maycombhq/embed`, which
   * the default offline bundle leaves out. Tests pass one that fails as a missing package does.
   */
  loadEmbed?: () => Promise<Pick<typeof import("@maycombhq/embed"), "embedderFor">>;
}

/** The vectors file beside an index file. */
const vectorsFileOf = (file: string) => join(dirname(file), "vectors.sqlite");

/** A dynamic import that failed because the package isn't installed (not because it broke). */
const notInstalled = (e: unknown, pkg: string) =>
  (e as { code?: string }).code === "ERR_MODULE_NOT_FOUND" &&
  String((e as Error).message).includes(pkg);

async function embedderOf(
  root: string,
  setting: OpenOptions["embeddings"],
  load: NonNullable<OpenOptions["loadEmbed"]> = () => import("@maycombhq/embed"),
): Promise<{ embedder?: Embedder; why?: string }> {
  if (setting === "off") return { why: "turned off for this command" };
  if (setting && setting !== "auto") return { embedder: setting };
  // Never fails the open: without a model the engine searches by words and names, and says why.
  let embed: Awaited<ReturnType<typeof load>>;
  try {
    embed = await load();
  } catch (e) {
    if (notInstalled(e, "@maycombhq/embed"))
      return {
        why: "search by meaning is an optional plugin that isn't installed (@maycombhq/embed)",
      };
    return { why: `the embedding model couldn't be read: ${(e as Error).message.split("\n")[0]}` };
  }
  try {
    const { embedderFor } = embed;
    const r = await embedderFor(root);
    return r.embedder ? { embedder: r.embedder } : { why: r.state.problem ?? "no embedding model" };
  } catch (e) {
    return { why: `the embedding model couldn't be read: ${(e as Error).message.split("\n")[0]}` };
  }
}

/**
 * The local index: a disposable SQLite view of the metarepo's files (ADR 0003, 0107): the
 * catalog, and beside it the knowledge items, flows, changes, answered questions, wiki
 * sections and the org pack's systems, linked. Opening it checks each file's size and time and
 * reads again only the files that changed, so it is never out of date.
 */
export async function openIndex(root: string, o: OpenOptions = {}): Promise<CatalogIndex> {
  const file = o.file ?? join(stateDirOf(root), ".index", "catalog.sqlite");
  await mkdir(dirname(file), { recursive: true });
  const files = await listSources(root);
  const db = openDb(file);
  try {
    const fresh = ensureSchema(db, o.rebuild === true);
    const u = await updateIndex(db, root, files, { force: fresh });
    const rebuilt = fresh || u.changed.length > 0 || u.removed.length > 0;
    attachVectors(db, vectorsFileOf(file));
    const e = await embedderOf(root, o.embeddings, o.loadEmbed);
    const ix = new CatalogIndex(db, file, u.problems, rebuilt, u, e.embedder, e.why);
    if (e.embedder && (o.embedOnOpen ?? 500) > 0)
      await ix.embed({ max: o.embedOnOpen ?? 500 }).catch((err: Error) => {
        ix.meaningProblem = `the embedding model couldn't run: ${err.message.split("\n")[0]}`;
      });
    return ix;
  } catch (e) {
    db.close();
    throw e;
  }
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
    /** What this open read again: the files changed and removed. */
    readonly update?: UpdateResult,
    /** The embedding model for "similar in meaning" (ADR 0116), when there is one. */
    readonly embedder?: Embedder,
    /** Why there is none. */
    private readonly noEmbedder?: string,
  ) {}

  /** Set when the model is configured but couldn't run. */
  meaningProblem?: string;
  private matrix?: Matrix;
  private rows?: Map<string, number>;

  close(): void {
    this.db.close();
  }

  /** Whether "similar in meaning" is on: a model, and a vector for every node (ADR 0116). */
  meaning(): MeaningState {
    if (this.meaningProblem)
      return { ...meaningState(this.db, undefined, this.meaningProblem), model: this.embedder?.id };
    return meaningState(this.db, this.embedder, this.noEmbedder);
  }

  /** Embed the nodes that have no vector yet (all, or at most `max`). */
  async embed(
    o: { max?: number; progress?: (done: number, of: number) => void } = {},
  ): Promise<number> {
    if (!this.embedder) return 0;
    const n = await embedMissing(this.db, this.embedder, o);
    if (n) {
      this.matrix = undefined;
      this.rows = undefined;
    }
    return n;
  }

  /** Embed what an input will be compared by (its title and paragraphs), so a selection can. */
  async prepare(input: ContextInput | string): Promise<void> {
    if (!this.embedder || this.meaningProblem || !this.meaning().on) return;
    const i = typeof input === "string" ? { text: input } : input;
    await queryVectors(this.db, this.embedder, queryChunks(i)).catch((err: Error) => {
      this.meaningProblem = `the embedding model couldn't run: ${err.message.split("\n")[0]}`;
    });
  }

  /**
   * The nodes nearest an input in meaning, best first: a ranking, never a link (ADR 0116).
   * Undefined, with why, when similarity is off or the input wasn't prepared.
   */
  similar(
    input: ContextInput | string | { key: string },
    o: { kinds?: string[]; limit?: number; floor?: number } = {},
  ): { hits: { key: string; cos: number }[] } | { off: string } {
    const state = this.meaning();
    if (!state.on || !this.embedder) return { off: state.note };
    let queries: QuantVector[];
    let exclude: Set<string> | undefined;
    if (typeof input === "object" && "key" in input) {
      this.matrix ??= loadMatrix(this.db, this.embedder.id);
      const at = this.matrix.keys.indexOf(input.key);
      if (at < 0) return { off: `${input.key} has no vector` };
      const d = this.matrix.dim;
      queries = [
        { q: this.matrix.q.subarray(at * d, (at + 1) * d), scale: this.matrix.scales[at]! },
      ];
      exclude = new Set([input.key]);
    } else {
      const i = typeof input === "string" ? { text: input } : input;
      const chunks = queryChunks(i);
      const vs = chunks.map((c) => cachedQuery(this.db, this.embedder!.id, textSha(c)));
      if (!chunks.length) return { hits: [] };
      if (vs.some((v) => !v)) return { off: "the input wasn't embedded (prepare it first)" };
      queries = vs as QuantVector[];
    }
    this.matrix ??= loadMatrix(this.db, this.embedder.id);
    return {
      hits: nearest(this.matrix, queries, {
        floor: o.floor ?? this.embedder.floor ?? MEANING_FLOOR,
        limit: o.limit ?? 30,
        ...(o.kinds ? { kinds: o.kinds } : {}),
        ...(exclude ? { exclude } : {}),
      }),
    };
  }

  /**
   * How close in meaning each of these nodes is to the texts (ADR 0132 addendum): the best
   * cosine of a node's stored vector over the texts' vectors. The texts are embedded as queries
   * once and kept; a node is never embedded here (a node with no vector is left out). Off, with
   * why, when similarity is off.
   */
  async closeness(
    texts: string[],
    keys: string[],
  ): Promise<{ cos: Map<string, number> } | { off: string }> {
    const state = this.meaning();
    if (!state.on || !this.embedder) return { off: state.note };
    const asked = [...new Set(texts.map((t) => t.replace(/\s+/g, " ").trim()).filter((t) => t))];
    if (!asked.length) return { cos: new Map() };
    let queries: QuantVector[];
    try {
      queries = await queryVectors(this.db, this.embedder, asked);
    } catch (err) {
      this.meaningProblem = `the embedding model couldn't run: ${(err as Error).message.split("\n")[0]}`;
      return { off: this.meaning().note };
    }
    this.matrix ??= loadMatrix(this.db, this.embedder.id);
    this.rows ??= new Map(this.matrix.keys.map((k, i) => [k, i] as const));
    return { cos: cosines(this.matrix, this.rows, queries, keys) };
  }

  /**
   * The estate's names (ADR 0116): each id of these kinds with every name and alias it goes by,
   * in id order, for a model to map an input's names to (the expansion's digest).
   */
  names(kinds: string[]): { id: string; kind: string; names: string[] }[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT d.id AS id, d.kind AS kind, n.name AS name FROM nodes d JOIN names n ON n.id = d.id
         WHERE d.kind IN (${kinds.map(() => "?").join(", ")}) ORDER BY d.id, d.kind, n.name`,
      )
      .all(...kinds) as { id: string; kind: string; name: string }[];
    const out = new Map<string, { id: string; kind: string; names: string[] }>();
    for (const r of rows) {
      const k = `${r.kind}|${r.id}`;
      const e = out.get(k) ?? { id: r.id, kind: r.kind, names: [] };
      if (r.name !== r.id && !e.names.includes(r.name)) e.names.push(r.name);
      out.set(k, e);
    }
    return [...out.values()];
  }

  /** selectContext, with the input embedded first when similarity is on (ADR 0116). */
  async select(input: ContextInput | string, o: SelectOptions): Promise<ContextSelection> {
    await this.prepare(input);
    return selectContext(this, input, o);
  }

  /**
   * The index's version: a hash of every file it read, so the same files give the same version
   * on every machine. Selections are cached under it.
   */
  get version(): string {
    return (
      (
        this.db.prepare("SELECT value FROM meta WHERE key = 'generation'").get() as
          { value: string } | undefined
      )?.value ?? "empty"
    );
  }

  /** Full-text search over every node (ADR 0107 point 2): names and ids rank above prose. */
  search(text: string, o: SearchOptions = {}): SearchHit[] {
    return searchIndex(this, text, o);
  }

  /** The context a step should see for its input, fitted to a budget (ADR 0107 point 3). */
  selectContext(input: ContextInput | string, o: SelectOptions): ContextSelection {
    return selectContext(this, input, o);
  }

  /** The nodes with this id, whatever their kind (a catalog record, a flow, an item...). */
  nodes(id: string): GraphNodeRow[] {
    return nodesById(this, id);
  }

  /** What a node links to and what links to it, each with how the link was made. */
  links(key: string): NodeLink[] {
    return linksOf(this, key);
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
