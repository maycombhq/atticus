import { describe, expect, it } from "vitest";
import { Api } from "@maycombhq/core";
import { coverage, COVERAGE_AREAS, mapFacts, syncSources, toApiCoverage } from "../src/index.js";
import {
  FORGE_ROOT,
  forgePack,
  forgeReaches,
  forgeRecords,
  forgeSystems,
  record,
} from "./helpers.js";

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
    const facts = mapFacts({ pages, records, systems: forgeSystems(op), reaches: forgeReaches });
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

describe("coverage of a catalog read from facts, with no System record (2026-10-25)", () => {
  const at = [{ source: "code", repo: "forge-studio", path: "api/Notes.java", line: 15 }];
  const studio = () => [
    record({
      kind: "Component",
      id: "api",
      confidence: "verified",
      system: "studio",
      repo: "forge-studio",
      type: "service",
      evidence: at,
    }),
    record({
      kind: "Interface",
      id: "if-227370d7866959d3",
      confidence: "verified",
      from: "api",
      to: "llm",
      via: "direct",
      method: "POST",
      normalizedPath: "/v1/messages",
      sync: "sync",
      direction: "outbound",
      conflicts: [],
      evidence: at,
    }),
  ];

  it("counts the system the manifest names, and the outside system a call names", async () => {
    const op = await forgePack();
    const manifest = {
      platform: "forge",
      repos: {
        schemaVersion: 1,
        platform: "forge",
        repos: [
          {
            id: "forge-studio",
            url: "https://git.forge.example/forge-studio.git",
            system: "studio",
          },
          { id: "forge-docs", url: "https://git.forge.example/forge-docs.git", system: "docs" },
        ],
      },
    } as unknown as (typeof op.profiles)[number];
    const res = coverage({ records: studio(), orgPack: { ...op, profiles: [manifest] } });
    expect(res.systems.map((s) => [s.system, s.verified, s.areas.length])).toEqual([
      // A system the manifest names that nothing was read of yet: all unknown.
      ["docs", 0, 7],
      // Outside the estate: only its interfaces and obligations are expected, as a vendor's.
      ["llm", 1, 2],
      ["studio", 1, 7],
    ]);
  });
});
