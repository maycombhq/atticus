import { describe, expect, it } from "vitest";
import { parseRecord, type FlowRecord } from "@maycombhq/core";
import {
  applyStroke,
  drawnStrokes,
  FlowDelta,
  isDrawnStep,
  sketchOf,
  Stroke,
  mergeDelta,
} from "../src/index.js";

/**
 * ADR 0179: a change sketched on the canvas. Each stroke becomes a flow delta in the change's
 * target-flows/, the same files the architecture stage writes; the change diagram then draws it
 * with its marks. On an invented Forge estate; nothing is a fact.
 */

const ev = (line: number) => [
  { source: "code", repo: "forge-orders", path: "src/Orders.java", line },
];

const flow = (id: string, component: string, steps: object[]): FlowRecord => {
  const r = parseRecord({
    kind: "Flow",
    schemaVersion: 2,
    id,
    component,
    name: `Flow ${id}`,
    template: "default@1",
    trigger: { kind: "endpoint", what: "POST /x is called", evidence: ev(10) },
    steps: steps.map((s, i) => ({ refs: [], evidence: ev(11 + i), ...s })),
  });
  if (!r.ok || r.record.kind !== "Flow") throw new Error(JSON.stringify(r));
  return r.record;
};

const orders = flow("forge-orders.place-order", "forge-orders", [
  { kind: "entry", what: "The order arrives" },
  {
    kind: "call-out",
    what: "Stock is reserved",
    to: { component: "forge-stock", entry: "POST /reservations" },
  },
  { kind: "respond", what: "201 goes back" },
]);
const estate = {
  flows: [
    { repo: "forge-orders", flow: orders },
    {
      repo: "forge-stock",
      flow: flow("forge-stock.reserve", "forge-stock", [
        { kind: "entry", what: "A reservation arrives" },
      ]),
    },
    {
      repo: "forge-stock",
      flow: flow("forge-stock.release", "forge-stock", [
        { kind: "entry", what: "A release arrives" },
      ]),
    },
  ],
  ids: new Set([
    "forge-orders",
    "forge-stock",
    "forge-stock.reserve",
    "forge-stock.release",
    "forge-orders.place-order",
  ]),
};

const stroke = (s: unknown) => Stroke.parse(s);

