import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HandoffRuntime, judgeStandIn } from "@maycombhq/ai";
import { memoryJudgments, parseRecord } from "@maycombhq/core";
import { judgeFacts, mapFacts, readPage, syncSources } from "../src/index.js";
import {
  FORGE_ROOT,
  forgeExpected,
  forgePack,
  forgeRecords,
  forgeReaches,
  forgeSystems,
  record,
} from "./helpers.js";

interface ExpectedInputs {
  documentConflicts: { doc: string; claim: string; code: string }[];
  documentOnlyFacts: { system: string; fact: string; becomes: string }[];
}

/**
 * Wiki paths are relative to the metarepo root (fixtures/forge/metarepo), while
 * expected/inputs.yaml writes them relative to fixtures/forge, hence the "../".
 */
const fromForge = (doc: string) => `../${doc}`;

describe("mapFacts on the Forge wiki against the expected catalog", () => {
  async function run() {
    const op = await forgePack();
    const records = forgeRecords();
    const { pages } = await syncSources({ root: FORGE_ROOT, orgPack: op, records });
    return mapFacts({ pages, records, systems: forgeSystems(op), reaches: forgeReaches });
  }

  it("finds exactly the two document conflicts of expected/inputs.yaml (d12), code winning", async () => {
    const res = await run();
    const expected = forgeExpected<ExpectedInputs>("inputs.yaml");
    expect(res.documentConflicts.map(({ doc, claim, code }) => ({ doc, claim, code }))).toEqual(
      expected.documentConflicts.map((c) => ({ ...c, doc: fromForge(c.doc) })),
    );
    expect(res.documentConflicts.map((c) => [c.line, c.records, c.factType])).toEqual([
      [6, ["if-e7344c9455608119"], "interaction"],
      [7, ["ledger-db.entry"], "data-access"],
    ]);
    // Every record d12 names is covered by a conflict.
    const d12 = forgeExpected<{ id: string; refs: string[] }[]>("discrepancies.yaml").find(
      (d) => d.id === "d12-doc-conflicts",
    )!;
    expect(res.documentConflicts.flatMap((c) => c.records)).toEqual(d12.refs);
  });

  it("finds exactly the two document-only facts, proposed as inferred Obligations with document evidence", async () => {
    const res = await run();
    const expected = forgeExpected<ExpectedInputs>("inputs.yaml");
    expect(
      res.documentOnlyFacts.map(({ system, fact, becomes }) => ({ system, fact, becomes })),
    ).toEqual(expected.documentOnlyFacts);
    expect(res.documentOnlyFacts.map((f) => f.record)).toEqual([
      {
        schemaVersion: 3,
        kind: "Obligation",
        id: "ledger.slo.99-9-monthly-availability",
        status: "current",
        confidence: "inferred",
        system: "ledger",
        obligationKind: "slo",
        value: "99.9% monthly availability",
        assertedBy: "../inputs/wiki/ledger-solution-spec.md",
        evidence: [
          {
            source: "document",
            path: "../inputs/wiki/ledger-solution-spec.md",
            line: 9,
            side: "document",
          },
        ],
      },
      {
        schemaVersion: 3,
        kind: "Obligation",
        id: "ledger.volume.200-requests-per-second",
        status: "current",
        confidence: "inferred",
        system: "ledger",
        obligationKind: "volume",
        value: "200 requests per second",
        assertedBy: "../inputs/wiki/ledger-solution-spec.md",
        evidence: [
          {
            source: "document",
            path: "../inputs/wiki/ledger-solution-spec.md",
            line: 9,
            side: "document",
          },
        ],
      },
    ]);
    for (const f of res.documentOnlyFacts) expect(parseRecord(f.record).ok).toBe(true);
  });

  it("lists every claim it read with whether code agrees", async () => {
    const res = await run();
    expect(res.claims.map((c) => [c.line, c.factType, c.status])).toEqual([
      [3, "owner", "agrees"],
      [5, "interaction", "agrees"],
      [6, "interaction", "conflicts"],
      [7, "data-access", "conflicts"],
      [9, "slo", "document-only"],
      [9, "volume", "document-only"],
    ]);
  });

  it("does not propose a fact the catalog already holds", async () => {
    const op = await forgePack();
    const records = [
      ...forgeRecords(),
      record({
        kind: "Obligation",
        id: "ledger.slo",
        confidence: "asserted",
        system: "ledger",
        obligationKind: "slo",
        value: "99.9% monthly availability",
        assertedBy: "team-ledger",
        evidence: [{ source: "manual", by: "a.owner" }],
      }),
    ];
    const { pages } = await syncSources({ root: FORGE_ROOT, orgPack: op, records });
    const res = mapFacts({ pages, records, systems: forgeSystems(op), reaches: forgeReaches });
    expect(res.documentOnlyFacts.map((f) => f.fact)).toEqual(["Peak load 200 requests per second"]);
  });
});

