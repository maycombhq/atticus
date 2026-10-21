/**
 * Layout score (plan 4.6, docs/plan/diagram-spike.md): the measures the spike took of a laid-out
 * graph, so every view can be held to the limits it set. Works on any layout engine's output:
 * boxes with a top-left corner and a size, edges as polylines (orthogonal routes included).
 */

export interface LaidOut {
  nodes: { id: string; x: number; y: number; width: number; height: number; parent?: string }[];
  edges: { id: string; points: { x: number; y: number }[] }[];
}

export interface LayoutScore {
  nodes: number;
  /** Boxes that aren't a group around other boxes. */
  leaves: number;
  edges: number;
  /** Pairs of segments of different edges that cross (meeting at an end doesn't count). */
  crossings: number;
  crossingsPerEdge: number;
  /** Pairs of boxes on top of each other; a box inside its own group isn't one. */
  overlaps: number;
  averageEdgeLength: number;
  width: number;
  height: number;
  /** The drawing's size in 1600×900 screens at 100% zoom. */
  screens: number;
}

/** The limits every view meets on first render (the spike's table). */
export const LAYOUT_LIMITS = {
  crossingsPerEdge: 0.5,
  overlaps: 0,
  /** Nodes drawn at once in a detailed view; beyond it the view groups or switches to focus. */
  detailedNodes: 60,
  /** Leaf nodes laid out in an overview; beyond it repos collapse to one box each. */
  overviewLeaves: 300,
  /** Layout time for 500 nodes, off the main thread. */
  layoutMs500: 1500,
} as const;

const SCREEN = { width: 1600, height: 900 };

type P = { x: number; y: number };
const cross = (o: P, a: P, b: P) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
const same = (a: P, b: P) => Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;

/** True when segments p1p2 and q1q2 cross at a point inside both (not at a shared end). */
function segmentsCross(p1: P, p2: P, q1: P, q2: P): boolean {
  if (same(p1, q1) || same(p1, q2) || same(p2, q1) || same(p2, q2)) return false;
  const d1 = cross(q1, q2, p1);
  const d2 = cross(q1, q2, p2);
  const d3 = cross(p1, p2, q1);
  const d4 = cross(p1, p2, q2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

export function scoreLayout(g: LaidOut): LayoutScore {
  const segs = g.edges.map((e) => {
    const s: [P, P][] = [];
    for (let i = 1; i < e.points.length; i++) s.push([e.points[i - 1]!, e.points[i]!]);
    return s;
  });
  let crossings = 0;
  for (let i = 0; i < segs.length; i++)
    for (let j = i + 1; j < segs.length; j++)
      for (const [a, b] of segs[i]!)
        for (const [c, d] of segs[j]!) if (segmentsCross(a, b, c, d)) crossings++;

  const parentOf = new Map(g.nodes.map((n) => [n.id, n.parent]));
  const isAncestor = (a: string, b: string) => {
    for (let p = parentOf.get(b); p; p = parentOf.get(p)) if (p === a) return true;
    return false;
  };
  let overlaps = 0;
  for (let i = 0; i < g.nodes.length; i++)
    for (let j = i + 1; j < g.nodes.length; j++) {
      const a = g.nodes[i]!;
      const b = g.nodes[j]!;
      if (isAncestor(a.id, b.id) || isAncestor(b.id, a.id)) continue;
      const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      if (w > 0 && h > 0) overlaps++;
    }

  const parents = new Set(g.nodes.map((n) => n.parent).filter(Boolean));
  const length = segs.reduce(
    (t, s) => t + s.reduce((u, [a, b]) => u + Math.hypot(b.x - a.x, b.y - a.y), 0),
    0,
  );
  const xs = [
    ...g.nodes.flatMap((n) => [n.x, n.x + n.width]),
    ...g.edges.flatMap((e) => e.points.map((p) => p.x)),
  ];
  const ys = [
    ...g.nodes.flatMap((n) => [n.y, n.y + n.height]),
    ...g.edges.flatMap((e) => e.points.map((p) => p.y)),
  ];
  const width = xs.length ? Math.max(...xs) - Math.min(...xs) : 0;
  const height = ys.length ? Math.max(...ys) - Math.min(...ys) : 0;
  return {
    nodes: g.nodes.length,
    leaves: g.nodes.filter((n) => !parents.has(n.id)).length,
    edges: g.edges.length,
    crossings,
    crossingsPerEdge: g.edges.length ? crossings / g.edges.length : 0,
    overlaps,
    averageEdgeLength: g.edges.length ? length / g.edges.length : 0,
    width,
    height,
    screens: (width * height) / (SCREEN.width * SCREEN.height),
  };
}

/** Which limits a view is over: a detailed view counts nodes, an overview counts leaves. */
export function overLimits(
  s: LayoutScore,
  mode: "detailed" | "overview" = "detailed",
): ("crossings" | "overlaps" | "nodes" | "leaves")[] {
  const out: ("crossings" | "overlaps" | "nodes" | "leaves")[] = [];
  if (s.crossingsPerEdge > LAYOUT_LIMITS.crossingsPerEdge) out.push("crossings");
  if (s.overlaps > LAYOUT_LIMITS.overlaps) out.push("overlaps");
  if (mode === "detailed" && s.nodes > LAYOUT_LIMITS.detailedNodes) out.push("nodes");
  if (mode === "overview" && s.leaves > LAYOUT_LIMITS.overviewLeaves) out.push("leaves");
  return out;
}

/**
 * A kept arrangement over a fresh layout: every pinned box stays where the person put it; a box
 * the layout placed on top of a pinned (or already placed) one moves down until it lands clear.
 * Pinned positions for boxes the view no longer has are dropped.
 */
export function arrange(
  layout: LaidOut["nodes"],
  pinned: Record<string, { x: number; y: number }>,
  gap = 16,
): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {};
  const placed: LaidOut["nodes"] = [];
  const parentOf = new Map(layout.map((n) => [n.id, n.parent]));
  const related = (a: string, b: string) => {
    for (let p = parentOf.get(b); p; p = parentOf.get(p)) if (p === a) return true;
    for (let p = parentOf.get(a); p; p = parentOf.get(p)) if (p === b) return true;
    return false;
  };
  for (const n of layout) {
    const p = pinned[n.id];
    if (!p) continue;
    out[n.id] = { x: p.x, y: p.y };
    placed.push({ ...n, x: p.x, y: p.y });
  }
  const hits = (b: LaidOut["nodes"][number]) =>
    placed.find(
      (o) =>
        !related(o.id, b.id) &&
        Math.min(o.x + o.width, b.x + b.width) - Math.max(o.x, b.x) > 0 &&
        Math.min(o.y + o.height, b.y + b.height) - Math.max(o.y, b.y) > 0,
    );
  for (const n of layout) {
    if (pinned[n.id]) continue;
    const b = { ...n };
    for (let guard = 0, o = hits(b); o && guard < 1000; guard++, o = hits(b))
      b.y = o.y + o.height + gap;
    out[n.id] = { x: b.x, y: b.y };
    placed.push(b);
  }
  return out;
}
