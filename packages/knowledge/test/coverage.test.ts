import { describe, expect, it } from "vitest";
import { Api } from "@maycombhq/core";
import { coverage, COVERAGE_AREAS, mapFacts, syncSources, toApiCoverage } from "../src/index.js";
import { FORGE_ROOT, forgePack, forgeRecords, forgeSystems } from "./helpers.js";

describe("coverage of the expected Forge catalog", () => {
  it("defines seven areas from record kinds", () => {
    expect(COVERAGE_AREAS.map((a) => a.area)).toEqual([
      "interfaces",
      "data",
      "runtime",
      "observability",
      "access",
      "quality",
      "obligations",
    ]);
  });

  it("counts, per system, the areas verified from code, document-only or unknown, and the gaps", async () => {
    const res = coverage({ records: forgeRecords(), orgPack: await forgePack() });
    expect(
      res.systems.map(({ system, verified, documentOnly, unknown, gaps }) => ({
        system,
        verified,
        documentOnly,
        unknown,
        gaps,
      })),
    ).toEqual([
      // Hand-counted from expected/scan.yaml: see the area lists below.
      { system: "audit", verified: 1, documentOnly: 0, unknown: 6, gaps: 1 },
      { system: "ledger", verified: 4, documentOnly: 0, unknown: 3, gaps: 1 },
      // A vendor is only expected to have interfaces and obligations.
      { system: "northwind-pay", verified: 1, documentOnly: 0, unknown: 1, gaps: 0 },
      { system: "portal", verified: 3, documentOnly: 0, unknown: 4, gaps: 0 },
      { system: "reports", verified: 2, documentOnly: 0, unknown: 5, gaps: 1 },
    ]);
    const ledger = res.systems.find((s) => s.system === "ledger")!;
    expect(ledger.areas.map((a) => [a.area, a.state])).toEqual([
      ["interfaces", "verified"],
      ["data", "verified"],
      ["runtime", "verified"],
      ["observability", "verified"],
      ["access", "unknown"],
      ["quality", "unknown"],
      ["obligations", "unknown"],
    ]);
    expect(res.areas).toEqual([
      { area: "interfaces", verified: 5, documentOnly: 0, unknown: 0, expected: 5 },
      { area: "data", verified: 2, documentOnly: 0, unknown: 2, expected: 4 },
      { area: "runtime", verified: 2, documentOnly: 0, unknown: 2, expected: 4 },
      { area: "observability", verified: 1, documentOnly: 0, unknown: 3, expected: 4 },
      { area: "access", verified: 1, documentOnly: 0, unknown: 3, expected: 4 },
      { area: "quality", verified: 0, documentOnly: 0, unknown: 4, expected: 4 },
      { area: "obligations", verified: 0, documentOnly: 0, unknown: 5, expected: 5 },
    ]);
  });

  it("counts facts only a document gives as document-only, not as known", async () => {
    const op = await forgePack();
    const records = forgeRecords();
    const { pages } = await syncSources({ root: FORGE_ROOT, orgPack: op, records });
    const facts = mapFacts({ pages, records, systems: forgeSystems(op) });
    const res = coverage({
      records,
      documents: facts.documentOnlyFacts.map((f) => f.record),
      orgPack: op,
    });
    expect(res.systems.find((s) => s.system === "ledger")).toMatchObject({
      verified: 4,
      documentOnly: 1,
      unknown: 2,
    });
    expect(res.areas.find((a) => a.area === "obligations")).toEqual({
      area: "obligations",
      verified: 0,
      documentOnly: 1,
      unknown: 4,
      expected: 5,
    });
  });

  it("matches the local API's Coverage schema", async () => {
    const api = toApiCoverage(coverage({ records: forgeRecords(), orgPack: await forgePack() }));
    expect(Api.Coverage.parse(api)).toEqual(api);
    expect(api.systems.find((s) => s.system === "ledger")).toEqual({
      system: "ledger",
      known: 4,
      expected: 7,
      gaps: 1,
    });
    expect(api.areas[0]).toEqual({ area: "interfaces", known: 5, expected: 5 });
  });
});
