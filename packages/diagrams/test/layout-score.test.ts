import { describe, expect, it } from "vitest";
import { arrange, LAYOUT_LIMITS, overLimits, scoreLayout, type LaidOut } from "../src/index.js";

const box = (id: string, x: number, y: number, extra: Partial<LaidOut["nodes"][number]> = {}) => ({
  id,
  x,
  y,
  width: 100,
  height: 40,
  ...extra,
});

describe("layout score: the spike's measures for a laid-out graph", () => {
  it("counts two edges that cross, none that only meet at a box, and no overlaps", () => {
    // a(0,0) b(300,0) c(0,200) d(300,200); a→d and b→c cross in the middle; a→b and c→d don't.
    const g: LaidOut = {
      nodes: [box("a", 0, 0), box("b", 300, 0), box("c", 0, 200), box("d", 300, 200)],
      edges: [
        {
          id: "ad",
          points: [
            { x: 100, y: 20 },
            { x: 300, y: 220 },
          ],
        },
        {
          id: "bc",
          points: [
            { x: 300, y: 20 },
            { x: 100, y: 220 },
          ],
        },
        {
          id: "ab",
          points: [
            { x: 100, y: 20 },
            { x: 300, y: 20 },
          ],
        },
        {
          id: "cd",
          points: [
            { x: 100, y: 220 },
            { x: 300, y: 220 },
          ],
        },
      ],
    };
    const s = scoreLayout(g);
    expect(s.crossings).toBe(1);
    expect(s.crossingsPerEdge).toBe(0.25);
    expect(s.overlaps).toBe(0);
    expect(s.nodes).toBe(4);
    expect(s.edges).toBe(4);
    expect(s.width).toBe(400);
    expect(s.height).toBe(240);
    expect(s.screens).toBeCloseTo((400 * 240) / (1600 * 900));
    expect(s.averageEdgeLength).toBeCloseTo((2 * Math.hypot(200, 200) + 400) / 4);
  });

  it("counts crossings between bends of orthogonal routes", () => {
    const g: LaidOut = {
      nodes: [box("a", 0, 0), box("b", 0, 300)],
      edges: [
        {
          id: "h",
          points: [
            { x: 0, y: 150 },
            { x: 200, y: 150 },
          ],
        },
        {
          id: "z",
          points: [
            { x: 50, y: 0 },
            { x: 50, y: 100 },
            { x: 150, y: 100 },
            { x: 150, y: 250 },
          ],
        },
      ],
    };
    expect(scoreLayout(g).crossings).toBe(1);
  });

  it("counts boxes on top of each other, but not a box inside its own group", () => {
    const g: LaidOut = {
      nodes: [
        box("group", 0, 0, { width: 400, height: 300 }),
        box("in", 20, 40, { parent: "group" }),
        box("on", 60, 50, { parent: "group" }),
        box("side", 500, 0),
      ],
      edges: [],
    };
    const s = scoreLayout(g);
    expect(s.overlaps).toBe(1);
    expect(s.leaves).toBe(3);
  });

  it("says which limits a view is over", () => {
    expect(LAYOUT_LIMITS).toMatchObject({ crossingsPerEdge: 0.5, overlaps: 0, detailedNodes: 60 });
    const ok = scoreLayout({ nodes: [box("a", 0, 0)], edges: [] });
    expect(overLimits(ok)).toEqual([]);
    const dense = { ...ok, crossingsPerEdge: 1.2, overlaps: 2, nodes: 61 };
    expect(overLimits(dense)).toEqual(["crossings", "overlaps", "nodes"]);
    expect(overLimits({ ...ok, leaves: 301, nodes: 301 }, "overview")).toEqual(["leaves"]);
  });
});

describe("arrange: a saved arrangement over a fresh layout", () => {
  it("keeps every pinned box where the person put it and moves new boxes off them", () => {
    const layout = [box("old", 0, 0), box("new", 200, 0), box("other", 400, 0)];
    const pinned = { old: { x: 200, y: 0 } };
    const out = arrange(layout, pinned);
    expect(out.old).toEqual({ x: 200, y: 0 });
    expect(out.other).toEqual({ x: 400, y: 0 });
    // "new" was laid out where "old" is pinned: it moves, and lands on nothing.
    expect(out.new).not.toEqual({ x: 200, y: 0 });
    const placed = layout.map((b) => ({ ...b, ...out[b.id]! }));
    expect(scoreLayout({ nodes: placed, edges: [] }).overlaps).toBe(0);
  });

  it("ignores a pinned position for a box the view no longer has", () => {
    const out = arrange([box("a", 0, 0)], { gone: { x: 5, y: 5 } });
    expect(Object.keys(out)).toEqual(["a"]);
  });
});
