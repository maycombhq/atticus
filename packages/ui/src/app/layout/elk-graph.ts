import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api.js";
import type { Direction, LayoutInput, LayoutResult, PlacedBox, Point, Route } from "./types.js";

/**
 * The pure halves of the ELK engine: our boxes, groups and edges as ELK's JSON graph, and ELK's
 * answer back as positions and routes. No browser and no worker here, so both are unit-tested.
 */

export const ROOT = "__root__";
const GROUP_PAD = 16;
const GROUP_HEADER = 36;

/** The options the spike settled on: layered, orthogonal edges, nested groups laid out as one. */
export function rootOptions(direction: Direction): Record<string, string> {
  return {
    "elk.algorithm": "layered",
    "elk.direction": direction,
    "elk.edgeRouting": "ORTHOGONAL",
    "elk.hierarchyHandling": "INCLUDE_CHILDREN",
    "elk.spacing.nodeNode": "32",
    "elk.layered.spacing.nodeNodeBetweenLayers": "64",
    "elk.spacing.edgeLabel": "4",
    "elk.edgeLabels.placement": "CENTER",
    "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  };
}

/** Each box's chain of groups, nearest first; ids that aren't in the input are cut off. */
function chains(input: LayoutInput): Map<string, string[]> {
  const parentOf = new Map<string, string | undefined>();
  for (const g of input.groups) parentOf.set(g.id, g.parent);
  for (const n of input.nodes) parentOf.set(n.id, n.parent);
  const groups = new Set(input.groups.map((g) => g.id));
  const out = new Map<string, string[]>();
  for (const id of parentOf.keys()) {
    const chain: string[] = [];
    const seen = new Set([id]);
    for (let p = parentOf.get(id); p && groups.has(p) && !seen.has(p); p = parentOf.get(p)) {
      chain.push(p);
      seen.add(p);
    }
    out.set(id, chain);
  }
  return out;
}

/**
 * Where an edge lives in ELK's tree: the deepest group around both ends (not either end itself),
 * or the root. ELK reads an edge's coordinates relative to that container.
 */
export function edgeContainer(chain: Map<string, string[]>, from: string, to: string): string {
  const a = chain.get(from) ?? [];
  const b = new Set(chain.get(to) ?? []);
  return a.find((g) => b.has(g)) ?? ROOT;
}

const byId = <T extends { id: string }>(xs: T[]) =>
  [...xs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/** Our input as ELK's graph. Sorted by id, so the same view always gives the same picture. */
export function toElk(
  input: LayoutInput,
  direction: Direction,
): { graph: ElkNode; dropped: string[] } {
  const chain = chains(input);
  const elk = new Map<string, ElkNode>();
  elk.set(ROOT, { id: ROOT, layoutOptions: rootOptions(direction), children: [], edges: [] });
  for (const g of byId(input.groups))
    elk.set(g.id, {
      id: g.id,
      layoutOptions: {
        "elk.padding": `[top=${g.header ?? GROUP_HEADER},left=${GROUP_PAD},bottom=${GROUP_PAD},right=${GROUP_PAD}]`,
      },
      children: [],
      edges: [],
    });
  for (const n of byId(input.nodes))
    if (!elk.has(n.id)) elk.set(n.id, { id: n.id, width: n.width, height: n.height });
  const containerOf = (id: string) => chain.get(id)?.[0] ?? ROOT;
  for (const g of byId(input.groups)) elk.get(containerOf(g.id))!.children!.push(elk.get(g.id)!);
  for (const n of byId(input.nodes)) {
    const node = elk.get(n.id)!;
    if (input.groups.some((g) => g.id === n.id)) continue;
    elk.get(containerOf(n.id))!.children!.push(node);
  }
  const dropped: string[] = [];
  for (const e of byId(input.edges)) {
    if (e.from === e.to || !chain.has(e.from) || !chain.has(e.to)) {
      dropped.push(e.id);
      continue;
    }
    const edge: ElkExtendedEdge = { id: e.id, sources: [e.from], targets: [e.to] };
    if (e.label) edge.labels = [{ text: e.id, width: e.label.width, height: e.label.height }];
    elk.get(edgeContainer(chain, e.from, e.to))!.edges!.push(edge);
  }
  return { graph: elk.get(ROOT)!, dropped };
}

/** ELK's laid-out graph back as boxes (relative to their group) and routes (canvas coordinates). */
export function fromElk(laid: ElkNode, input: LayoutInput, dropped: string[] = []): LayoutResult {
  const groups = new Set(input.groups.map((g) => g.id));
  const boxes: Record<string, PlacedBox> = {};
  const routes: Record<string, Route> = {};
  const walk = (n: ElkNode, offset: Point, parent?: string) => {
    for (const c of n.children ?? []) {
      const box: PlacedBox = {
        id: c.id,
        x: c.x ?? 0,
        y: c.y ?? 0,
        width: c.width ?? 0,
        height: c.height ?? 0,
        group: groups.has(c.id),
      };
      if (parent) box.parent = parent;
      boxes[c.id] = box;
      walk(c, { x: offset.x + box.x, y: offset.y + box.y }, c.id);
    }
    for (const e of n.edges ?? []) {
      const s = e.sections?.[0];
      if (!s) continue;
      const shift = (p: Point) => ({ x: p.x + offset.x, y: p.y + offset.y });
      const route: Route = {
        id: e.id,
        from: e.sources[0]!,
        to: e.targets[0]!,
        points: [s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map(shift),
      };
      const l = e.labels?.[0];
      if (l && l.x !== undefined && l.y !== undefined) route.label = shift({ x: l.x, y: l.y });
      routes[e.id] = route;
    }
  };
  walk(laid, { x: 0, y: 0 });
  return { boxes, routes, dropped };
}

/** A box's top-left corner in canvas coordinates. */
export function absolute(boxes: Record<string, PlacedBox>, id: string): Point {
  let x = 0;
  let y = 0;
  const seen = new Set<string>();
  for (let b = boxes[id]; b && !seen.has(b.id); b = b.parent ? boxes[b.parent] : undefined) {
    seen.add(b.id);
    x += b.x;
    y += b.y;
  }
  return { x, y };
}
