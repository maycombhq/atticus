import ELK from "elkjs/lib/elk.bundled.js";
import { describe, expect, it } from "vitest";
import { edgeContainer, fromElk, ROOT, toElk } from "../src/app/layout/elk-graph.js";
import { absolute, elkEngine, layoutGraph, type LayoutInput } from "../src/app/layout/index.js";
import { applyPinned } from "../src/app/layout/pinned.js";

/** The Forge ledger system opened in place: two repos inside it, a portal outside. */
const input: LayoutInput = {
  groups: [{ id: "system:ledger" }],
  nodes: [
    { id: "repo:forge-ledger-api", width: 160, height: 56, parent: "system:ledger" },
    { id: "repo:forge-ledger-db", width: 160, height: 56, parent: "system:ledger" },
    { id: "system:portal", width: 160, height: 56 },
    { id: "system:ledger", width: 160, height: 56 },
  ],
  edges: [
    { id: "e2", from: "repo:forge-ledger-api", to: "repo:forge-ledger-db" },
    {
      id: "e1",
      from: "system:portal",
      to: "repo:forge-ledger-api",
      label: { width: 60, height: 16 },
    },
    { id: "e3", from: "system:portal", to: "system:portal" },
    { id: "e4", from: "system:portal", to: "system:gone" },
  ],
};

describe("our graph as ELK's", () => {
  it("nests boxes in their groups, sorted, with the spike's options", () => {
    const { graph, dropped } = toElk(input, "RIGHT");
    expect(graph.id).toBe(ROOT);
    expect(graph.layoutOptions).toMatchObject({
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
    });
    expect(graph.children!.map((c) => c.id)).toEqual(["system:ledger", "system:portal"]);
    const ledger = graph.children![0]!;
    // A group gets its size from what is inside: no width or height of its own.
    expect(ledger.width).toBeUndefined();
    expect(ledger.layoutOptions!["elk.padding"]).toContain("top=36");
    expect(ledger.children!.map((c) => c.id)).toEqual([
      "repo:forge-ledger-api",
      "repo:forge-ledger-db",
    ]);
    expect(toElk(input, "DOWN").graph.layoutOptions!["elk.direction"]).toBe("DOWN");
    // Self-loops and edges to boxes that aren't drawn are left out, and said so.
    expect(dropped).toEqual(["e3", "e4"]);
  });

  it("puts each edge in the deepest group around both ends, labels sized", () => {
    const { graph } = toElk(input, "RIGHT");
    expect(graph.edges!.map((e) => e.id)).toEqual(["e1"]);
    expect(graph.edges![0]!.labels).toEqual([{ text: "e1", width: 60, height: 16 }]);
    expect(graph.children![0]!.edges!.map((e) => e.id)).toEqual(["e2"]);
    const chain = new Map([
      ["a", ["g1", "g0"]],
      ["b", ["g2", "g1", "g0"]],
      ["g1", ["g0"]],
    ]);
    expect(edgeContainer(chain, "a", "b")).toBe("g1");
    // An edge from a group to a box inside it lives in the group's own container.
    expect(edgeContainer(chain, "g1", "b")).toBe("g0");
    expect(edgeContainer(chain, "a", "x")).toBe(ROOT);
  });

  it("reads ELK's answer back: boxes relative to their group, routes in canvas coordinates", () => {
    const r = fromElk(
      {
        id: ROOT,
        children: [
          {
            id: "system:ledger",
            x: 100,
            y: 50,
            width: 400,
            height: 200,
            children: [{ id: "repo:forge-ledger-api", x: 16, y: 36, width: 160, height: 56 }],
            edges: [
              {
                id: "e2",
                sources: ["repo:forge-ledger-api"],
                targets: ["repo:forge-ledger-db"],
                sections: [
                  {
                    id: "s",
                    startPoint: { x: 176, y: 64 },
                    bendPoints: [{ x: 200, y: 64 }],
                    endPoint: { x: 220, y: 64 },
                  },
                ],
                labels: [{ text: "e2", x: 180, y: 50, width: 10, height: 10 }],
              },
            ],
          },
        ],
      },
      input,
    );
    expect(r.boxes["system:ledger"]).toMatchObject({ x: 100, y: 50, group: true });
    expect(r.boxes["repo:forge-ledger-api"]).toMatchObject({
      x: 16,
      y: 36,
      parent: "system:ledger",
      group: false,
    });
    expect(absolute(r.boxes, "repo:forge-ledger-api")).toEqual({ x: 116, y: 86 });
    expect(r.routes.e2!.points).toEqual([
      { x: 276, y: 114 },
      { x: 300, y: 114 },
      { x: 320, y: 114 },
    ]);
    expect(r.routes.e2!.label).toEqual({ x: 280, y: 100 });
    expect(r.routes.e2).toMatchObject({
      from: "repo:forge-ledger-api",
      to: "repo:forge-ledger-db",
    });
  });
});

