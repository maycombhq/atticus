import { useMemo } from "react";
import { FlowCanvas, type FlowViewData } from "./flow.js";
import { COPY } from "../copy.js";

const T = COPY.graph;

export interface Graph {
  nodes: { id: string; kind: string; label: string; status: string; system?: string }[];
  edges: {
    id: string;
    from: string;
    to: string;
    via: string;
    confidence: string;
    status: string;
  }[];
}

const ASYNC = new Set(["event-bus", "pubsub", "mq"]);
const KIND: Record<string, FlowViewData["nodes"][number]["kind"]> = {
  System: "system",
  Component: "component",
  Table: "table",
  Endpoint: "topic",
};

/**
 * The catalog graph (systems, components and the links between them) as a view the canvas
 * draws: a system with components is a group around them, a system without is a node, and
 * every link is an edge labelled with how it travels. The same catalog draws the same picture.
 */
export function graphView(g: Graph, title = T.map): FlowViewData {
  const members = new Set(g.nodes.map((n) => n.system).filter((s): s is string => !!s));
  const groups = g.nodes
    .filter((n) => n.kind === "System" && members.has(n.id))
    .map((n) => ({ id: n.id, label: n.label || n.id, kind: "system" as const }));
  const grouped = new Set(groups.map((x) => x.id));
  const nodes = g.nodes
    .filter((n) => !grouped.has(n.id))
    .map((n) => ({
      id: n.id,
      label: n.label || n.id,
      kind: KIND[n.kind] ?? ("box" as const),
      ...(n.system && grouped.has(n.system) ? { group: n.system } : {}),
    }));
  // Links between the same two boxes the same way are one edge with their count.
  const merged = new Map<
    string,
    { id: string; from: string; to: string; via: string; n: number }
  >();
  for (const e of g.edges) {
    if (grouped.has(e.from) || grouped.has(e.to)) continue;
    const key = `${e.from}\u0000${e.to}\u0000${e.via}`;
    const m = merged.get(key);
    if (m) m.n++;
    else merged.set(key, { id: e.id, from: e.from, to: e.to, via: e.via, n: 1 });
  }
  const edges = [...merged.values()].map((e) => ({
    id: e.id,
    from: e.from,
    to: e.to,
    label: e.n > 1 ? `${e.n} × ${e.via}` : e.via,
    async: ASYNC.has(e.via),
  }));
  return { type: "context", title, groups, nodes, edges };
}

/** The catalog graph on the canvas, lit at a focus and marking what a search or change found. */
export function GraphView({
  g,
  focus,
  highlight = [],
  onPick,
  height = 430,
}: {
  g: Graph;
  focus?: string;
  highlight?: string[];
  onPick?: (id: string) => void;
  height?: number;
}) {
  const view = useMemo(() => graphView(g), [g]);
  return (
    <FlowCanvas
      key={focus ?? ""}
      view={view}
      height={height}
      {...(focus ? { selected: focus } : {})}
      highlight={highlight}
      {...(onPick ? { onPick } : {})}
    />
  );
}
