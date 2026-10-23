import { describe, expect, it } from "vitest";
import { Estimates } from "@maycombhq/core";
import { classOf, estimateChange, type EstimateFlow } from "../src/estimate.js";

/**
 * A change's estimate (ADR 0109): its size counted from the target flows, each changed step a
 * class of work, the org pack's ranges per class summed by a seeded simulation, the drivers
 * named, and never a number nobody stands behind.
 */

const TABLE = Estimates.parse({
  schemaVersion: 1,
  source: "The Forge platform team, September 2026 (invented figures)",
  classes: [
    { match: "add/call-out/vendor/*", days: { p20: 2, p50: 3, p80: 5 } },
    { match: "add/call-out/*", days: { p20: 1, p50: 1.5, p80: 3 } },
    { match: "change/write/migration", days: { p20: 1, p50: 1.5, p80: 2.5 } },
    { match: "add/branch", days: { p20: 0.25, p50: 0.5, p80: 1 } },
    { match: "new-flow/*", days: { p20: 1, p50: 2, p80: 4 } },
  ],
  perExtraRepo: { p20: 0.5, p50: 1, p80: 2 },
  risks: { "unconfirmed-step": 1.2, "open-blocking": 1.3 },
});

const FLOWS: EstimateFlow[] = [
  {
    flow: "forge-orders.place-order",
    repo: "forge-orders",
    change: "modify",
    file: "openspec/changes/add-fraud-check/target-flows/forge-orders.place-order.yaml",
    steps: [
      { mark: "same", kind: "entry", target: 1 },
      {
        mark: "added",
        kind: "call-out",
        target: 2,
        what: "Northwind Pay screens the order",
        to: { component: "northwind-pay", entry: "POST /v1/screenings", new: true },
      },
      { mark: "added", kind: "branch", target: 3, what: "A rejected order is refused" },
      {
        mark: "changed",
        kind: "write",
        target: 5,
        what: "The order is inserted with the verdict",
        store: { table: "forge-orders-db.orders", migration: "V4__add_fraud_verdict.sql" },
        confirmedBy: "ai",
      },
      { mark: "added", kind: "log", target: 6, what: "The verdict is logged" },
    ],
  },
  {
    flow: "forge-stock.screen-order",
    repo: "forge-stock",
    change: "new",
    trigger: "job",
    file: "openspec/changes/add-fraud-check/target-flows/forge-stock.screen-order.yaml",
    steps: [{ mark: "added", kind: "read", target: 1, what: "The held orders are read" }],
  },
];

const vendor = (c: string) => (c === "northwind-pay" ? "vendor" : undefined);
const base = { change: "add-fraud-check", flows: FLOWS, boundaryOf: vendor, openBlocking: 0 };

describe("a step's class of work (ADR 0109)", () => {
  it("is its op and kind, then what it reaches", () => {
    expect(classOf(FLOWS[0]!.steps[1]!, vendor)).toBe("add/call-out/vendor/new-entry");
    expect(classOf(FLOWS[0]!.steps[3]!, vendor)).toBe("change/write/migration");
    expect(classOf(FLOWS[0]!.steps[2]!, vendor)).toBe("add/branch");
    expect(
      classOf({ mark: "added", kind: "lookup", store: { table: "t", new: true } }, vendor),
    ).toBe("add/lookup/new-table");
    expect(classOf({ mark: "removed", kind: "publish" }, vendor)).toBe("remove/publish");
  });
});

describe("a change's estimate (ADR 0109)", () => {
  it("counts the work: each changed step, and each new flow once, never the unchanged steps", () => {
    const e = estimateChange({ ...base, table: TABLE });
    expect(e.units.map((u) => u.class)).toEqual([
      "add/call-out/vendor/new-entry",
      "add/branch",
      "change/write/migration",
      "add/log",
      "new-flow/job",
      "add/read",
    ]);
    // The first unit cites its target flow and step.
    expect(e.units[0]).toMatchObject({
      flow: "forge-orders.place-order",
      repo: "forge-orders",
      step: 2,
      source: "openspec/changes/add-fraud-check/target-flows/forge-orders.place-order.yaml",
      days: { p20: 2, p50: 3, p80: 5 },
    });
  });

  it("gives no number for work no class matches: it says the work needs a class", () => {
    const e = estimateChange({ ...base, table: TABLE });
    const unclassed = e.units.filter((u) => !u.days).map((u) => u.class);
    expect(unclassed).toEqual(["add/log", "add/read"]);
    expect(e.needsClass).toBe(2);
  });

  it("sums the ranges by a seeded simulation, the same every time, with a coordination cost per extra repo", () => {
    const a = estimateChange({ ...base, table: TABLE });
    const b = estimateChange({ ...base, table: TABLE });
    expect(a.effort).toEqual(b.effort);
    const e = a.effort!;
    expect(e.p20).toBeLessThan(e.p50);
    expect(e.p50).toBeLessThan(e.p80);
    // The classed units' medians (3 + 0.5 + 1.5 + 2) and one extra repo (1), give or take.
    expect(e.p50).toBeGreaterThan(6.5);
    expect(e.p50).toBeLessThan(9.5);
    expect(a.perRepo.map((r) => r.repo)).toEqual(["forge-orders", "forge-stock"]);
  });

  it("names each risk, with its source, and lets the org pack's factor widen only the upper end", () => {
    const calm = estimateChange({ ...base, table: { ...TABLE, risks: {} } });
    const e = estimateChange({ ...base, table: TABLE, openBlocking: 2 });
    expect(e.drivers.map((d) => [d.id, d.count])).toEqual([
      ["new-vendor-call", 1],
      ["migration", 1],
      ["unconfirmed-step", 1],
      ["open-blocking", 2],
      ["repos", 2],
    ]);
    expect(e.drivers.find((d) => d.id === "unconfirmed-step")).toMatchObject({
      widens: 1.2,
      source: "openspec/changes/add-fraud-check/target-flows/forge-orders.place-order.yaml",
    });
    expect(e.effort!.p50).toBe(calm.effort!.p50);
    expect(e.effort!.p80).toBeCloseTo(calm.effort!.p80 * 1.2 * 1.3, 1);
  });

  it("says it isn't calibrated, and whose figures it uses", () => {
    const e = estimateChange({ ...base, table: TABLE });
    expect(e.calibration).toEqual({
      calibrated: false,
      source: "The Forge platform team, September 2026 (invented figures)",
    });
  });

  it("without the org pack's ranges, sizes the work and gives no days", () => {
    const e = estimateChange(base);
    expect(e.effort).toBeUndefined();
    expect(e.units).toHaveLength(6);
    expect(e.needsClass).toBe(6);
    expect(e.calibration).toEqual({ calibrated: false });
  });

  it("puts the calendar at the later of the work and the waiting the release forecast found", () => {
    const e = estimateChange({ ...base, table: TABLE, waitDays: 30 });
    expect(e.calendar).toMatchObject({ waitDays: 30, longer: "waiting" });
    const quick = estimateChange({ ...base, table: TABLE, waitDays: 1 });
    expect(quick.calendar).toMatchObject({ waitDays: 1, longer: "work" });
    // Without days for the work there is nothing to compare the waiting with.
    expect(estimateChange({ ...base, waitDays: 0 }).calendar).toEqual({ waitDays: 0 });
  });

  it("has nothing to size before the architecture stage", () => {
    const e = estimateChange({ ...base, flows: [], table: TABLE });
    expect(e.units).toEqual([]);
    expect(e.effort).toBeUndefined();
  });
});