describe("mapFacts on small pages", () => {
  const records = [
    record({
      kind: "System",
      id: "hub",
      confidence: "verified",
      name: "Hub",
      boundary: "product",
      owner: "team-hub",
      evidence: [{ source: "config", repo: "hub-repo", path: "hub.yaml" }],
    }),
    record({
      kind: "Component",
      id: "hub-api",
      confidence: "verified",
      system: "hub",
      repo: "hub-repo",
      type: "service",
      evidence: [{ source: "config", repo: "hub-repo", path: "hub.yaml" }],
    }),
    record({
      kind: "Interface",
      id: "if-e327b66861c4dee5",
      confidence: "verified",
      from: "hub-api",
      to: "contoso-ledger",
      via: "gateway",
      normalizedPath: "/v1/postings",
      sync: "sync",
      evidence: [
        { source: "code", repo: "hub-repo", path: "Client.java", line: 4, side: "caller" },
      ],
    }),
  ];
  const systems = [
    { id: "hub", name: "Hub", aliases: [] },
    { id: "contoso-ledger", name: "Contoso Ledger", aliases: ["Contoso"] },
  ];

  it("reports a conflict when the page says direct and the code goes through the gateway", () => {
    const page = readPage({
      source: "w",
      path: "wiki/hub.md",
      content: "# Hub\n\nThe Hub API calls Contoso Ledger directly.\nOwner: Payments guild\n",
      records,
      systems,
    });
    const res = mapFacts({ pages: [page], records, systems, reaches: () => "direct" });
    expect(res.documentConflicts).toEqual([
      {
        id: "conflict.wiki-hub.3.if-e327b66861c4dee5",
        doc: "wiki/hub.md",
        line: 3,
        claim: "The Hub API calls Contoso Ledger directly",
        code: "interface if-e327b66861c4dee5 is via gateway",
        records: ["if-e327b66861c4dee5"],
        factType: "interaction",
      },
      {
        id: "conflict.wiki-hub.4.hub",
        doc: "wiki/hub.md",
        line: 4,
        claim: "Owner: Payments guild",
        code: "system hub is owned by team-hub",
        records: ["hub"],
        factType: "owner",
      },
    ]);
  });

  it("keeps a claim code can't confirm as document-only, never as a fact", () => {
    const page = readPage({
      source: "w",
      path: "wiki/c.md",
      content: "# Contoso\n\nContoso calls the Hub API through the gateway.\n",
      records,
      systems,
    });
    const res = mapFacts({ pages: [page], records, systems, reaches: () => "gateway" });
    expect(res.documentConflicts).toEqual([]);
    expect(res.documentOnlyFacts).toEqual([]);
    expect(res.claims.map((c) => [c.factType, c.status, c.from, c.to])).toEqual([
      ["interaction", "document-only", "contoso-ledger", "hub"],
    ]);
  });
});

describe("how one system reaches another is a judgment (ADR 0117 addendum)", () => {
  const NOW = new Date("2026-10-23T12:00:00Z");
  const run = async () => {
    const op = await forgePack();
    const records = forgeRecords();
    const { pages } = await syncSources({ root: FORGE_ROOT, orgPack: op, records });
    return { pages, records, systems: forgeSystems(op) };
  };

  it("asks the judge of every sentence naming two systems, in one prompt, and keeps the verdicts", async () => {
    const input = await run();
    const judge = judgeStandIn(
      (it) => {
        const v = forgeReaches(it);
        return { verdict: v, quotes: [{ of: "sentence", text: it.texts.sentence! }] };
      },
      { now: () => NOW },
    );
    const store = memoryJudgments();
    const res = await judgeFacts(input, { runtime: judge.runtime, store, now: NOW });
    expect(judge.calls()).toBe(1);
    expect(res.documentConflicts.map((c) => [c.line, c.factType])).toEqual([
      [6, "interaction"],
      [7, "data-access"],
    ]);
    // Read back with no model: the same claims, nothing asked.
    const again = await judgeFacts(input, { store, now: NOW });
    expect(again.claims).toEqual(res.claims);
    expect(judge.calls()).toBe(1);
  });

  it("with the hand-off runtime asks nothing: each such sentence is unjudged, for a person", async () => {
    const input = await run();
    const root = await mkdtemp(join(tmpdir(), "atticus-facts-"));
    const runtime = new HandoffRuntime({ root, validate: async () => [], now: () => NOW });
    const res = await judgeFacts(input, { runtime, store: memoryJudgments(), now: NOW });
    // No word rule stands in: no conflict is claimed from words like "through" or "directly".
    expect(res.documentConflicts).toEqual([]);
    expect(
      res.claims.filter((c) => c.status === "unjudged").map((c) => [c.line, c.from, c.to]),
    ).toEqual([
      [5, "portal", "ledger"],
      [6, "ledger", "northwind-pay"],
      [7, "reports", "ledger"],
    ]);
    // A format is still read as one: the owner line and the service levels.
    expect(res.documentOnlyFacts).toHaveLength(2);
  });
});
