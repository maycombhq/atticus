import { readFileSync } from "node:fs";
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { parseRecord, type CatalogRecord } from "@maycombhq/core";
import {
  briefEndpointNotes,
  briefEndpoints,
  briefEndpointsSource,
  estateLine,
  estateOf,
  flowLine,
  flowSummary,
  loadEstate,
  type Estate,
} from "../src/index.js";

/**
 * W5: the drafter mixed up which flow serves an endpoint. Twice a brief named one endpoint and
 * the design changed another flow, because the estate showed each flow's trigger in words ("A
 * client posts a new order"), never the method and path it is. Now each flow's line names its
 * trigger entry, an endpoint's line names the flow it starts, the endpoints the brief names come
 * with the flow each starts, and a design that leaves that flow alone gets a note. Forge estate.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "../../../fixtures");

async function estate(): Promise<Estate> {
  const root = await mkdtemp(join(tmpdir(), "atticus-triggers-"));
  await cp(join(FIXTURES, "stages/specs"), join(root, "specs"), { recursive: true });
  const records = (parse(readFileSync(join(FIXTURES, "specs/catalog.yaml"), "utf8")) as unknown[])
    .map((r) => parseRecord(r))
    .flatMap((p) => (p.ok ? [p.record] : [])) as CatalogRecord[];
  const e = await loadEstate(root, records);
  // A second flow of the same component, started by GET /orders/{orderId}.
  const place = e.flowById.get("forge-orders.place-order")!;
  const view = {
    repo: place.repo,
    flow: {
      ...place.flow,
      id: "forge-orders.view-order",
      name: "View an order",
      trigger: {
        ...place.flow.trigger,
        ref: "forge-orders.get-orders-orderid",
        what: "A client opens an order",
      },
    },
  };
  return estateOf(e.records, [...e.flows, view] as Estate["flows"]);
}

const BRIEF = [
  "# Show who placed an order",
  "",
  "In scope: GET /orders/{id} returns who placed the order.",
  "Out of scope: changing POST /orders/ or DELETE /orders/{orderId}/lines.",
].join("\n");

describe("each flow's trigger entry, in the estate the drafter reads (W5)", () => {
  it("names a flow's trigger as its method and path, with the endpoint's id", async () => {
    const e = await estate();
    const line = flowLine(e.flowById.get("forge-orders.view-order")!, e);
    expect(line).toContain(
      `"View an order": trigger GET /orders/{orderId} (endpoint forge-orders.get-orders-orderid): A client opens an order.`,
    );
    expect(flowSummary(e.flowById.get("forge-orders.place-order")!, e)).toBe(
      `flow forge-orders.place-order (repo forge-orders, component forge-orders) "${e.flowById.get("forge-orders.place-order")!.flow.name}", trigger POST /orders`,
    );
  });

  it("names the flow an endpoint starts on the endpoint's line", async () => {
    const e = await estate();
    expect(estateLine(e, "Endpoint", "forge-orders.get-orders-orderid")).toBe(
      "endpoint forge-orders.get-orders-orderid: forge-orders serves GET /orders/{orderId}; trigger of flow forge-orders.view-order",
    );
  });

  it("maps each endpoint the brief names to the flow it starts, whatever its parameters are called", async () => {
    const e = await estate();
    expect(briefEndpoints(BRIEF, e)).toEqual([
      { endpoint: "GET /orders/{id}", flows: ["forge-orders.view-order"] },
      { endpoint: "POST /orders/", flows: ["forge-orders.place-order"] },
    ]);
    const [s] = briefEndpointsSource(BRIEF, e);
    expect(s!.id).toBe("brief-endpoints");
    expect(s!.text).toContain(
      "- GET /orders/{id}: the trigger entry of flow forge-orders.view-order",
    );
  });

  it("gives the drafter a note when the design leaves alone the flow a brief's endpoint starts", async () => {
    const e = await estate();
    const notes = briefEndpointNotes(BRIEF, e, [{ flow: "forge-orders.place-order" }]);
    expect(notes).toEqual([
      {
        rule: "delta.brief-endpoint-flow",
        target: "GET /orders/{id}",
        blocking: false,
        kind: "drafting",
        message:
          "The brief names GET /orders/{id}, the trigger entry of flow forge-orders.view-order, but the design doesn't change that flow. If the change is to what GET /orders/{id} does, change forge-orders.view-order; otherwise leave it as it is.",
      },
    ]);
    expect(
      briefEndpointNotes(BRIEF, e, [
        { flow: "forge-orders.place-order" },
        { flow: "forge-orders.view-order" },
      ]),
    ).toEqual([]);
  });
});
