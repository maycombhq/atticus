import { describe, expect, it } from "vitest";
import { parseRecord } from "@maycombhq/core";
import {
  coverage,
  diffPatterns,
  knowledgeGaps,
  mapFacts,
  scanPatterns,
  syncSources,
} from "@maycombhq/knowledge";
import {
  expectedFile,
  HARBOR_ROOT,
  harborPack,
  harborRecords,
  harborSystems,
  scanHarbor,
  type Discrepancy,
  type ExpectedInputs,
} from "./harbor.js";

/**
 * Stage: knowledge. The Harbor wiki against the expected catalog (document conflicts and
 * document-only facts), Harbor's own pattern codes, knowledge gaps with owner questions, and
 * coverage, hand-counted from expected/scan.yaml.
 */

const inputs = expectedFile<ExpectedInputs>("inputs.yaml");
const seeded = expectedFile<Discrepancy[]>("discrepancies.yaml");
/** Wiki paths are relative to the metarepo root; inputs.yaml writes them relative to fixtures/harbor. */
const fromHarbor = (doc: string) => `../${doc}`;

async function facts() {
  const op = await harborPack();
  const records = harborRecords();
  const { pages } = await syncSources({ root: HARBOR_ROOT, orgPack: op, records });
  return { op, records, pages, res: mapFacts({ pages, records, systems: harborSystems(op) }) };
}

describe("the Harbor wiki against the catalog", () => {
  it("finds exactly the two document conflicts of expected/inputs.yaml (h13), code winning", async () => {
    const { res } = await facts();
    expect(res.documentConflicts.map(({ doc, claim, code }) => ({ doc, claim, code }))).toEqual(
      inputs.documentConflicts.map((c) => ({ ...c, doc: fromHarbor(c.doc) })),
    );
    expect(res.documentConflicts.map((c) => [c.line, c.records, c.factType])).toEqual([
      [6, ["if-a24c46bb442ec4b3"], "interaction"],
      [8, ["orders-db.orders"], "data-access"],
    ]);
    const h13 = seeded.find((d) => d.id === "h13-doc-conflicts")!;
    expect(res.documentConflicts.flatMap((c) => c.records)).toEqual(h13.refs);
  });

  it("finds exactly the two document-only facts, proposed as inferred Obligations", async () => {
    const { res } = await facts();
    expect(
      res.documentOnlyFacts.map(({ system, fact, becomes }) => ({ system, fact, becomes })),
    ).toEqual(inputs.documentOnlyFacts);
    expect(res.documentOnlyFacts.map((f) => [f.record.id, f.record.confidence, f.line])).toEqual([
      ["orders.slo.99-95-monthly-availability", "inferred", 10],
      ["orders.volume.120-requests-per-second", "inferred", 10],
    ]);
    for (const f of res.documentOnlyFacts) expect(parseRecord(f.record).ok).toBe(true);
  });

  it("lists every claim it read with whether code agrees", async () => {
    const { res } = await facts();
    expect(res.claims.map((c) => [c.doc.split("/").pop(), c.line, c.factType, c.status])).toEqual([
      ["checkout-solution-spec.md", 3, "owner", "agrees"],
      ["checkout-solution-spec.md", 6, "interaction", "conflicts"],
      ["checkout-solution-spec.md", 7, "interaction", "agrees"],
      ["checkout-solution-spec.md", 8, "data-access", "conflicts"],
      ["checkout-solution-spec.md", 10, "slo", "document-only"],
      ["checkout-solution-spec.md", 10, "volume", "document-only"],
    ]);
  });

  it("reads Harbor's own pattern codes from its patterns page, agreeing with the org pack", async () => {
    const { op, pages } = await facts();
    const page = pages.find((p) => p.path.endsWith("integration-patterns.md"))!;
    const drafts = scanPatterns(page);
    expect(drafts.map((d) => d.code)).toEqual(inputs.patterns);
    expect(diffPatterns(drafts, op.patterns)).toEqual({
      new: [],
      changed: [],
      missing: [],
      same: [...inputs.patterns].sort(),
    });
  });
});

