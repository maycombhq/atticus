import type { Api } from "@maycombhq/core";
import { WORDS } from "./words.js";

/**
 * The Architecture workspace's state, apart from React: the views loaded so far (one per opened
 * node, from GET /api/graph/node/{id}), the outline built from them, keyboard moves, and the
 * picture of one open node.
 */

/** Node id → its loaded view, for the current lens. */
export type Views = Map<string, Api.GraphNodeViewT>;

export interface OutlineRow {
  node: Api.HierNodeT;
  depth: number;
  expanded: boolean;
}

/** The outline: the root, then each expanded node's loaded children under it, depth first. */
export function outlineRows(views: Views, root: string, expanded: Set<string>): OutlineRow[] {
  const rootNode = views.get(root)?.node;
  if (!rootNode) return [];
  const out: OutlineRow[] = [];
  const walk = (n: Api.HierNodeT, depth: number) => {
    const open = expanded.has(n.id) && views.has(n.id);
    out.push({ node: n, depth, expanded: open });
    if (open) for (const c of views.get(n.id)!.children) walk(c, depth + 1);
  };
  walk(rootNode, 0);
  return out;
}

export type KeyResult =
  { focus: string } | { open: string } | { close: string } | { select: string };

/** What a key does on an outline row. Tab is left to the browser: every row is a stop. */
export function keyStep(rows: OutlineRow[], at: string, key: string): KeyResult | undefined {
  const i = rows.findIndex((r) => r.node.id === at);
  if (i < 0) return undefined;
  const row = rows[i]!;
  switch (key) {
    case "ArrowDown":
      return { focus: rows[Math.min(rows.length - 1, i + 1)]!.node.id };
    case "ArrowUp":
      return { focus: rows[Math.max(0, i - 1)]!.node.id };
    case "Home":
      return { focus: rows[0]!.node.id };
    case "End":
      return { focus: rows[rows.length - 1]!.node.id };
    case "Enter":
    case "ArrowRight":
      return row.node.childCount > 0 ? { open: at } : { select: at };
    case "Escape":
    case "ArrowLeft":
      if (row.expanded) return { close: at };
      return row.node.parent && rows.some((r) => r.node.id === row.node.parent)
        ? { focus: row.node.parent }
        : undefined;
    default:
      return undefined;
  }
}

/** A box on the canvas: a child of the open node, a node outside it, or a part opened in place. */
export interface CanvasBox {
  id: string;
  label: string;
  kind: string;
  gaps: string[];
  childCount: number;
  /** Outside the open node: an edge reaches it. */
  outside: boolean;
  /** Opened in place: drawn as a group around its own children. */
  group: boolean;
  parent?: string;
  /** Links that start and end on this box (calls inside one system). */
  inside: number;
}

export interface CanvasLink {
  id: string;
  from: string;
  to: string;
  type: string;
  count: number;
  label: string;
  async: boolean;
  gaps: string[];
}

export interface CanvasGraph {
  boxes: CanvasBox[];
  links: CanvasLink[];
}

const box = (n: Api.HierNodeT, o: Partial<CanvasBox> = {}): CanvasBox => ({
  id: n.id,
  label: n.label,
  kind: n.kind,
  gaps: n.gaps,
  childCount: n.childCount,
  outside: false,
  group: false,
  inside: 0,
  ...o,
});

export const linkLabel = (count: number, type: string) =>
  count > 1 ? WORDS.edgeCount(count, type) : type;

/**
 * What the canvas draws for one open node: its children, the nodes outside it that edges reach,
 * and, inside each child opened in place, that child's own children (and so on down). Edges come
 * from every loaded view drawn, once each; an edge lifted to an opened part is left out when a
 * sharper edge of the same type reaches the same box from inside that part.
 */
