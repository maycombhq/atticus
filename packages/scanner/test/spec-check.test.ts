import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  DEFAULT_SPEC_TEMPLATE,
  parseRecord,
  type CatalogRecord,
  type FlowRecord,
} from "@maycombhq/core";
import { fsRepo } from "@maycombhq/sdk";
import {
  checkSpec,
  lineNamesField,
  lineNamesRoute,
  resourceKey,
  specTriggers,
} from "../src/spec-check.js";

const SPECS = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/specs");
const repo = () => fsRepo("forge-orders", join(SPECS, "repos", "forge-orders"), "0".repeat(40));
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
const C = "src/main/java/forge/orders/OrderController.java";
const ev = (line: number, path = C) => [
  { source: "code" as const, repo: "forge-orders", path, line },
];
const unconfirmed = (f: FlowRecord): FlowRecord => ({
  ...f,
  steps: f.steps.map(({ confirmedBy: _c, ...s }) => s),
});
const run = (flows: FlowRecord[]) =>
  checkSpec({
    repo: repo(),
    repoId: "forge-orders",
    flows,
    records: records(),
    template: DEFAULT_SPEC_TEMPLATE,
  });

describe("atticus spec check: the critic (ADR 0079)", () => {
  it("finds the triggers the template asks for in the catalog", () => {
    expect(
      specTriggers(records(), "forge-orders", DEFAULT_SPEC_TEMPLATE).map((t) => [t.id, t.label]),
    ).toEqual([
      ["forge-orders.delete-orders-orderid", "DELETE /orders/{orderId}"],
      ["forge-orders.get-orders-orderid", "GET /orders/{orderId}"],
      ["forge-orders.post-orders", "POST /orders"],
    ]);
  });

  it("confirms the steps whose cited lines name what they claim, and no others", async () => {
    const r = await run([unconfirmed(placeOrder())]);
    expect(r.flows[0]!.steps.map((s) => [s.kind, s.confirmedBy])).toEqual([
      ["entry", "check"], // /orders on line 4
      ["call-out", "check"], // /stock/reservations on line 7
      ["transform", undefined], // never by the check
      ["write", "check"], // orders on line 13
      ["respond", undefined], // id, sku and quantity aren't on line 14
    ]);
    expect(r.flows[0]).toEqual(placeOrder());
    expect(r.confirmed).toBe(3);
    // GET and DELETE have no flow yet.
    expect(r.findings.map((f) => [f.rule, f.target, f.evidence])).toEqual([
      ["no-flow", "trigger forge-orders.delete-orders-orderid", `${C}:22`],
      ["no-flow", "trigger forge-orders.get-orders-orderid", `${C}:17`],
    ]);
    expect(r.findings[0]!.fingerprint).toMatch(/^[0-9a-f]{12}$/);
  });

  it("finds missing lines, unknown columns, a write without columns, fields from nowhere and false check claims", async () => {
    const f = placeOrder();
    const steps = f.steps.map((s) => ({ ...s }));
    steps[1] = { ...steps[1]!, data: { sends: ["sku", "colour"] } };
    steps[3] = {
      ...steps[3]!,
      store: { table: "forge-orders-db.orders", columns: ["sku", "price"] },
    };
    steps[4] = { ...steps[4]!, confirmedBy: "check" };
    const get: FlowRecord = {
      ...f,
      id: "forge-orders.get-order",
      trigger: { ...f.trigger, ref: "forge-orders.get-orders-orderid", evidence: ev(17) },
      family: ["forge-stock.post-stock-reservations"],
      steps: [
        { kind: "entry", what: "get", refs: [], evidence: ev(17), confirmedBy: "check" },
        {
          kind: "write",
          what: "w",
          refs: [],
          store: { table: "forge-orders-db.orders", columns: [] },
          evidence: ev(40),
        },
      ],
      errors: [],
    };
    const r = await run([{ ...f, steps }, get]);
    expect(r.findings.map((x) => x.message)).toEqual([
      "forge-orders.place-order step 2 (call-out) uses colour, which no earlier step or the trigger names",
      "forge-orders.place-order step 4 (write) names the column price, which orders doesn't have in the catalog",
      "forge-orders.place-order step 5 (respond) says the check confirmed it, but its cited lines don't name id, sku, quantity",
      "forge-orders.get-order stands for forge-stock.post-stock-reservations, which isn't on the same resource (/orders) of the same component",
      `forge-orders.get-order step 2 (write) cites ${C}:40: ${C} has 26 lines`,
      "forge-orders.get-order step 2 (write): the template default@1 asks a write for store.columns",
      "forge-orders.get-order step 2 (write) is a write that names no columns",
      "The endpoint DELETE /orders/{orderId} (forge-orders.delete-orders-orderid) has no flow",
    ]);
  });

  it("finds a call-out's target through a base URL or context path, as the estate pass joins (ADR 0085)", async () => {
    const f = placeOrder();
    const at = f.steps.findIndex((s) => s.to);
    const to = (entry: string): FlowRecord => ({
      ...f,
      steps: f.steps.map((s, i) => (i === at ? { ...s, to: { ...s.to!, entry } } : s)),
    });
    const target = async (entry: string) =>
      (await run([to(entry)])).findings.filter((x) => x.rule === "call-out-target").length;
    expect(await target("POST /internal/stock/reservations")).toBe(0);
    expect(await target("POST /stock")).toBe(1);
    expect(await target("GET /stock/reservations")).toBe(1);
  });

  it("names routes, fields and resources the way code writes them", () => {
    expect(lineNamesRoute('@RequestMapping("/orders")', "/orders")).toBe(true);
    expect(lineNamesRoute('@GetMapping("/orders/:id")', "/api/orders/{orderId}")).toBe(true);
    expect(lineNamesRoute('@GetMapping("/{orderId}")', "/orders/{orderId}")).toBe(false);
    expect(lineNamesRoute('get("/ordersx")', "/orders")).toBe(false);
    expect(lineNamesField("SELECT first_name FROM owners", "Owner.firstName")).toBe(true);
    expect(lineNamesField("return dto;", "firstName")).toBe(false);
    expect(resourceKey("/orders/{orderId}")).toBe("/orders");
    expect(resourceKey("/orders/:id/lines/{n}")).toBe("/orders/{}/lines");
  });
});
