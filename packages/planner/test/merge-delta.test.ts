import { describe, expect, it } from "vitest";
import { parseRecord, type FlowRecord } from "@maycombhq/core";
import { FlowDelta, mergeDelta } from "../src/index.js";

/**
 * ADR 0095: a change's target flow beside today's flow, as one list of steps, each marked the
 * same, changed, added or removed, numbered in both flows, so a picture can show before and
 * after at once.
 */

const ev = (line: number) => [
  { source: "code", repo: "forge-orders", path: "src/Orders.java", line },
];

const today = (): FlowRecord => {
  const r = parseRecord({
    kind: "Flow",
    schemaVersion: 2,
    id: "forge-orders.place-order",
    component: "forge-orders",
    name: "A customer places an order",
    template: "default@1",
    trigger: { kind: "endpoint", what: "POST /orders is called", evidence: ev(10) },
    steps: [
      { kind: "entry", what: "The order arrives", refs: [], evidence: ev(11) },
      {
        kind: "validate",
        what: "The order is checked",
        refs: [],
        data: { checks: ["sku"] },
        evidence: ev(12),
      },
      {
        kind: "call-out",
        what: "Stock is reserved",
        refs: [],
        to: { component: "forge-stock", entry: "POST /reservations" },
        evidence: ev(13),
      },
      {
        kind: "write",
        what: "The order is inserted",
        refs: [],
        store: { table: "forge-orders-db.orders", columns: ["sku", "quantity"] },
        evidence: ev(14),
      },
      {
        kind: "retry",
        what: "The insert runs again on a lock timeout",
        refs: [],
        repeats: { from: 4, to: 4 },
        evidence: ev(15),
      },
      { kind: "respond", what: "201 goes back", refs: [], evidence: ev(16) },
    ],
  });
  if (!r.ok || r.record.kind !== "Flow") throw new Error(JSON.stringify(r));
  return r.record;
};

const delta = (o: Partial<FlowDelta>): FlowDelta =>
  FlowDelta.parse({
    schemaVersion: 1,
    flow: "forge-orders.place-order",
    repo: "forge-orders",
    change: "modify",
    why: "The order is screened before stock is reserved.",
    ...o,
  });

