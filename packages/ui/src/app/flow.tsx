import { useMemo, useState } from "react";

/** A catalog view as `atticus diagram render <view> --format json` gives it (diagrams' FlowView). */
export interface FlowViewData {
  type: "context" | "container" | "data" | "event" | "diagram";
  title: string;
  groups: { id: string; label: string; kind: "system" | "datastore" }[];
  nodes: {
    id: string;
    label: string;
    kind: "system" | "component" | "table" | "topic" | "box";
    group?: string;
  }[];
  edges: { id: string; from: string; to: string; label: string; async: boolean }[];
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FlowLayout {
  width: number;
  height: number;
  nodes: Map<string, Box>;
  groups: Map<string, Box>;
  edges: { id: string; from: string; to: string; label: string; async: boolean; d: string }[];
  /** Edges from a box to itself (calls inside one system), counted on the box, not drawn. */
  inside: Map<string, number>;
}

/** Labels for a sentence: the first few, then how many more. */
export function edgeSummary(labels: string[], max = 5): string {
  return labels.length <= max
    ? labels.join(", ")
    : `${labels.slice(0, max).join(", ")} and ${labels.length - max} more`;
}

/** A box's text: its label, and how many of its calls stay inside it. */
export const boxText = (label: string, inside = 0) =>
  inside ? `${label} · ${inside} inside` : label;

const CHAR = 6.6; // JetBrains Mono at 11px
const BOX_H = 22;
const GAP_Y = 10;
const GAP_X = 96;
const PAD = 24;
const GROUP_PAD = 10;
const GROUP_HEAD = 24;
/** Rows before a column (or a group) wraps into another, so a long list stays on screen. */
const MAX_ROWS = 16;

const width = (label: string) => Math.max(64, Math.ceil(label.length * CHAR) + 18);
const n1 = (v: number) => (Math.round(v * 10) / 10).toString();

/**
 * A deterministic layered layout (the same view draws the same picture): what calls or reads
 * sits left of what it reaches, a group (a system, a data store) is one box with its nodes in a
 * grid inside, and long columns wrap. No box overlaps another, so no label is drawn over one.
 */
export function flowLayout(v: FlowViewData): FlowLayout {
  const inside = new Map<string, number>();
  for (const e of v.edges) if (e.from === e.to) inside.set(e.from, (inside.get(e.from) ?? 0) + 1);
  const unitOf = (id: string) => {
    const n = v.nodes.find((x) => x.id === id);
    return n?.group ? `group:${n.group}` : `node:${id}`;
  };
  const units = [
    ...v.nodes.filter((n) => !n.group).map((n) => `node:${n.id}`),
    ...v.groups.filter((g) => v.nodes.some((n) => n.group === g.id)).map((g) => `group:${g.id}`),
  ].sort();
  const preds = new Map<string, Set<string>>(units.map((u) => [u, new Set<string>()]));
  for (const e of v.edges) {
    const a = unitOf(e.from);
    const b = unitOf(e.to);
    if (a !== b && preds.has(a) && preds.has(b)) preds.get(b)!.add(a);
  }
  // Longest-path ranks; a cycle is broken at the unit with the fewest unplaced callers.
  const rank = new Map<string, number>();
  while (rank.size < units.length) {
    const open = units.filter((u) => !rank.has(u));
    let ready = open.filter((u) => [...preds.get(u)!].every((p) => rank.has(p)));
    if (!ready.length) {
      const left = (u: string) => [...preds.get(u)!].filter((p) => !rank.has(p)).length;
      ready = [open.reduce((a, b) => (left(b) < left(a) ? b : a))];
    }
    for (const u of ready)
      rank.set(
        u,
        Math.max(0, ...[...preds.get(u)!].filter((p) => rank.has(p)).map((p) => rank.get(p)! + 1)),
      );
  }

  // Each unit's size: a node is one box; a group is a header over a grid of its nodes.
  const inner = new Map<string, { id: string; col: number; row: number; w: number }[]>();
  const size = new Map<string, { w: number; h: number }>();
  for (const u of units) {
    if (u.startsWith("node:")) {
      const n = v.nodes.find((x) => `node:${x.id}` === u)!;
      size.set(u, { w: width(boxText(n.label, inside.get(n.id))), h: BOX_H });
      continue;
    }
    const g = v.groups.find((x) => `group:${x.id}` === u)!;
    const members = v.nodes.filter((n) => n.group === g.id);
    const cols = Math.ceil(members.length / MAX_ROWS);
    const rows = Math.ceil(members.length / cols);
    const cw = Math.max(...members.map((m) => width(m.label)));
    inner.set(
      u,
      members.map((m, i) => ({ id: m.id, col: Math.floor(i / rows), row: i % rows, w: cw })),
    );
    size.set(u, {
      w: Math.max(width(g.label) + 12, cols * cw + (cols - 1) * GAP_Y + GROUP_PAD * 2),
      h: GROUP_HEAD + rows * BOX_H + (rows - 1) * GAP_Y + GROUP_PAD,
    });
  }

  // Columns by rank; a column with many units wraps into sub-columns.
  const ranks = [...new Set(rank.values())].sort((a, b) => a - b);
  const placed = new Map<string, Box>();
  let x = PAD;
  let tallest = 0;
  const columns: { units: string[]; x: number; h: number }[] = [];
  for (const r of ranks) {
    const inRank = units.filter((u) => rank.get(u) === r);
    for (let i = 0; i < inRank.length; i += MAX_ROWS) {
      const col = inRank.slice(i, i + MAX_ROWS);
      const w = Math.max(...col.map((u) => size.get(u)!.w));
      const h = col.reduce((s, u) => s + size.get(u)!.h, 0) + (col.length - 1) * GAP_Y * 2;
      columns.push({ units: col, x, h });
      tallest = Math.max(tallest, h);
      x += w + GAP_X;
    }
  }
  for (const c of columns) {
    let y = PAD + (tallest - c.h) / 2;
    for (const u of c.units) {
      const s = size.get(u)!;
      placed.set(u, { x: c.x, y, w: s.w, h: s.h });
      y += s.h + GAP_Y * 2;
    }
  }

  const nodes = new Map<string, Box>();
  const groups = new Map<string, Box>();
  for (const u of units) {
    const b = placed.get(u)!;
    if (u.startsWith("node:")) {
      nodes.set(u.slice(5), b);
      continue;
    }
    groups.set(u.slice(6), b);
    for (const m of inner.get(u)!)
      nodes.set(m.id, {
        x: b.x + GROUP_PAD + m.col * (m.w + GAP_Y),
        y: b.y + GROUP_HEAD + m.row * (BOX_H + GAP_Y),
        w: m.w,
        h: BOX_H,
      });
  }

  // Edges: from the right of the caller to the left of what it reaches; a backward or
  // same-column edge bows out to the left.
  const edges = v.edges
    .filter((e) => e.from !== e.to && nodes.has(e.from) && nodes.has(e.to))
    .map((e) => {
      const a = nodes.get(e.from)!;
      const b = nodes.get(e.to)!;
      const ay = a.y + a.h / 2;
      const by = b.y + b.h / 2;
      let d: string;
      if (b.x > a.x + a.w) {
        const sx = a.x + a.w;
        const mx = (sx + b.x) / 2;
        d = `M${n1(sx)} ${n1(ay)} C${n1(mx)} ${n1(ay)} ${n1(mx)} ${n1(by)} ${n1(b.x)} ${n1(by)}`;
      } else {
        const bow = Math.max(0, Math.min(a.x, b.x) - 40);
        d = `M${n1(a.x)} ${n1(ay)} C${n1(bow)} ${n1(ay)} ${n1(bow)} ${n1(by)} ${n1(b.x)} ${n1(by)}`;
      }
      return { id: e.id, from: e.from, to: e.to, label: e.label, async: e.async, d };
    });

  const all = [...nodes.values(), ...groups.values()];
  return {
    width: Math.max(320, ...all.map((b) => b.x + b.w + PAD)),
    height: Math.max(160, ...all.map((b) => b.y + b.h + PAD)),
    nodes,
    groups,
    edges,
    inside,
  };
}

/**
 * A catalog view drawn with its own groups, nodes and edges. Pointing at (or focusing) a node
 * lights its edges and names them; the Mermaid text beside it is the same view as text.
 */
export function FlowCanvas({
  view,
  height = 460,
  selected,
  highlight = [],
  onPick,
}: {
  view: FlowViewData;
  height?: number;
  /** A node lit from the start (a focus), with its edges. */
  selected?: string;
  /** Nodes marked as found (search results, what a change reaches). */
  highlight?: string[];
  /** Called when a box is clicked, with its id. */
  onPick?: (id: string) => void;
}) {
  const l = useMemo(() => flowLayout(view), [view]);
  const [hot, setHot] = useState<string | undefined>(selected);
  const marked = new Set(highlight);
  const lit = (e: { from: string; to: string }) =>
    hot !== undefined && (e.from === hot || e.to === hot);
  const label = (id: string) => view.nodes.find((n) => n.id === id)?.label ?? id;
  const hotEdges = hot ? l.edges.filter(lit) : [];
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div
        style={{
          overflow: "auto",
          maxHeight: height,
          border: "1px solid var(--line-2)",
          borderRadius: 8,
        }}
      >
        <svg
          role="img"
          aria-label={`${view.title}: ${view.nodes.length} nodes in ${view.groups.length} groups, ${view.edges.length} edges.`}
          width={l.width}
          height={l.height}
          viewBox={`0 0 ${l.width} ${l.height}`}
          style={{ display: "block" }}
        >
          <defs>
            <marker
              id="flow-arrow"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto"
            >
              <path d="M0 0 L8 4 L0 8 z" fill="#2EE6F6" />
            </marker>
          </defs>
          {view.groups.map((g) => {
            const b = l.groups.get(g.id);
            if (!b) return null;
            return (
              <g key={`group-${g.id}`}>
                <rect
                  x={b.x}
                  y={b.y}
                  width={b.w}
                  height={b.h}
                  rx={8}
                  fill="rgba(46,230,246,0.04)"
                  stroke="#2EE6F6"
                  strokeOpacity={0.35}
                  strokeDasharray={g.kind === "datastore" ? undefined : "3 4"}
                />
                <text
                  x={b.x + GROUP_PAD}
                  y={b.y + 16}
                  fontFamily="Rajdhani, sans-serif"
                  fontWeight={700}
                  fontSize={12}
                  letterSpacing="0.08em"
                  fill="#5FD8E6"
                >
                  {g.label}
                </text>
              </g>
            );
          })}
          <g fill="none">
            {l.edges.map((e) => (
              <path
                key={e.id}
                d={e.d}
                stroke={lit(e) ? "#7FF4FF" : "#2EE6F6"}
                strokeOpacity={hot === undefined ? 0.45 : lit(e) ? 1 : 0.12}
                strokeWidth={lit(e) ? 1.6 : 1}
                strokeDasharray={e.async ? "5 4" : undefined}
                markerEnd="url(#flow-arrow)"
              >
                <title>{`${label(e.from)} → ${label(e.to)}${e.label ? `: ${e.label}` : ""}`}</title>
              </path>
            ))}
          </g>
          {view.nodes.map((n) => {
            const b = l.nodes.get(n.id);
            if (!b) return null;
            const on = hot === n.id;
            return (
              <g
                key={n.id}
                tabIndex={0}
                role="button"
                aria-label={`${n.label} (${n.kind})`}
                aria-pressed={on}
                style={{ cursor: "pointer", outline: "none" }}
                onMouseEnter={() => setHot(n.id)}
                onFocus={() => setHot(n.id)}
                onClick={() => {
                  setHot(on ? undefined : n.id);
                  onPick?.(n.id);
                }}
              >
                <rect
                  x={b.x}
                  y={b.y}
                  width={b.w}
                  height={b.h}
                  rx={n.kind === "table" ? 3 : 6}
                  fill={
                    on
                      ? "rgba(46,230,246,0.22)"
                      : marked.has(n.id)
                        ? "rgba(46,230,246,0.12)"
                        : "#0B1016"
                  }
                  stroke={
                    on || marked.has(n.id) ? "#7FF4FF" : n.kind === "table" ? "#3B8F99" : "#2EE6F6"
                  }
                  strokeWidth={on ? 1.6 : 1}
                />
                <text
                  x={b.x + 9}
                  y={b.y + 15}
                  fontFamily="JetBrains Mono, monospace"
                  fontSize={11}
                  fill={on ? "#E9F6FA" : "#BFEFF7"}
                >
                  {boxText(n.label, l.inside.get(n.id))}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <p className="muted" style={{ fontSize: 12, margin: 0 }} aria-live="polite">
        {hot
          ? `${label(hot)}: ${hotEdges.length} edge${hotEdges.length === 1 ? "" : "s"}${
              hotEdges.length
                ? ` (${edgeSummary([...new Set(hotEdges.map((e) => e.label).filter(Boolean))])})`
                : ""
            }${l.inside.get(hot) ? `, ${l.inside.get(hot)} calls inside it` : ""}. Point at another box, or click it again to clear.`
          : view.type === "context" && view.nodes.length === 1
            ? "Everything here is one system: open Container to see its components and how they connect."
            : `${l.edges.length} edges. Point at a box to light its edges; dashed lines are asynchronous.`}
      </p>
    </div>
  );
}