export function canvasGraph(
  views: Views,
  current: string,
  inPlace: ReadonlySet<string>,
  focus?: Api.GraphFocusViewT,
): CanvasGraph {
  const boxes = new Map<string, CanvasBox>();
  const raw = new Map<string, Api.HierEdgeT>();
  if (focus) {
    for (const n of [focus.node, ...focus.neighbours]) boxes.set(n.id, box(n));
    for (const e of focus.edges) raw.set(e.id, e);
  } else {
    const v = views.get(current);
    if (!v) return { boxes: [], links: [] };
    const open = (view: Api.GraphNodeViewT, parent?: string) => {
      for (const e of view.edges) raw.set(e.id, e);
      for (const c of view.children) {
        if (boxes.has(c.id)) continue;
        const inner = inPlace.has(c.id) ? views.get(c.id) : undefined;
        boxes.set(c.id, box(c, { group: !!inner, ...(parent ? { parent } : {}) }));
        if (inner) open(inner, c.id);
      }
    };
    open(v);
    for (const o of v.outside) if (!boxes.has(o.id)) boxes.set(o.id, box(o, { outside: true }));
  }

  const within = (id: string, group: string) => {
    for (let p = boxes.get(id)?.parent; p; p = boxes.get(p)?.parent) if (p === group) return true;
    return false;
  };
  const drawn = [...raw.values()].filter((e) => boxes.has(e.from) && boxes.has(e.to));
  const sharper = (e: Api.HierEdgeT) =>
    drawn.some(
      (o) =>
        o !== e &&
        o.type === e.type &&
        ((boxes.get(e.to)!.group && o.from === e.from && within(o.to, e.to)) ||
          (boxes.get(e.from)!.group && o.to === e.to && within(o.from, e.from))),
    );
  const links: CanvasLink[] = [];
  for (const e of drawn) {
    if (e.from === e.to) {
      boxes.get(e.from)!.inside += e.count;
      continue;
    }
    if (sharper(e)) continue;
    links.push({
      id: e.id,
      from: e.from,
      to: e.to,
      type: e.type,
      count: e.count,
      label: linkLabel(e.count, e.type),
      async: e.sync === "async" || e.type === "publishes" || e.type === "subscribes",
      gaps: e.gaps,
    });
  }
  return { boxes: [...boxes.values()], links };
}

/** Which way the layout runs: context (who sits above whom) down, flows and calls across. */
export function directionFor(lens: string): "RIGHT" | "DOWN" {
  return lens === "architecture" || lens === "infrastructure" ? "DOWN" : "RIGHT";
}

/** A box's size on the canvas, from its label. */
export function boxSize(b: Pick<CanvasBox, "label">): { width: number; height: number } {
  return { width: Math.min(280, Math.max(150, Math.ceil(b.label.length * 7.5) + 56)), height: 64 };
}

/** What to offer when a view is too much to read at once (the spike's limits, ADR 0081). */
export type Legibility =
  | { mode: "focus"; id: string; why: "api" | "nodes" | "crossings" }
  | { mode: "collapse"; why: "api" | "nodes" | "crossings" }
  | { mode: "group"; id?: string; why: "api" | "nodes" | "crossings" };

export function legibility(
  over: readonly string[],
  suggest: Api.GraphNodeViewT["suggest"] | undefined,
  inPlace: ReadonlySet<string>,
  children: readonly Api.HierNodeT[],
): Legibility | undefined {
  const why = over.includes("nodes")
    ? "nodes"
    : over.includes("crossings")
      ? "crossings"
      : undefined;
  if (!why && !suggest) return undefined;
  const w = why ?? "api";
  if (suggest?.mode === "focus" && suggest.id) return { mode: "focus", id: suggest.id, why: w };
  if (inPlace.size) return { mode: "collapse", why: w };
  const biggest = [...children]
    .filter((c) => c.childCount > 0)
    .sort((a, b) => b.childCount - a.childCount || (a.id < b.id ? -1 : 1))[0];
  return biggest ? { mode: "group", id: biggest.id, why: w } : { mode: "group", why: w };
}

/** The layout file name for a view, as the server names it (ADR 0081). */
export function viewKey(lens: string, node: string, mode: "node" | "focus" = "node"): string {
  return [lens, ...(mode === "focus" ? ["focus"] : []), node.replace(/:/g, "-")].join(".");
}
