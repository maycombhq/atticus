import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, type CatalogRecord } from "@maycombhq/core";
import { fsRepo, scanRepo } from "@maycombhq/sdk";
import { migrationsExtractor } from "../src/index.js";
import { parseDdl } from "../src/lang/sql.js";

/**
 * S2: the values a column allows are a fact its migration states (a CHECK constraint, an ENUM
 * type), so the catalog's Column record carries them with the line that states them, and a step
 * that stores into the table isn't told the value is unknown. Invented Forge Boards fixture.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures/data");
const SHA = "0123456789abcdef0123456789abcdef01234567";

type Rec = Record<string, unknown> & { kind: string; id: string; evidence: Rec[] };

const strip = (e: Rec) => {
  const { repo: _r, commit: _c, scannedAt: _s, extractor: _x, ...rest } = e;
  return rest;
};

/** Evidence as an extractor writes it: the runner's stamps removed, the allowed values' too. */
function bare(r: CatalogRecord): Rec {
  const x = r as unknown as Rec & { allowedValues?: { values: string[]; evidence: Rec } };
  return {
    ...x,
    ...(x.allowedValues
      ? { allowedValues: { ...x.allowedValues, evidence: strip(x.allowedValues.evidence) } }
      : {}),
    evidence: x.evidence.map(strip),
  };
}

describe("allowed values in migrations (S2)", () => {
  it("reads CHECK (column IN (...)) on a column, on the table and by ALTER TABLE, ENUM types and CREATE TYPE ... AS ENUM, with lines", () => {
    const d = parseDdl(
      readFileSync(join(FIX, "allowed-values/db/migration/V1__boards.sql"), "utf8"),
    );
    expect(d.enums).toEqual([{ name: "pin_colour", values: ["red", "amber", "green"], line: 2 }]);
    expect(d.tables[0]!.checks).toEqual([
      {
        name: "board_pin_kind",
        column: "kind",
        values: ["note", "link", "image", "system"],
        line: 11,
      },
    ]);
    // A check written on the column itself is the column's, at its line.
    expect(d.tables[0]!.columns.find((c) => c.name === "state")!.allowed).toEqual({
      values: ["open", "closed"],
      line: 9,
    });
    const v2 = parseDdl(
      readFileSync(join(FIX, "allowed-values/db/migration/V2__pin_size.sql"), "utf8"),
    );
    expect(v2.alters.find((a) => a.column === "layout")!.definition!.allowed).toEqual({
      values: ["grid", "list"],
      line: 3,
    });
    expect(v2.checks).toEqual([
      {
        table: "board_pin",
        name: "board_pin_size",
        column: "size",
        values: ["s", "m", "l"],
        line: 2,
      },
    ]);
    const v3 = parseDdl("ALTER TABLE board_pin DROP CONSTRAINT board_pin_size;");
    expect(v3.droppedConstraints).toEqual([
      { table: "board_pin", name: "board_pin_size", line: 1 },
    ]);
    // A check that isn't a plain list of values is left to the model reading the line.
    expect(parseDdl("CREATE TABLE t (n INT, CHECK (n > 0));").tables[0]!.checks).toEqual([]);
  });

  it("gives each column its allowed values, cited, in the latest state (golden)", async () => {
    const s = await scanRepo({
      repo: fsRepo("allowed-values", join(FIX, "allowed-values"), SHA),
      extractors: [migrationsExtractor],
      scannedAt: "2026-10-24T08:00:00Z",
      repoInfo: { component: "boards-api", system: "boards" },
    });
    expect(s.rejected).toEqual([]);
    expect(s.runs.filter((r) => r.status === "failed")).toEqual([]);
    const want = (
      parse(readFileSync(join(FIX, "allowed-values.expected.yaml"), "utf8")) as Rec[]
    ).map((r) => ({ schemaVersion: 3, status: "current", ...r }));
    const key = (l: Rec[]) =>
      [...l].sort((a, b) => `${a.kind}/${a.id}`.localeCompare(`${b.kind}/${b.id}`));
    const g = key(s.records.map(bare));
    const w = key(want);
    expect(g.map((r) => `${r.kind}/${r.id}`)).toEqual(w.map((r) => `${r.kind}/${r.id}`));
    for (let i = 0; i < w.length; i++) expect(g[i], `${w[i]!.kind}/${w[i]!.id}`).toEqual(w[i]);
    // C1: the field is optional and additive, and the records still parse.
    for (const r of s.records) expect(parseRecord(r).ok, r.id).toBe(true);
  });
});
