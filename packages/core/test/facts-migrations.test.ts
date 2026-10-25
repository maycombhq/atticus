import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrationOf, parseFacts, parseRecord, projectFacts, type Fact } from "../src/index.js";

/**
 * Migrations from the facts (ADR 0124 addendum B-places, gap 3): a column or store fact cited in
 * a migration file makes a Migration record for its store, so the stages know the store's
 * migrations (their folder, names and numbering) and can tell a new migration from a schema file
 * changed in place. No new fact shape: the reader already cites a column where it is declared.
 */

const text = readFileSync(
  join(__dirname, "fixtures", "facts", "forge-orders-migrations.facts.jsonl"),
  "utf8",
);
function facts(): Fact[] {
  const r = parseFacts(text);
  if (!r.ok) throw new Error(JSON.stringify(r.issues, null, 2));
  return r.facts;
}

describe("migrationOf: a migration file, by the tool's own naming", () => {
  it.each([
    ["src/main/resources/db/migration/V1__orders.sql", "flyway", "1"],
    ["db/migration/V2_1__add_note.sql", "flyway", "2_1"],
    ["src/main/java/db/migration/V4__Backfill.java", "flyway", "4"],
    ["src/main/resources/db/changelog/db.changelog-1.0.xml", "liquibase", "db.changelog-1.0"],
    ["db/changelog/changes/002-add-note.yaml", "liquibase", "002-add-note"],
    ["backend/app/alembic/versions/e2412789c190_initialize_models.py", "alembic", "e2412789c190"],
    ["migrations/versions/1a2b3c4d5e6f_add_note.py", "alembic", "1a2b3c4d5e6f"],
    ["prisma/migrations/20240101120000_init/migration.sql", "prisma", "20240101120000_init"],
    ["src/Forge.Orders/Migrations/20240101120000_AddNote.cs", "other", "20240101120000"],
    ["src/migrations/1700000000000-AddNote.ts", "other", "1700000000000"],
    ["db/migrate/20240101120000_add_note_to_orders.rb", "other", "20240101120000"],
    ["orders/migrations/0002_order_note.py", "other", "0002"],
    ["migrations/000003_add_note.up.sql", "other", "000003"],
  ])("%s is a %s migration, version %s", (path, tool, version) => {
    expect(migrationOf(path)).toEqual({ tool, version });
  });

  it.each([
    "src/main/resources/schema.sql",
    "src/main/resources/db/hsqldb/schema.sql",
    "backend/app/models.py",
    "src/Forge.Orders/Migrations/20240101120000_AddNote.Designer.cs",
    "src/Forge.Orders/Migrations/OrdersContextModelSnapshot.cs",
    "backend/app/alembic/env.py",
    "backend/app/alembic/versions/__init__.py",
    "orders/migrations/__init__.py",
    "migrations/000003_add_note.down.sql",
    "src/main/java/forge/orders/Order.java",
  ])("%s is not a migration", (path) => {
    expect(migrationOf(path)).toBeUndefined();
  });
});

describe("projectFacts: the migrations the facts cite become Migration records", () => {
  const out = projectFacts(facts(), { system: "orders" });
  const migrations = out.records.filter((r) => r.kind === "Migration") as Record<string, unknown>[];

  it("one per migration file a column of the store is cited in, with what the facts say of it", () => {
    expect(migrations.map((m) => m.id)).toEqual(["forge-orders-db.v1", "forge-orders-db.v3"]);
    expect(migrations[0]).toMatchObject({
      dataStore: "forge-orders-db",
      version: "1",
      tool: "flyway",
      file: "src/main/resources/db/migration/V1__orders.sql",
      operations: ["table orders (sku, quantity)"],
      confidence: "verified",
    });
    // The quote says how the file changes the table: an ALTER TABLE adds the column.
    expect(migrations[1]).toMatchObject({
      version: "3",
      file: "src/main/resources/db/migration/V3__order_note.sql",
      operations: ["alter table orders (note)"],
    });
    expect(
      (migrations[0]!.evidence as { path: string; line: number }[]).map((e) => e.line),
    ).toEqual([3, 4]);
    for (const m of migrations) {
      const p = parseRecord(m);
      if (!p.ok) throw new Error(JSON.stringify(p.issues));
    }
  });

  it("an entity or schema file a column is cited in is no migration", () => {
    // stock.on_hand is cited in Stock.java: the store has no migration for it, and none is made.
    expect(migrations.some((m) => String(m.file).endsWith("Stock.java"))).toBe(false);
    expect(out.records.find((r) => r.id === "forge-orders-db.stock.on_hand")).toBeTruthy();
  });

  it("comes after the columns, and is the same twice", () => {
    const kinds = out.records.map((r) => r.kind);
    expect(kinds.lastIndexOf("Column")).toBeLessThan(kinds.indexOf("Migration"));
    expect(JSON.stringify(projectFacts(facts(), { system: "orders" }).records)).toBe(
      JSON.stringify(out.records),
    );
  });
});
