import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { uiSpecRoutes } from "../src/ui-api-specs.js";

const STAGES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/stages");

let srv: RunningServer;

beforeAll(async () => {
  // fixtures/stages: the specs and the add-fraud-check change, with target flows written as
  // atticus change architecture writes them (ADR 0087).
  const root = await mkdtemp(join(tmpdir(), "atticus-ui-target-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  await cp(join(STAGES, "specs"), join(root, "specs"), { recursive: true });
  await cp(join(STAGES, "changes"), join(root, "openspec/changes"), { recursive: true });
  const target = join(root, "openspec/changes/add-fraud-check/target-flows");
  await mkdir(target, { recursive: true });
  await writeFile(
    join(target, "forge-orders.place-order.yaml"),
    [
      "schemaVersion: 1",
      "flow: forge-orders.place-order",
      "repo: forge-orders",
      "change: modify",
      "why: The order is screened before stock is reserved.",
      "steps:",
      "  - { op: add, after: 1, kind: call-out, what: Northwind Pay screens the order, to: { component: northwind-pay, entry: POST /v1/screenings, new: true } }",
      "  - { op: add, after: 1, kind: branch, what: A rejected order is refused with 422 }",
      "  - { op: change, step: 4, what: The order is inserted with the screen's verdict }",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(target, "forge-orders.screen-order.yaml"),
    [
      "schemaVersion: 1",
      "flow: forge-orders.screen-order",
      "repo: forge-orders",
      "change: new",
      "name: An order is screened again",
      "trigger: { kind: job, what: Every hour }",
      "why: Orders held for review are screened again.",
      "steps:",
      "  - { op: add, after: 0, kind: read, what: The held orders are read }",
      "  - { op: add, after: 1, kind: loop, what: Each held order is screened, repeats: { from: 3, to: 3 } }",
      "  - { op: add, after: 2, kind: call-out, what: The order is screened, to: { component: northwind-pay, entry: POST /v1/screenings } }",
      "",
    ].join("\n"),
  );
  await writeFile(join(target, "broken.yaml"), "flow: [\n");
  srv = await startServer({ root, port: 0, extend: (r, ctx) => uiSpecRoutes(r, ctx) });
});

afterAll(async () => {
  await srv?.close();
});

const get = async (path: string) => {
  const r = await fetch(srv.url + path, { headers: { "X-Atticus-Token": srv.token } });
  return { status: r.status, body: (await r.json()) as unknown };
};

describe("GET /api/changes/{id}/target-flows (ADR 0095)", () => {
  it("lists each flow the change adds, changes or removes, with counts and the files that don't read", async () => {
    const r = await get("/api/changes/add-fraud-check/target-flows");
    expect(r.status).toBe(200);
    const v = Api.TargetFlowList.parse(r.body);
    expect(v.flows.map((f) => [f.flow, f.change, f.name, f.added, f.changed, f.removed])).toEqual([
      ["forge-orders.place-order", "modify", "A client places an order", 2, 1, 0],
      ["forge-orders.screen-order", "new", "An order is screened again", 3, 0, 0],
    ]);
    expect(v.problems).toHaveLength(1);
    expect(v.problems[0]).toMatch(/^target-flows\/broken\.yaml: /);
  });

  it("is empty for a change with no target flows yet, and a 404 for one that isn't there", async () => {
    expect(
      Api.TargetFlowList.parse((await get("/api/changes/bulk-orders/target-flows")).body).flows,
    ).toEqual([]);
    expect((await get("/api/changes/no-such-change/target-flows")).status).toBe(404);
  });
});

describe("GET /api/changes/{id}/target-flows/{flow}", () => {
  it("gives today's steps and the change's, marked, numbered in both flows", async () => {
    const r = await get("/api/changes/add-fraud-check/target-flows/forge-orders.place-order");
    expect(r.status).toBe(200);
    const v = Api.TargetFlowView.parse(r.body);
    expect(v.file).toBe(
      "openspec/changes/add-fraud-check/target-flows/forge-orders.place-order.yaml",
    );
    expect(v.steps.map((s) => [s.mark, s.today, s.target, s.kind])).toEqual([
      ["same", 1, 1, "entry"],
      ["added", undefined, 2, "call-out"],
      ["added", undefined, 3, "branch"],
      ["same", 2, 4, "call-out"],
      ["same", 3, 5, "transform"],
      ["changed", 4, 6, "write"],
      ["same", 5, 7, "respond"],
    ]);
    expect(v.steps[5]!.was).toEqual({ kind: "write", what: expect.any(String) as string });
    expect(v.steps[0]!.evidence.length).toBeGreaterThan(0);
    expect(v.triggerEvidence.length).toBeGreaterThan(0);
  });

  it("gives a new flow from its steps, with its loop's repeats", async () => {
    const v = Api.TargetFlowView.parse(
      (await get("/api/changes/add-fraud-check/target-flows/forge-orders.screen-order")).body,
    );
    expect(v.delta).toBe("new");
    expect(v.trigger).toEqual({ kind: "job", what: "Every hour" });
    expect(v.steps[1]!.repeats).toEqual({ from: 3, to: 3 });
  });

  it("is a 404 for a flow the change doesn't touch", async () => {
    expect(
      (await get("/api/changes/add-fraud-check/target-flows/forge-orders.nothing")).status,
    ).toBe(404);
  });
});

describe("GET /api/changes/{id}/map (ADR 0108)", () => {
  it("draws what the target flows touch, marked, with the same picture as Mermaid", async () => {
    const r = await get("/api/changes/add-fraud-check/map");
    expect(r.status).toBe(200);
    const m = Api.ChangeMap.parse(r.body);
    expect(m.source).toBe("openspec/changes/add-fraud-check/target-flows");
    expect(m.flows).toBe(2);
    const at = (id: string) => m.nodes.find((n) => n.id === id);
    // A component the specs know is changed, not new; the vendor the delta says is new is new.
    expect(at("forge-orders")).toMatchObject({ legend: "modify", label: "◇ forge-orders" });
    expect(at("northwind-pay")).toMatchObject({ legend: "new", label: "+ northwind-pay" });
    expect(at("forge-stock")?.legend).toBeUndefined();
    expect(m.edges.find((e) => e.from === "forge-orders" && e.to === "northwind-pay")?.legend).toBe(
      "new",
    );
    expect(m.mermaid).toContain('northwind_pay["+ northwind-pay"]');
    expect(m.problems.some((p) => p.startsWith("target-flows/broken.yaml"))).toBe(true);
  });

  it("is a 404 for a change that isn't there, and a 400 for an id that can't be one", async () => {
    expect((await get("/api/changes/no-such-change/map")).status).toBe(404);
    expect((await get("/api/changes/Not%20An%20Id/map")).status).toBe(400);
  });
});