describe("knowledge gaps on the expected Harbor catalog", () => {
  const gapSeeds = seeded.filter((d) => d.found_by === "knowledge-gap");

  it("finds the seeded gaps h09, h10, h11 and h12, and nothing else", async () => {
    const gaps = knowledgeGaps({ records: harborRecords(), orgPack: await harborPack() });
    const want = [
      "h09-no-vendor-timeouts",
      "h10-catalog-consumer-unmonitored",
      "h11-schedules-unmonitored",
      "h12-fraud-score-unknown-owner",
    ];
    expect(gaps.map((g) => g.records)).toEqual(
      want.flatMap((id) => {
        const d = gapSeeds.find((x) => x.id === id)!;
        // One gap per interface for h09, one per workload for h11.
        return id === "h09-no-vendor-timeouts" || id === "h11-schedules-unmonitored"
          ? d.refs.map((r) => [r])
          : [d.refs];
      }),
    );
    expect(gaps.map((g) => [g.check, g.system, g.owner])).toEqual([
      ["call-resilience-known", "payments", "team-payments"],
      ["call-resilience-known", "payments", "team-payments"],
      ["call-resilience-known", "engagement", "team-growth"],
      ["unattended-workload-monitored", "catalog", "team-catalog"],
      ["unattended-workload-monitored", "engagement", "team-growth"],
      ["unattended-workload-monitored", "analytics", "team-data"],
      // Fraud has no owner in the profile: the platform owner (pack.yaml) gets the question.
      ["component-source-known", "fraud", "team-platform"],
    ]);
  });

  it("asks each owner a plain question naming the fact it needs", async () => {
    const gaps = knowledgeGaps({ records: harborRecords(), orgPack: await harborPack() });
    expect(gaps.map((g) => [g.question.id, g.question.question, g.question.neededFact])).toEqual([
      [
        "q.call-resilience-known.if-a4ccfcea11eeebf0",
        "What timeout and retry settings does payments-svc use when it calls tidewater-payments? Pattern HB.VND.EGRESS needs them (Egress allow-list, timeout, retry with idempotency key).",
        "Setting (timeout, retry) on payments-svc targeting tidewater-payments",
      ],
      [
        "q.call-resilience-known.if-018d1416ec04a61a",
        "What timeout and retry settings does payments-svc use when it calls tidewater-payments? Pattern HB.VND.EGRESS needs them (Egress allow-list, timeout, retry with idempotency key).",
        "Setting (timeout, retry) on payments-svc targeting tidewater-payments",
      ],
      [
        "q.call-resilience-known.if-10465a7b9c85231e",
        "What timeout and retry settings does cart-reminder use when it calls lantern-mail? Pattern HB.VND.EGRESS needs them (Egress allow-list, timeout, retry with idempotency key).",
        "Setting (timeout, retry) on cart-reminder targeting lantern-mail",
      ],
      [
        "q.unattended-workload-monitored.catalog-svc",
        "Which alert or dashboard watches catalog-svc? It runs without a caller waiting (an event consumer), so a failure goes unnoticed without one.",
        "ObservabilityAsset (alert or dashboard) for catalog-svc",
      ],
      [
        "q.unattended-workload-monitored.cart-reminder",
        "Which alert or dashboard watches cart-reminder? It runs without a caller waiting (started by a schedule), so a failure goes unnoticed without one.",
        "ObservabilityAsset (alert or dashboard) for cart-reminder",
      ],
      [
        "q.unattended-workload-monitored.warehouse-pipeline",
        "Which alert or dashboard watches warehouse-pipeline? It runs without a caller waiting (a data pipeline), so a failure goes unnoticed without one.",
        "ObservabilityAsset (alert or dashboard) for warehouse-pipeline",
      ],
      [
        "q.component-source-known.fraud-score",
        "Who owns fraud-score, which repo holds its code, and is there an interface spec? It is known only from calls by orders-svc.",
        "Component repo, System owner and an interface spec for fraud-score",
      ],
    ]);
    for (const g of gaps) expect(parseRecord(g.question).ok).toBe(true);
  });

  it("finds h11: the scheduled function and the pipeline have no alert", async () => {
    const gaps = knowledgeGaps({ records: harborRecords(), orgPack: await harborPack() });
    const h11 = gapSeeds.find((d) => d.id === "h11-schedules-unmonitored")!;
    for (const ref of h11.refs)
      expect(
        gaps.some((g) => g.check === "unattended-workload-monitored" && g.records.includes(ref)),
        ref,
      ).toBe(true);
  });

  it("finds h10 and h12 from the scanned catalog too (end to end)", async () => {
    const gaps = knowledgeGaps({
      records: (await scanHarbor()).records,
      orgPack: await harborPack(),
    });
    const ids = gaps.map((g) => g.question.id);
    expect(ids).toContain("q.unattended-workload-monitored.catalog-svc");
    expect(ids).toContain("q.component-source-known.fraud-score");
  });

  it("finds h09 from the scanned catalog (end to end)", async () => {
    const gaps = knowledgeGaps({
      records: (await scanHarbor()).records,
      orgPack: await harborPack(),
    });
    const h09 = gapSeeds.find((d) => d.id === "h09-no-vendor-timeouts")!;
    expect(
      gaps
        .filter((g) => g.check === "call-resilience-known")
        .flatMap((g) => g.records)
        .sort(),
    ).toEqual([...h09.refs].sort());
  });
});

