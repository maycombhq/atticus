import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { applyCurated, type CatalogRecord } from "@maycombhq/core";
import {
  applyGlossary,
  buildGlossary,
  readDefinitionProposals,
  type GlossaryBuild,
  type GlossaryTermRecord,
} from "../src/index.js";
import {
  decisions,
  ev,
  extraRecords,
  FIXTURES,
  fixturePages,
  forgePages,
  forgeRecords,
} from "./helpers.js";

interface Expected {
  terms: Record<string, unknown>[];
  columnLinks: unknown[];
  conflicts: unknown[];
  hints: unknown[];
  synonyms?: Record<string, string[]>;
}
const expected = (f: string) =>
  parse(readFileSync(join(FIXTURES, "expected", f), "utf8")) as Expected;

const termView = (t: GlossaryTermRecord, withConfidence: boolean) => ({
  id: t.id,
  term: t.term,
  definition: t.definition,
  ...(withConfidence ? { confidence: t.confidence } : {}),
  ...(t.owner ? { owner: t.owner } : {}),
  fields: t.fields,
  flags: t.flags ?? [],
  evidence: t.evidence.map(ev),
});

const view = (b: GlossaryBuild, terms: GlossaryTermRecord[], withConfidence: boolean) => ({
  terms: terms.map((t) => termView(t, withConfidence)),
  columnLinks: b.columnLinks,
  conflicts: b.conflicts.map((c) => ({ term: c.term, kind: c.kind, message: c.message })),
  hints: b.hints.map((h) => ({ record: h.record, term: h.term, kind: h.kind, message: h.message })),
});

describe("glossary on Forge as it is (golden)", () => {
  it("finds the code's domain words and no wiki terms", () => {
    const b = buildGlossary({ pages: forgePages(), records: forgeRecords() });
    expect(b.problems).toEqual([]);
    const want = expected("forge-terms.yaml");
    expect(view(b, b.terms, false)).toEqual(want);
    for (const t of b.terms) expect(t.confidence).toBe("inferred");
  });

  it("links matching columns to their terms, leaving other columns alone", () => {
    const b = buildGlossary({ pages: forgePages(), records: forgeRecords() });
    const out = applyGlossary(forgeRecords(), b);
    const cols = out.filter((r) => r.kind === "Column");
    expect(
      Object.fromEntries(cols.filter((c) => c.glossaryTerm).map((c) => [c.id, c.glossaryTerm])),
    ).toEqual({
      "ledger-db.account.account-number": "term.account-number",
      "ledger-db.account.holder-name": "term.holder-name",
      "ledger-db.entry.account-id": "term.account",
    });
    expect(out.filter((r) => r.kind === "GlossaryTerm")).toHaveLength(7);
  });
});

describe("glossary with definitions, conflicts, synonyms, proposals and decisions (golden)", () => {
  async function run() {
    const records = [...forgeRecords(), ...extraRecords()];
    const { proposals } = await readDefinitionProposals(join(FIXTURES, "proposals"));
    const b = buildGlossary({
      pages: [...forgePages(), ...fixturePages()],
      records,
      decisions: decisions(),
      proposals,
    });
    const applied = applyCurated(applyGlossary(records, b), decisions());
    return { b, applied };
  }

  it("matches the hand-written terms, links, conflicts and hints", async () => {
    const { b, applied } = await run();
    expect(b.problems).toEqual([]);
    expect(applied.problems).toEqual([]);
    const terms = applied.records.filter((r): r is GlossaryTermRecord => r.kind === "GlossaryTerm");
    const want = expected("glossary-terms.yaml");
    const { synonyms, ...rest } = want;
    expect(view(b, terms, true)).toEqual(rest);
    expect(
      Object.fromEntries(b.entries.filter((e) => e.aliases.length).map((e) => [e.id, e.aliases])),
    ).toEqual(synonyms);
  });

  it("says where each term came from", async () => {
    const { b } = await run();
    const src = Object.fromEntries(b.entries.map((e) => [e.id, e.sources]));
    expect(src["term.transfer"]).toEqual(["wiki", "code"]);
    expect(src["term.payment"]).toEqual(["code", "ai"]);
    expect(src["term.remaining-limit"]).toEqual(["person"]);
    expect(src["term.daily-total"]).toEqual(["code"]);
  });

  it("lets a person's definition settle a definition conflict", async () => {
    const records = [...forgeRecords(), ...extraRecords()];
    const define: CatalogRecord = {
      ...decisions()[1]!,
      id: "glossary.define.transfer",
      target: "term.transfer",
      value: { term: "Transfer", definition: "Moving an amount out of an account." },
    } as CatalogRecord;
    const b = buildGlossary({
      pages: [...forgePages(), ...fixturePages()],
      records,
      decisions: [...decisions(), define],
    });
    const t = b.terms.find((x) => x.id === "term.transfer")!;
    expect(t.flags ?? []).not.toContain("conflict:definition");
    expect(t.definition).toBe("Moving an amount out of an account.");
    expect(b.conflicts.find((c) => c.term === "term.transfer")?.resolved).toBe(true);
  });

  it("applies decisions oldest first by the instant their `at` names, then by id", () => {
    // 23:00+05:30 is 17:30Z, before 18:00Z, though its text sorts after it: the 18:00Z
    // definition is the later one, whatever order the decisions come in.
    const records = [...forgeRecords(), ...extraRecords()];
    const define = (id: string, at: string, definition: string): CatalogRecord =>
      ({
        ...decisions()[1]!,
        id,
        target: "term.transfer",
        value: { term: "Transfer", definition },
        at,
      }) as CatalogRecord;
    const early = define(
      "glossary.define.transfer.b",
      "2026-11-12T23:00:00+05:30",
      "Moving an amount out of an account.",
    );
    const late = define(
      "glossary.define.transfer.a",
      "2026-11-12T18:00:00Z",
      "Moving an amount between two accounts.",
    );
    for (const ds of [
      [early, late],
      [late, early],
    ]) {
      const b = buildGlossary({
        pages: [...forgePages(), ...fixturePages()],
        records,
        decisions: [...decisions(), ...ds],
      });
      expect(b.terms.find((x) => x.id === "term.transfer")!.definition).toBe(
        "Moving an amount between two accounts.",
      );
    }
    // the same instant: the greater id is the later
    const same = define("glossary.define.transfer.c", "2026-11-12T18:00:00Z", "A move of money.");
    for (const ds of [
      [same, late],
      [late, same],
    ])
      expect(
        buildGlossary({ pages: [], records, decisions: ds }).terms.find(
          (x) => x.id === "term.transfer",
        )!.definition,
      ).toBe("A move of money.");
  });

  it("keeps a person's column link over a match by name", async () => {
    const records = [...forgeRecords(), ...extraRecords()];
    const link = {
      ...decisions()[1]!,
      id: "glossary.link.reports-db.daily-total.daily-limit",
      target: "reports-db.daily-total.daily-limit",
      value: { glossaryTerm: "term.daily-total" },
    } as CatalogRecord;
    const b = buildGlossary({
      pages: [...forgePages(), ...fixturePages()],
      records,
      decisions: [...decisions(), link],
    });
    expect(b.columnLinks.filter((l) => l.column === "reports-db.daily-total.daily-limit")).toEqual([
      { column: "reports-db.daily-total.daily-limit", term: "term.daily-total", how: "decision" },
    ]);
    expect(b.terms.find((t) => t.id === "term.daily-total")!.fields).toEqual([
      "reports-db.daily-total.daily-limit",
    ]);
  });
});
