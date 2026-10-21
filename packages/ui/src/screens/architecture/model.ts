import type { Api } from "@maycombhq/core";
import type { FlowViewData } from "../../app/flow.js";
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

const KIND: Record<string, FlowViewData["nodes"][number]["kind"]> = {
  system: "system",
  repo: "component",
  component: "component",
  table: "table",
  store: "table",
  topic: "topic",
};

/** One open node as the read-only canvas draws it: its children, and what its edges reach. */
export function canvasView(v: Api.GraphNodeViewT, title: string): FlowViewData {
  return {
    type: "diagram",
    title,
    groups: [],
    nodes: [
      ...v.children.map((c) => ({ id: c.id, label: c.label, kind: KIND[c.kind] ?? "box" })),
      ...v.outside.map((o) => ({
        id: o.id,
        label: `${o.label} (${WORDS.outsideMark})`,
        kind: "box" as const,
      })),
    ],
    edges: v.edges.map((e) => ({
      id: e.id,
      from: e.from,
      to: e.to,
      label: e.count > 1 ? `${e.count} × ${e.type}` : e.type,
      async: e.sync === "async" || e.type === "publishes" || e.type === "subscribes",
    })),
  };
}

/** The layout file name for a view, as the server names it (ADR 0081). */
export function viewKey(lens: string, node: string, mode: "node" | "focus" = "node"): string {
  return [lens, ...(mode === "focus" ? ["focus"] : []), node.replace(/:/g, "-")].join(".");
}