describe("a target flow beside today's (ADR 0095)", () => {
  it("marks each step the same, changed, added or removed, numbered in both flows", () => {
    const m = mergeDelta(
      delta({
        steps: [
          {
            op: "add",
            after: 2,
            kind: "call-out",
            what: "Northwind Pay screens the order",
            to: { component: "northwind-pay", entry: "POST /v1/screenings", new: true },
            fields: { sends: ["sku"], returns: ["verdict"] },
          },
          { op: "add", after: 2, kind: "branch", what: "A rejected order is refused with 422" },
          {
            op: "change",
            step: 4,
            what: "The order is inserted with the screen's verdict",
            store: {
              table: "forge-orders-db.orders",
              columns: ["sku", "quantity", "fraud_verdict"],
              new: false,
            },
          },
          { op: "remove", step: 3, why: "Stock is reserved by the warehouse now." },
        ],
      }),
      today(),
    );
    expect(m.steps.map((s) => [s.mark, s.today, s.target, s.kind, s.what])).toEqual([
      ["same", 1, 1, "entry", "The order arrives"],
      ["same", 2, 2, "validate", "The order is checked"],
      ["added", undefined, 3, "call-out", "Northwind Pay screens the order"],
      ["added", undefined, 4, "branch", "A rejected order is refused with 422"],
      ["removed", 3, undefined, "call-out", "Stock is reserved"],
      ["changed", 4, 5, "write", "The order is inserted with the screen's verdict"],
      ["same", 5, 6, "retry", "The insert runs again on a lock timeout"],
      ["same", 6, 7, "respond", "201 goes back"],
    ]);
    const changed = m.steps[5]!;
    expect(changed.was).toEqual({ kind: "write", what: "The order is inserted" });
    expect(changed.store).toEqual({
      table: "forge-orders-db.orders",
      columns: ["sku", "quantity", "fraud_verdict"],
    });
    // Today's citation stays on a kept or changed step; an added step has none yet.
    expect(changed.evidence).toEqual(ev(14));
    expect(m.steps[2]!.evidence).toEqual([]);
    expect(m.steps[2]!.to).toEqual({
      component: "northwind-pay",
      entry: "POST /v1/screenings",
      new: true,
    });
    expect(m.steps[2]!.data).toEqual({ sends: ["sku"], returns: ["verdict"] });
    expect(m.steps[4]!.why).toBe("Stock is reserved by the warehouse now.");
    // The retry repeated today's step 4, which is step 5 in the target flow.
    expect(m.steps[6]!.repeats).toEqual({ from: 5, to: 5 });
    expect(m.counts).toEqual({ added: 2, changed: 1, removed: 1 });
  });

  it("draws a new flow from its steps, all added", () => {
    const m = mergeDelta(
      delta({
        change: "new",
        flow: "forge-orders.screen-order",
        name: "An order is screened",
        trigger: {
          kind: "endpoint",
          what: "POST /screenings is called",
          entry: "POST /screenings",
        },
        steps: [
          { op: "add", after: 0, kind: "entry", what: "The screening request arrives" },
          {
            op: "add",
            after: 1,
            kind: "loop",
            what: "Each line of the order is screened",
            repeats: { from: 3, to: 3 },
          },
          {
            op: "add",
            after: 2,
            kind: "call-out",
            what: "A line is screened",
            to: { component: "northwind-pay", entry: "POST /v1/screenings", new: false },
          },
        ],
      }),
      undefined,
    );
    expect(m.name).toBe("An order is screened");
    expect(m.trigger).toEqual({ kind: "endpoint", what: "POST /screenings is called" });
    expect(m.steps.map((s) => [s.mark, s.today, s.target])).toEqual([
      ["added", undefined, 1],
      ["added", undefined, 2],
      ["added", undefined, 3],
    ]);
    expect(m.steps[1]!.repeats).toEqual({ from: 3, to: 3 });
  });

  it("draws a removed flow as today's steps, all removed", () => {
    const m = mergeDelta(
      delta({ change: "remove", why: "Orders move to the new service." }),
      today(),
    );
    expect(m.steps.every((s) => s.mark === "removed" && s.target === undefined)).toBe(true);
    expect(m.counts).toEqual({ added: 0, changed: 0, removed: 6 });
    expect(m.name).toBe("A customer places an order");
  });

  it("says so when today's flow isn't there for a change to it", () => {
    const m = mergeDelta(delta({ steps: [{ op: "remove", step: 2 }] }), undefined);
    expect(m.problems).toEqual([
      "forge-orders.place-order isn't in forge-orders's spec, so the steps it changes can't be shown.",
    ]);
    expect(m.steps).toEqual([]);
  });
});

describe("a step sent elsewhere (ADR 0108)", () => {
  const delta = (to: { component: string; entry: string }) =>
    FlowDelta.parse({
      schemaVersion: 1,
      flow: "forge-orders.place-order",
      repo: "forge-orders",
      change: "modify",
      why: "Stock moves to the warehouse service.",
      steps: [{ op: "change", step: 3, kind: "call-out", what: "Stock is held", to }],
    });

  it("keeps where it went today, so a picture can draw the old line going", () => {
    const m = mergeDelta(delta({ component: "forge-warehouse", entry: "POST /holds" }), today());
    expect(m.steps[2]).toMatchObject({
      mark: "changed",
      to: { component: "forge-warehouse", entry: "POST /holds" },
      was: { to: { component: "forge-stock", entry: "POST /reservations" } },
    });
  });

  it("says nothing about where it went when that doesn't change", () => {
    const m = mergeDelta(delta({ component: "forge-stock", entry: "POST /reservations" }), today());
    expect(m.steps[2]!.was).toEqual({ kind: "call-out", what: "Stock is reserved" });
  });

  it("keeps the migration a write step names", () => {
    const d = FlowDelta.parse({
      schemaVersion: 1,
      flow: "forge-orders.place-order",
      repo: "forge-orders",
      change: "modify",
      why: "The verdict is kept.",
      steps: [
        {
          op: "change",
          step: 4,
          store: {
            table: "forge-orders-db.orders",
            columns: ["sku", "fraud_verdict"],
            migration: "V4__add_fraud_verdict.sql",
          },
        },
      ],
    });
    expect(mergeDelta(d, today()).steps[3]!.store).toMatchObject({
      migration: "V4__add_fraud_verdict.sql",
    });
  });
});