describe("strokes become flow deltas", () => {
  it("a new call from a component with one flow lands on that flow as an added call-out step", () => {
    const r = applyStroke(
      [],
      stroke({
        kind: "call",
        from: { component: "forge-orders" },
        to: { component: "forge-fraud", entry: "POST /screen", new: true },
        what: "The order is screened.",
      }),
      estate,
      "pat",
    );
    expect(r.problem).toBeUndefined();
    expect(r.changed).toEqual(["forge-orders.place-order"]);
    const d = FlowDelta.parse(r.deltas[0]);
    expect(d).toMatchObject({
      change: "modify",
      repo: "forge-orders",
      why: "Drawn on the canvas by pat.",
    });
    expect(d.steps).toMatchObject([
      {
        op: "add",
        kind: "call-out",
        what: "The order is screened.",
        to: { component: "forge-fraud", entry: "POST /screen", new: true },
      },
    ]);
    // Every drawn step carries its mark, so Undo and the stage find exactly it.
    expect(isDrawnStep(d.steps[0]!)).toBe(true);
    expect(d.steps[0]!.why).toMatch(/^drawn on the canvas by pat, stroke [a-z0-9]+$/);
    // The change diagram draws it from the merge, marked added.
    const m = mergeDelta(d, orders);
    expect(m.steps.some((s) => s.mark === "added" && s.to?.component === "forge-fraud")).toBe(true);
  });

  it("asks which flow when the component has several, and names a new flow for one with none", () => {
    const several = applyStroke(
      [],
      stroke({
        kind: "call",
        from: { component: "forge-stock" },
        to: { component: "forge-orders", entry: "GET /orders/{id}" },
      }),
      estate,
      "pat",
    );
    expect(several.problem).toContain("2 flows");
    expect(several.pick?.flows.map((f) => f.id)).toEqual([
      "forge-stock.reserve",
      "forge-stock.release",
    ]);
    expect(several.deltas).toEqual([]);
    const none = applyStroke(
      [],
      stroke({
        kind: "call",
        from: { component: "forge-fraud" },
        to: { component: "forge-orders", entry: "GET /orders/{id}" },
      }),
      estate,
      "pat",
    );
    expect(none.problem).toContain("no flow on the map yet");
  });

  it("a stroke lands on the component's own flow, never a sibling's delta in the same repo; a drawn new flow counts as its own", () => {
    const sibling = FlowDelta.parse({
      schemaVersion: 2,
      flow: "forge-stock.reserve",
      repo: "forge-stock",
      change: "modify",
      why: "The stage's reason.",
      steps: [{ op: "add", kind: "log", what: "Logged." }],
    });
    // forge-orders and forge-stock share no repo here, so make the sibling delta of orders' repo.
    const r = applyStroke(
      [{ ...sibling, repo: "forge-orders" }],
      stroke({
        kind: "call",
        from: { component: "forge-orders" },
        to: { component: "forge-fraud", entry: "POST /screen" },
      }),
      estate,
      "pat",
    );
    expect(r.changed).toEqual(["forge-orders.place-order"]);
    const first = applyStroke(
      [],
      stroke({
        kind: "call",
        from: {
          component: "forge-fraud",
          newFlow: {
            id: "forge-fraud.screen",
            name: "An order is screened",
            trigger: { kind: "endpoint", what: "POST /screen is called" },
          },
        },
        to: { component: "northwind-fraud", entry: "POST /v1/score" },
      }),
      estate,
      "pat",
    );
    // The second stroke from the new box needs no re-naming of its flow.
    const second = applyStroke(
      first.deltas,
      stroke({
        kind: "table",
        from: { component: "forge-fraud" },
        op: "write",
        table: "forge-fraud-db.verdicts",
      }),
      estate,
      "pat",
    );
    expect(second.problem).toBeUndefined();
    expect(second.deltas[0]!.steps).toHaveLength(2);
    // A flow named that isn't the component's is refused.
    expect(
      applyStroke(
        [],
        stroke({
          kind: "call",
          from: { component: "forge-orders", flow: "forge-stock.reserve" },
          to: { component: "forge-fraud", entry: "POST /screen" },
        }),
        estate,
        "pat",
      ).problem,
    ).toContain("isn't a flow of forge-orders");
  });

  it("a flow this change removes takes no stroke", () => {
    const gone = FlowDelta.parse({
      schemaVersion: 2,
      flow: "forge-orders.place-order",
      repo: "forge-orders",
      change: "remove",
      why: "Orders are placed elsewhere now.",
      steps: [],
    });
    const call = applyStroke(
      [gone],
      stroke({
        kind: "call",
        from: { component: "forge-orders" },
        to: { component: "forge-fraud", entry: "POST /screen" },
      }),
      estate,
      "pat",
    );
    expect(call.problem).toContain("is removed in this change");
    expect(call.deltas).toEqual([gone]);
    const rm = applyStroke(
      [gone],
      stroke({ kind: "remove", flow: "forge-orders.place-order", step: 2, why: "x" }),
      estate,
      "pat",
    );
    expect(rm.problem).toContain("is removed in this change");
  });

  it("a new box: a new flow of a component the catalog lacks carries where it runs", () => {
    const r = applyStroke(
      [],
      stroke({
        kind: "call",
        from: {
          component: "forge-fraud",
          newFlow: {
            id: "forge-fraud.screen",
            name: "An order is screened",
            trigger: { kind: "endpoint", what: "POST /screen is called" },
            runsOn: { system: "fraud", platform: "aks" },
          },
        },
        to: { component: "northwind-fraud", entry: "POST /v1/score" },
      }),
      estate,
      "pat",
    );
    const d = FlowDelta.parse(r.deltas[0]);
    expect(d).toMatchObject({
      change: "new",
      flow: "forge-fraud.screen",
      name: "An order is screened",
      runsOn: { component: "forge-fraud", system: "fraud", platform: "aks" },
    });
    expect(d.steps[0]!.to).toEqual({
      component: "northwind-fraud",
      entry: "POST /v1/score",
      new: false,
    });
  });

  it("a line deleted removes the step; a line dragged elsewhere removes it and adds the new target", () => {
    const removed = applyStroke(
      [],
      stroke({
        kind: "remove",
        flow: "forge-orders.place-order",
        step: 2,
        why: "Stock is no longer reserved here.",
      }),
      estate,
      "pat",
    );
    expect(removed.deltas[0]!.steps).toHaveLength(1);
    expect(removed.deltas[0]!.steps[0]).toMatchObject({ op: "remove", step: 2 });
    // The person's reason is kept, with the mark.
    expect(removed.deltas[0]!.steps[0]!.why).toMatch(
      /^Stock is no longer reserved here\. \(drawn on the canvas by pat, stroke [a-z0-9]+\)$/,
    );
    const moved = applyStroke(
      [],
      stroke({
        kind: "retarget",
        flow: "forge-orders.place-order",
        step: 2,
        to: { component: "forge-inventory", entry: "POST /holds", new: true },
        why: "Inventory takes over reservations.",
      }),
      estate,
      "pat",
    );
    expect(moved.deltas[0]!.steps).toMatchObject([
      { op: "remove", step: 2 },
      {
        op: "add",
        after: 2,
        kind: "call-out",
        what: "Stock is reserved",
        to: { component: "forge-inventory", entry: "POST /holds", new: true },
      },
    ]);
    const m = mergeDelta(moved.deltas[0]!, orders);
    expect(m.steps.map((s) => s.mark)).toContain("removed");
    expect(m.steps.map((s) => s.mark)).toContain("added");
    // Undo takes both halves of the retarget back, as one stroke.
    const list = drawnStrokes(moved.deltas);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      what: "step 2 sent to forge-inventory POST /holds",
      by: "pat",
    });
    const back = applyStroke(
      moved.deltas,
      stroke({ kind: "undo", flow: "forge-orders.place-order", index: list[0]!.index }),
      estate,
      "pat",
    );
    expect(back.deltas).toEqual([]);
    // The same step can't be changed twice.
    const twice = applyStroke(
      moved.deltas,
      stroke({ kind: "remove", flow: "forge-orders.place-order", step: 2, why: "again" }),
      estate,
      "pat",
    );
    expect(twice.problem).toContain("changed already");
  });

  it("a topic with a listener writes the publish on one flow and the listener on the other; a table writes a store step", () => {
    const t = applyStroke(
      [],
      stroke({
        kind: "topic",
        from: { component: "forge-orders" },
        topic: "forge.orders.placed",
        listener: { component: "forge-stock", flow: "forge-stock.reserve" },
      }),
      estate,
      "pat",
    );
    expect(t.changed).toEqual(["forge-orders.place-order", "forge-stock.reserve"]);
    expect(t.deltas[0]!.steps[0]).toMatchObject({
      kind: "publish",
      to: { component: "forge-stock", entry: "forge.orders.placed" },
    });
    // The listener's step goes nowhere: no `to`, so the picture draws one line, publisher → listener.
    expect(t.deltas[1]!.steps[0]).toMatchObject({
      kind: "entry",
      what: "Listens on forge.orders.placed.",
    });
    expect(t.deltas[1]!.steps[0]!.to).toBeUndefined();
    // A topic with no listener yet names no component (no line to itself).
    const alone = applyStroke(
      [],
      stroke({ kind: "topic", from: { component: "forge-orders" }, topic: "forge.orders.placed" }),
      estate,
      "pat",
    );
    expect(alone.deltas[0]!.steps[0]!.to).toBeUndefined();
    const w = applyStroke(
      t.deltas,
      stroke({
        kind: "table",
        from: { component: "forge-orders" },
        op: "write",
        table: "forge-orders-db.screenings",
        columns: ["verdict"],
        new: true,
      }),
      estate,
      "pat",
    );
    expect(w.deltas[0]!.steps[1]).toMatchObject({
      kind: "write",
      store: { table: "forge-orders-db.screenings", columns: ["verdict"], new: true },
    });
  });

  it("undo takes one stroke back, and a delta drawn here with nothing left goes", () => {
    const one = applyStroke(
      [],
      stroke({
        kind: "call",
        from: { component: "forge-orders" },
        to: { component: "forge-fraud", entry: "POST /screen" },
      }),
      estate,
      "pat",
    );
    const back = applyStroke(
      one.deltas,
      stroke({ kind: "undo", flow: "forge-orders.place-order", index: 0 }),
      estate,
      "pat",
    );
    expect(back.deltas).toEqual([]);
    // A step the stage wrote can't be taken back here; a drawn step on the stage's delta can,
    // and the stage's delta keeps its file.
    const staged = [
      FlowDelta.parse({
        schemaVersion: 2,
        flow: "forge-orders.place-order",
        repo: "forge-orders",
        change: "modify",
        why: "The stage's reason.",
        steps: [{ op: "add", kind: "log", what: "Logged." }],
      }),
    ];
    const refused = applyStroke(
      staged,
      stroke({ kind: "undo", flow: "forge-orders.place-order", index: 0 }),
      estate,
      "pat",
    );
    expect(refused.problem).toContain("wasn't drawn on the canvas");
    const onStaged = applyStroke(
      staged,
      stroke({
        kind: "call",
        from: { component: "forge-orders" },
        to: { component: "forge-fraud", entry: "POST /screen" },
      }),
      estate,
      "pat",
    );
    // Only the drawn step is the stage's frame.
    expect(sketchOf(onStaged.deltas)[0]!.steps).toHaveLength(1);
    expect(drawnStrokes(onStaged.deltas)).toMatchObject([{ index: 1 }]);
    const kept = applyStroke(
      onStaged.deltas,
      stroke({ kind: "undo", flow: "forge-orders.place-order", index: 1 }),
      estate,
      "pat",
    );
    expect(kept.deltas).toHaveLength(1);
    expect(kept.deltas[0]!.steps).toHaveLength(1);
  });
});