describe("kept boxes", () => {
  const base = {
    boxes: {
      a: { id: "a", x: 0, y: 0, width: 100, height: 50, group: false },
      b: { id: "b", x: 200, y: 0, width: 100, height: 50, group: false },
      g: { id: "g", x: 0, y: 100, width: 150, height: 120, group: true },
      c: { id: "c", x: 16, y: 36, width: 100, height: 50, parent: "g", group: false },
    },
    routes: {
      ab: {
        id: "ab",
        from: "a",
        to: "b",
        points: [
          { x: 100, y: 25 },
          { x: 200, y: 25 },
        ],
      },
      bc: {
        id: "bc",
        from: "b",
        to: "c",
        points: [
          { x: 200, y: 25 },
          { x: 116, y: 136 },
        ],
      },
    },
    dropped: [],
  };

  it("stay where they were kept; a box the layout put on one moves clear", () => {
    const r = applyPinned(base, { b: { x: 0, y: 0 } });
    expect(r.boxes.b).toMatchObject({ x: 0, y: 0 });
    // a was laid at (0, 0) too: it moves down below b, clear of it.
    expect(r.boxes.a!.y).toBeGreaterThanOrEqual(50);
    // Routes whose ends moved are dropped; the canvas draws those itself.
    expect(Object.keys(r.routes)).toEqual([]);
  });

  it("are relative to their group, and a group grows to hold a box kept far inside it", () => {
    const r = applyPinned(base, { c: { x: 300, y: 10 } });
    expect(r.boxes.c).toMatchObject({ x: 300, y: 10, parent: "g" });
    expect(r.boxes.g!.width).toBe(300 + 100 + 16);
    expect(absolute(r.boxes, "c")).toEqual({ x: 300, y: 110 });
    // a and b didn't move, so their route stands.
    expect(Object.keys(r.routes)).toEqual(["ab"]);
  });

  it("for boxes the view no longer has are ignored", () => {
    expect(applyPinned(base, { gone: { x: 5, y: 5 } })).toBe(base);
  });
});

describe("the ELK engine, run in-process", () => {
  const engine = elkEngine(new ELK());

  it("lays out nested groups with no overlaps and edges that touch their boxes", async () => {
    const laid = await layoutGraph(
      input.nodes,
      input.edges,
      input.groups,
      { direction: "RIGHT" },
      engine,
    );
    expect(laid.score.overlaps).toBe(0);
    expect(laid.over).toEqual([]);
    expect(laid.dropped).toEqual(["e3", "e4"]);
    const g = laid.boxes["system:ledger"]!;
    for (const id of ["repo:forge-ledger-api", "repo:forge-ledger-db"]) {
      const b = laid.boxes[id]!;
      expect(b.parent).toBe("system:ledger");
      expect(b.x + b.width).toBeLessThanOrEqual(g.width);
      expect(b.y + b.height).toBeLessThanOrEqual(g.height);
    }
    // The inner edge's ends sit on its boxes' borders, in canvas coordinates.
    const route = laid.routes.e2!;
    const near = (id: string, p: { x: number; y: number }) => {
      const a = absolute(laid.boxes, id);
      const b = laid.boxes[id]!;
      return (
        p.x >= a.x - 1 && p.x <= a.x + b.width + 1 && p.y >= a.y - 1 && p.y <= a.y + b.height + 1
      );
    };
    expect(near("repo:forge-ledger-api", route.points[0]!)).toBe(true);
    expect(near("repo:forge-ledger-db", route.points.at(-1)!)).toBe(true);
    // Flows run left to right.
    const api = absolute(laid.boxes, "repo:forge-ledger-api");
    const db = absolute(laid.boxes, "repo:forge-ledger-db");
    expect(db.x).toBeGreaterThan(api.x);
  });

  it("gives the same picture for the same view, and keeps a pinned box in place", async () => {
    const a = await layoutGraph(
      input.nodes,
      input.edges,
      input.groups,
      { direction: "DOWN" },
      engine,
    );
    const b = await layoutGraph(
      [...input.nodes].reverse(),
      [...input.edges].reverse(),
      input.groups,
      { direction: "DOWN" },
      engine,
    );
    expect(b.boxes).toEqual(a.boxes);
    const kept = await layoutGraph(
      input.nodes,
      input.edges,
      input.groups,
      { direction: "DOWN", pinned: { "system:portal": { x: 900, y: 700 } } },
      engine,
    );
    expect(kept.boxes["system:portal"]).toMatchObject({ x: 900, y: 700 });
    expect(kept.score.overlaps).toBe(0);
  });

  it("scores a view over the spike's limits", async () => {
    const nodes = Array.from({ length: 70 }, (_, i) => ({
      id: `component:c${String(i).padStart(2, "0")}`,
      width: 120,
      height: 40,
    }));
    const laid = await layoutGraph(nodes, [], [], { direction: "RIGHT" }, engine);
    expect(laid.score.nodes).toBe(70);
    expect(laid.over).toContain("nodes");
  });
});
