import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { CatalogRecord } from "@maycombhq/core";
import { fsRepo, scanRepo } from "@maycombhq/sdk";
import { migrationsExtractor } from "../src/index.js";
import { parseDdl } from "../src/lang/sql.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures/data");
const SHA = "0123456789abcdef0123456789abcdef01234567";

type Rec = Record<string, unknown> & { kind: string; id: string; evidence: Rec[] };

/** Evidence as an extractor writes it: the runner's stamps removed. */
function bare(r: CatalogRecord): Rec {
  const x = r as unknown as Rec;
  return {
    ...x,
    evidence: x.evidence.map((e) => {
      const { repo: _r, commit: _c, scannedAt: _s, extractor: _x, ...rest } = e;
      return rest;
    }),
  };
}

describe("ALTER TABLE in migrations", () => {
  it("reads ADD, DROP, ALTER, MODIFY and RENAME COLUMN actions with lines", () => {
    const d = parseDdl(`ALTER TABLE payout
  ADD COLUMN a INT NOT NULL,
  DROP COLUMN IF EXISTS b;
ALTER TABLE payout ALTER COLUMN c SET DATA TYPE varchar(10) USING c::varchar;
ALTER TABLE payout ALTER COLUMN c SET DEFAULT 'x';
ALTER TABLE payout ADD CONSTRAINT fk_x FOREIGN KEY (a) REFERENCES other (id);
ALTER TABLE payout RENAME COLUMN a TO z;`);
    expect(d.alters.map((a) => [a.op, a.table, a.column, a.line])).toEqual([
      ["add-column", "payout", "a", 2],
      ["drop-column", "payout", "b", 3],
      ["alter-column", "payout", "c", 4],
      ["alter-column", "payout", "c", 5],
      ["rename-column", "payout", "a", 7],
    ]);
    expect(d.alters[2]).toMatchObject({ type: "varchar(10)" });
    expect(d.alters[3]).toMatchObject({ default: "'x'" });
    expect(d.alters[4]).toMatchObject({ to: "z" });
    expect(d.operations).toEqual([
      "alter table payout add column a",
      "alter table payout drop column b",
      "alter table payout alter column c",
      "alter table payout alter column c",
      "alter table payout add constraint",
      "alter table payout rename column a to z",
    ]);
  });

  it("gives the latest table state after every migration in version order (golden)", async () => {
    const s = await scanRepo({
      repo: fsRepo("alter-migrations", join(FIX, "alter-migrations"), SHA),
      extractors: [migrationsExtractor],
      scannedAt: "2026-10-18T08:00:00Z",
      repoInfo: { component: "payouts-api", system: "payouts" },
    });
    expect(s.rejected).toEqual([]);
    expect(s.runs.filter((r) => r.status === "failed")).toEqual([]);
    const want = (
      parse(readFileSync(join(FIX, "alter-migrations.expected.yaml"), "utf8")) as Rec[]
    ).map((r) => ({ schemaVersion: 3, status: "current", ...r }));
    const key = (l: Rec[]) =>
      [...l].sort((a, b) => `${a.kind}/${a.id}`.localeCompare(`${b.kind}/${b.id}`));
    const g = key(s.records.map(bare));
    const w = key(want);
    expect(g.map((r) => `${r.kind}/${r.id}`)).toEqual(w.map((r) => `${r.kind}/${r.id}`));
    for (let i = 0; i < w.length; i++) expect(g[i], `${w[i]!.kind}/${w[i]!.id}`).toEqual(w[i]);
  });
});

describe("golang-migrate files", () => {
  it("take the version from <version>_<name>.up.sql, in order, and skip the .down.sql files", async () => {
    const { memoryRepo } = await import("@maycombhq/sdk");
    const s = await scanRepo({
      repo: memoryRepo("catalog", SHA, {
        "migrations/0002_add_stock.up.sql": "CREATE TABLE stock (id int);",
        "migrations/0002_add_stock.down.sql": "DROP TABLE stock;",
        "migrations/0010_add_price.up.sql": "ALTER TABLE products ADD COLUMN price int;",
        "migrations/0001_create_products.up.sql": "CREATE TABLE products (id int);",
        "migrations/0001_create_products.down.sql": "DROP TABLE products;",
      }),
      extractors: [migrationsExtractor],
      repoInfo: { component: "catalog" },
    });
    expect(
      s.records
        .filter((r) => r.kind === "Migration")
        .map((r) => {
          const x = r as unknown as { version: string; file: string; tool: string };
          return `${r.id} ${x.version} ${x.tool} ${x.file}`;
        }),
    ).toEqual([
      "catalog-db.v0001 0001 other migrations/0001_create_products.up.sql",
      "catalog-db.v0002 0002 other migrations/0002_add_stock.up.sql",
      "catalog-db.v0010 0010 other migrations/0010_add_price.up.sql",
    ]);
    // The down migrations don't undo the tables.
    expect(
      s.records
        .filter((r) => r.kind === "Table")
        .map((r) => r.id)
        .sort(),
    ).toEqual(["catalog-db.products", "catalog-db.stock"]);
  });
});
