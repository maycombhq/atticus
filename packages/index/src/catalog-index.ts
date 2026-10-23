import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stateDirOf, type CatalogRecord, type RecordKind } from "@maycombhq/core";
import { openDb, type Db } from "./db.js";
import { compileQuery, parseQuery } from "./query.js";
import { listSources } from "./sources.js";
import { ensureSchema, updateIndex, type IndexProblem, type UpdateResult } from "./store.js";
import {
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
    return new CatalogIndex(db, file, u.problems, rebuilt, u);
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
  ) {}

  close(): void {
    this.db.close();
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
