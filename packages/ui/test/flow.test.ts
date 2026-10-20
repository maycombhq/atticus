import { describe, expect, it } from "vitest";
import { flowLayout, type FlowViewData } from "../src/app/flow.js";

/** A data view like a monolith's: two components reading and writing a store's tables. */
const data: FlowViewData = {
  type: "data",
  title: "Data view",
  groups: [{ id: "ledger-db", label: "ledger-db (postgres)", kind: "datastore" }],
  nodes: [
    ...Array.from({ length: 30 }, (_, i) => ({
      id: `ledger-db.t${String(i).padStart(2, "0")}`,
      label: `table_with_a_long_name_${i}`,
      kind: "table" as const,
      group: "ledger-db",
    })),
    { id: "ledger-api", label: "ledger-api", kind: "component" },
    { id: "ledger-batch", label: "ledger-batch", kind: "component" },
  ],
  edges: Array.from({ length: 30 }, (_, i) => ({
    id: `access.ledger-api.t${i}`,
    from: i % 3 === 0 ? "ledger-batch" : "ledger-api",
    to: `ledger-db.t${String(i).padStart(2, "0")}`,
    label: i % 2 ? "reads" : "writes",
    async: false,
  })),
};

const overlap = (
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("flowLayout", () => {
  it("places every node in a box no other box overlaps, so no label is drawn over another", () => {
    const l = flowLayout(data);
    const boxes = [...l.nodes.values()];
    expect(boxes).toHaveLength(32);
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i]!, boxes[j]!)).toBe(false);
    // A box is wide enough for its label.
    for (const n of data.nodes)
      expect(l.nodes.get(n.id)!.w).toBeGreaterThanOrEqual(n.label.length * 6);
  });

  it("draws a group around its nodes, and readers to the left of what they read", () => {
    const l = flowLayout(data);
    const g = l.groups.get("ledger-db")!;
    for (const n of data.nodes.filter((x) => x.group)) {
      const b = l.nodes.get(n.id)!;
      expect(b.x >= g.x && b.y >= g.y && b.x + b.w <= g.x + g.w && b.y + b.h <= g.y + g.h).toBe(
        true,
      );
    }
    expect(l.nodes.get("ledger-api")!.x + l.nodes.get("ledger-api")!.w).toBeLessThan(g.x);
  });

  it("gives every edge a path between its two boxes, and is the same for the same view", () => {
    const l = flowLayout(data);
    expect(l.edges).toHaveLength(30);
    for (const e of l.edges) expect(e.d).toMatch(/^M[\d.]+ [\d.]+ C/);
    expect(flowLayout(data)).toEqual(l);
    // The canvas is as big as what it holds.
    for (const b of [...l.nodes.values(), ...l.groups.values()]) {
      expect(b.x + b.w).toBeLessThanOrEqual(l.width);
      expect(b.y + b.h).toBeLessThanOrEqual(l.height);
    }
  });

  it("lays a chain of calls out left to right, and survives a cycle", () => {
    const l = flowLayout({
      type: "context",
      title: "Context view",
      groups: [],
      nodes: ["a", "b", "c"].map((id) => ({ id, label: id, kind: "system" as const })),
      edges: [
        { id: "1", from: "a", to: "b", label: "", async: false },
        { id: "2", from: "b", to: "c", label: "", async: false },
        { id: "3", from: "c", to: "a", label: "", async: true },
      ],
    });
    const x = (id: string) => l.nodes.get(id)!.x;
    expect(x("a")).toBeLessThan(x("b"));
    expect(x("b")).toBeLessThan(x("c"));
    expect(l.edges.find((e) => e.id === "3")!.async).toBe(true);
  });
});

describe("graphView", () => {
  it("draws a system with components as a group, a vendor as a node, and keeps every link", async () => {
    const { graphView } = await import("../src/app/graph.js");
    const v = graphView({
      nodes: [
        { id: "ledger", kind: "System", label: "Ledger", status: "current" },
        { id: "northwind-pay", kind: "System", label: "Northwind Pay", status: "current" },
        {
          id: "ledger-api",
          kind: "Component",
          label: "ledger-api",
          status: "current",
          system: "ledger",
        },
        {
          id: "ledger-core",
          kind: "Component",
          label: "ledger-core",
          status: "current",
          system: "ledger",
        },
      ],
      edges: [
        {
          id: "u",
          from: "ledger-api",
          to: "ledger-core",
          via: "uses",
          confidence: "verified",
          status: "current",
        },
        {
          id: "c",
          from: "ledger-api",
          to: "northwind-pay",
          via: "direct",
          confidence: "verified",
          status: "current",
        },
        {
          id: "e",
          from: "ledger-core",
          to: "northwind-pay",
          via: "event-bus",
          confidence: "inferred",
          status: "current",
        },
      ],
    });
    expect(v.groups.map((g) => g.id)).toEqual(["ledger"]);
    expect(v.nodes.map((n) => `${n.id}:${n.kind}:${n.group ?? "-"}`)).toEqual([
      "northwind-pay:system:-",
      "ledger-api:component:ledger",
      "ledger-core:component:ledger",
    ]);
    expect(v.edges.map((e) => `${e.from}>${e.to}:${e.label}:${e.async}`)).toEqual([
      "ledger-api>ledger-core:uses:false",
      "ledger-api>northwind-pay:direct:false",
      "ledger-core>northwind-pay:event-bus:true",
    ]);
    expect(flowLayout(v).edges).toHaveLength(3);
  });
});

describe("graphView with many calls between two boxes", () => {
  it("draws them as one edge with their count", async () => {
    const { graphView } = await import("../src/app/graph.js");
    const call = (id: string) => ({
      id,
      from: "web",
      to: "api",
      via: "direct",
      confidence: "verified",
      status: "current",
    });
    const v = graphView({
      nodes: [
        { id: "web", kind: "Component", label: "web", status: "current" },
        { id: "api", kind: "Component", label: "api", status: "current" },
      ],
      edges: [call("a"), call("b"), call("c")],
    });
    expect(v.edges.map((e) => e.label)).toEqual(["3 × direct"]);
  });
});
