import type { CatalogRecord } from "@maycombhq/core";
import { defineExtractor } from "@maycombhq/sdk";
import { componentOf, evidence } from "../facts.js";
import { slug, storeFor } from "./common.js";
import { readEfCore } from "./orm-efcore.js";
import { readJpa } from "./orm-jpa.js";
import type { OrmModel, Where } from "./orm-model.js";
import { readPrisma } from "./orm-prisma.js";
import { readSqlAlchemy } from "./orm-sqlalchemy.js";

/**
 * ORM mappings → the database design the code expects: DataStore, Table, Column and
 * IndexConstraint, from JPA/Hibernate, EF Core, SQLAlchemy and Prisma.
 *
 * Ids are the migrations extractor's (<store>.<table>, <table>.<column>, <table>.pk,
 * <table>.fk-<referenced table>, <table>.<index name>) and the store is named the same way, so
 * an ORM table and a migration table for the same physical table are one record after merge.
 * ORM facts are `inferred` (code states what it expects, not what the database has); merge
 * keeps the stronger confidence and the first value of each field. The scan sorts records by
 * kind, id and then extractor id, and "migrations" sorts before "orm", so migration types and
 * nullability win where both exist.
 *
 * The owning component reads and writes its mapped tables. Indexes and unique constraints are
 * emitted only when their database name is known (declared, or the ORM's deterministic
 * default), so they can line up with migration-derived ones.
 */
export const ormExtractor = defineExtractor({
  id: "orm",
  version: "1.0.0",
  claims: ["**/*.java", "**/*.cs", "**/*.py", "**/*.prisma"],
  async *scan(repo, ctx) {
    const models: OrmModel[] = [
      await readJpa(repo),
      await readEfCore(repo),
      await readSqlAlchemy(repo),
      await readPrisma(repo),
    ];
    const withTables = models.filter((m) => m.tables.length > 0);
    if (withTables.length === 0) return;
    const owner = componentOf(repo, ctx);
    const store = await storeFor(repo, ctx);
    const ev = (w: Where) => [evidence(repo, { source: "code", path: w.path, line: w.line })];
    const first = withTables[0]!;
    const seen = new Set<string>();
    const emit = (r: Record<string, unknown> & { kind: string; id: string }) => {
      const key = `${r.kind}/${r.id}`;
      if (seen.has(key)) {
        ctx.warn(`${r.kind} ${r.id} is mapped more than once; kept the first`);
        return undefined;
      }
      seen.add(key);
      return {
        schemaVersion: 1,
        status: "current",
        confidence: "inferred",
        ...r,
      } as unknown as CatalogRecord;
    };
    const out: (CatalogRecord | undefined)[] = [];
    out.push(
      emit({
        kind: "DataStore",
        id: store,
        storeType: withTables.find((m) => m.storeType)?.storeType ?? "unknown",
        ownerComponent: owner,
        entitiesHeld: [],
        evidence: ev(first.storeAt ?? first.tables[0]!),
      }),
    );
    for (const t of withTables.flatMap((m) => m.tables)) {
      const tid = `${store}.${slug(t.name)}`;
      out.push(
        emit({
          kind: "Table",
          id: tid,
          dataStore: store,
          name: t.name,
          tableKind: t.tableKind,
          ownerComponent: owner,
          readers: [owner],
          writers: [owner],
          evidence: ev(t),
        }),
      );
      for (const c of t.columns)
        out.push(
          emit({
            kind: "Column",
            id: `${tid}.${slug(c.name)}`,
            table: tid,
            name: c.name,
            type: c.type,
            ...(c.nullable !== undefined ? { nullable: c.nullable } : {}),
            evidence: ev(c),
          }),
        );
      if (t.primaryKey)
        out.push(
          emit({
            kind: "IndexConstraint",
            id: `${tid}.pk`,
            table: tid,
            constraintKind: "primary-key",
            columns: t.primaryKey.columns,
            evidence: ev(t.primaryKey),
          }),
        );
      // Two keys to the same table can't both be fk-<table>: name them by their columns too.
      const refCount = new Map<string, number>();
      for (const fk of t.foreignKeys)
        refCount.set(fk.refTable, (refCount.get(fk.refTable) ?? 0) + 1);
      for (const fk of t.foreignKeys) {
        const suffix = (refCount.get(fk.refTable) ?? 0) > 1 ? `-${slug(fk.columns.join("-"))}` : "";
        out.push(
          emit({
            kind: "IndexConstraint",
            id: `${tid}.fk-${slug(fk.refTable)}${suffix}`,
            table: tid,
            constraintKind: "foreign-key",
            columns: fk.columns,
            references: { table: `${store}.${slug(fk.refTable)}`, columns: fk.refColumns },
            evidence: ev(fk),
          }),
        );
      }
      for (const ix of t.indexes)
        out.push(
          emit({
            kind: "IndexConstraint",
            id: `${tid}.${slug(ix.name)}`,
            table: tid,
            constraintKind: ix.unique ? "unique" : "index",
            columns: ix.columns,
            evidence: ev(ix),
          }),
        );
    }
    for (const r of out) if (r) yield r;
  },
});
