import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, type CatalogRecord, type FlowRecord } from "@maycombhq/core";
import { parseReferenceFlows, scoreSpecs, whatSimilarity } from "../src/spec-bench.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SPECS = join(HERE, "../../../fixtures/specs");
const BENCH_FLOWS = join(HERE, "../../../bench/flows");
const C = "src/main/java/forge/orders/OrderController.java";

const records = (): CatalogRecord[] =>
  (parse(readFileSync(join(SPECS, "catalog.yaml"), "utf8")) as unknown[]).map((r) => {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(JSON.stringify(p.issues));
    return p.record;
  });
const placeOrder = (): FlowRecord => {
  const p = parseRecord(
    parse(readFileSync(join(SPECS, "expected", "forge-orders.place-order.yaml"), "utf8")),
  );
  if (!p.ok || p.record.kind !== "Flow") throw new Error("not a flow");
  return p.record;
};
const ev = (line: number) => [{ source: "code" as const, repo: "forge-orders", path: C, line }];
/** A drafted flow for GET /orders/{orderId} standing for DELETE too (a family). */
const getOrder = (): FlowRecord => ({
  ...placeOrder(),
  id: "forge-orders.get-order",
  name: "A client reads an order, or cancels it",
  trigger: {
    kind: "endpoint",
    ref: "forge-orders.get-orders-orderid",
    what: "A client asks for an order",
    evidence: ev(17),
  },
  family: ["forge-orders.delete-orders-orderid"],
  steps: [
    { kind: "entry", what: "OrderController.get receives the orderId", refs: [], evidence: ev(17) },
    {
      kind: "lookup",
      what: "The order is looked up by id",
      refs: [],
      store: { table: "forge-orders-db.orders", columns: ["id", "sku", "quantity"] },
      evidence: ev(19),
    },
    { kind: "respond", what: "200 with the order", refs: [], evidence: ev(19) },
  ],
  errors: [],
});

describe("scoring drafted specs against reference flows (ADR 0079)", () => {
  it("reads every reference flow file of the bench", () => {
    const files = readdirSync(BENCH_FLOWS).filter((f) => f.endsWith(".yaml"));
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const f of files) {
      const r = parseReferenceFlows(readFileSync(join(BENCH_FLOWS, f), "utf8"));
      expect(r.flows.length, f).toBeGreaterThan(0);
    }
  });

  it("matches segments by citation or entry point, and steps in order", () => {
    const ref = parseReferenceFlows(readFileSync(join(SPECS, "reference.yaml"), "utf8"));
    const s = scoreSpecs(
      ref,
      [{ repo: "forge-orders", flows: [placeOrder(), getOrder()] }],
      records(),
    );
    const [place, cancel] = s.flows;
    // place-order starts in the UI, which has no spec: its trigger isn't covered, but its
    // forge-orders segment matches place-order (the trigger cites line 9, the segment starts at 10).
    expect(place!.triggerCovered).toBe(false);
    expect(place!.segments).toEqual([
      { repo: "forge-shop-ui", steps: 1, stepsMatched: 0, citationsCorrect: 0 },
      {
        repo: "forge-orders",
        matched: "forge-orders.place-order",
        steps: 5,
        stepsMatched: 4, // all but the validate step, which the draft hasn't got
        citationsCorrect: 4,
      },
    ]);
    expect(place!.tables).toEqual({ want: 1, found: 1, missed: [] });
    expect(place!.fields).toEqual({ want: 3, found: 3 });
    // cancel-order is covered by get-order's family (DELETE's entry point cites line 22); the
    // entry matches on its words, the delete has no step in the draft.
    expect(cancel!.triggerCovered).toBe(true);
    expect(cancel!.segments).toEqual([
      {
        repo: "forge-orders",
        matched: "forge-orders.get-order",
        steps: 2,
        stepsMatched: 1,
        citationsCorrect: 0,
      },
    ]);
    expect(s.total).toEqual({
      flows: 2,
      triggersCovered: 1,
      segments: 3,
      segmentsCovered: 2,
      steps: 8,
      stepsMatched: 5,
      tables: { want: 2, found: 2 },
      fields: { want: 4, found: 4 },
      citations: { checked: 5, correct: 4 },
    });
    // With no drafted specs nothing is covered.
    expect(scoreSpecs(ref, []).total.stepsMatched).toBe(0);
  });

  it("compares what steps say on their words", () => {
    expect(
      whatSimilarity(
        "OrderController.cancel receives the orderId",
        "OrderController.get receives the orderId",
      ),
    ).toBeCloseTo(0.6);
    expect(whatSimilarity("The order is deleted", "201 with the order")).toBeLessThan(0.5);
  });

  it("counts the flows that cross repos and are reached end to end through the joins (ADR 0085)", () => {
    const E = join(HERE, "../../../fixtures/estate");
    const recs = (parse(readFileSync(join(E, "catalog.yaml"), "utf8")) as unknown[]).map((r) => {
      const p = parseRecord(r);
      if (!p.ok) throw new Error(JSON.stringify(p.issues));
      return p.record;
    });
    const specs = ["forge-web", "forge-customers"].map((repo) => ({
      repo,
      flows: readdirSync(join(E, "specs", repo)).map((n) => {
        const p = parseRecord(parse(readFileSync(join(E, "specs", repo, n), "utf8")));
        if (!p.ok || p.record.kind !== "Flow") throw new Error(n);
        return p.record;
      }),
    }));
    const joins = (
      parse(readFileSync(join(E, "expected", "estate.yaml"), "utf8")) as {
        joins: { from: { flow: string }; to: { flow: string } }[];
      }
    ).joins;
    const ref = parseReferenceFlows(readFileSync(join(E, "reference.yaml"), "utf8"));
    const s = scoreSpecs(ref, specs, recs, { specs, records: recs, joins });
    expect(s.total.endToEnd).toEqual({
      want: 3,
      found: 2,
      reached: ["save-customer", "view-customer"],
    });
    // Without joins, nothing crosses; without the estate pass, nothing is counted.
    expect(
      scoreSpecs(ref, specs, recs, { specs, records: recs, joins: [] }).total.endToEnd!.found,
    ).toBe(0);
    expect(scoreSpecs(ref, specs, recs).total.endToEnd).toBeUndefined();
  });
});