describe("coverage of the expected Harbor catalog", () => {
  it("counts, per system, the areas verified from code, document-only or unknown, and the gaps", async () => {
    const res = coverage({ records: harborRecords(), orgPack: await harborPack() });
    expect(
      res.systems.map(({ system, verified, documentOnly, unknown, gaps }) => ({
        system,
        verified,
        documentOnly,
        unknown,
        gaps,
      })),
    ).toEqual([
      // Hand-counted from expected/scan.yaml. Areas: interfaces, data, runtime,
      // observability, access, quality, obligations (vendors: interfaces and obligations).
      // analytics: data (warehouse, its readers), runtime (the DAG schedule).
      { system: "analytics", verified: 2, documentOnly: 0, unknown: 5, gaps: 1 },
      // catalog: interfaces, data, runtime, quality (CI).
      { system: "catalog", verified: 4, documentOnly: 0, unknown: 3, gaps: 1 },
      // engagement: interfaces, runtime (function and schedule).
      { system: "engagement", verified: 2, documentOnly: 0, unknown: 5, gaps: 2 },
      // fraud: the one call to it.
      { system: "fraud", verified: 1, documentOnly: 0, unknown: 6, gaps: 1 },
      { system: "lantern-mail", verified: 1, documentOnly: 0, unknown: 1, gaps: 0 },
      // orders: everything but access and obligations.
      { system: "orders", verified: 5, documentOnly: 0, unknown: 2, gaps: 0 },
      // payments: interfaces, runtime, observability.
      { system: "payments", verified: 3, documentOnly: 0, unknown: 4, gaps: 2 },
      // recommendations: interfaces, data (feature store), runtime (KServe).
      { system: "recommendations", verified: 3, documentOnly: 0, unknown: 4, gaps: 0 },
      // storefront: interfaces, runtime, observability, quality.
      { system: "storefront", verified: 4, documentOnly: 0, unknown: 3, gaps: 0 },
      { system: "tidewater-payments", verified: 1, documentOnly: 0, unknown: 1, gaps: 0 },
    ]);
    expect(res.areas).toEqual([
      { area: "interfaces", verified: 9, documentOnly: 0, unknown: 1, expected: 10 },
      { area: "data", verified: 4, documentOnly: 0, unknown: 4, expected: 8 },
      { area: "runtime", verified: 7, documentOnly: 0, unknown: 1, expected: 8 },
      { area: "observability", verified: 3, documentOnly: 0, unknown: 5, expected: 8 },
      { area: "access", verified: 0, documentOnly: 0, unknown: 8, expected: 8 },
      { area: "quality", verified: 3, documentOnly: 0, unknown: 5, expected: 8 },
      { area: "obligations", verified: 0, documentOnly: 0, unknown: 10, expected: 10 },
    ]);
  });

  it("counts the checkout spec's service levels as document-only, not as known", async () => {
    const { op, records, res } = await facts();
    const c = coverage({
      records,
      documents: res.documentOnlyFacts.map((f) => f.record),
      orgPack: op,
    });
    expect(c.systems.find((s) => s.system === "orders")).toMatchObject({
      verified: 5,
      documentOnly: 1,
      unknown: 1,
    });
  });
});
