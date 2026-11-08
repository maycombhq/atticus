import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { COPY } from "../copy.js";
import {
  DiagramFrame,
  MINIMAP_FROM,
  ViewerToolbar,
  ZOOM,
  centreOn,
  clampZoom,
  fitRect,
  neighbourhood,
  panBy,
  useAvailableHeight,
  useFullScreen,
  wheelFactor,
  zoomAt,
  type Rect,
  type Size,
  type ViewerAction,
  type Viewport,
} from "./viewer.js";

const T = COPY.flowView;

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
    : T.andMore(labels.slice(0, max).join(", "), labels.length - max);
}

/**
 * Ninth UX walk: a lit box's edge labels in brackets, or nothing when its edges have none (the
 * Impact explorer said "2 edges ()").
 */
export function edgeLabels(labels: readonly (string | undefined)[]): string {
  const named = [...new Set(labels.filter((l): l is string => !!l && !!l.trim()))];
  return named.length ? ` (${edgeSummary(named)})` : "";
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

/** The boxes of a laid-out view, with their ids, for fitting, finding and the minimap. */
export function layoutRects(l: FlowLayout): { id: string; r: Rect }[] {
  return [...l.nodes.entries()].map(([id, b]) => ({ id, r: { x: b.x, y: b.y, w: b.w, h: b.h } }));
}

/** The smallest zoom a plain picture opens at: below it a box's words are too small to read. */
export const FLOW_FIT_MIN = 0.6;
/** The width assumed before the picture is measured (the server render, the first paint). */
const FIRST_WIDTH = 960;

/**
 * A catalog view drawn with its own groups, nodes and edges, in the shared viewer (F10): it fills
 * the width and the height left on the page, opens fitted, zooms by wheel, pinch, buttons and keys,
 * pans by drag and arrows, finds a box, dims all but a box and its neighbours, and goes full screen.
 * Pointing at (or focusing) a node lights its edges and names them.
 */
export function FlowCanvas({
  view,
  height,
  selected,
  highlight = [],
  onPick,
  initialFull,
  initialFocus,
}: {
  view: FlowViewData;
  /** The least height the picture gets; it takes the height left on the page when that is more. */
  height?: number;
  /** A node lit from the start (a focus), with its edges. */
  selected?: string;
  /** Nodes marked as found (search results, what a change reaches). */
  highlight?: string[];
  /** Called when a box is clicked, with its id. */
  onPick?: (id: string) => void;
  /** Tests: open in full screen, or in focus mode. */
  initialFull?: boolean;
  initialFocus?: boolean;
}) {
  const l = useMemo(() => flowLayout(view), [view]);
  const [hot, setHot] = useState<string | undefined>(selected);
  const [full, setFull] = useFullScreen(initialFull);
  const [focusMode, setFocusMode] = useState(!!initialFocus);
  const frame = useRef<HTMLDivElement | null>(null);
  const stage = useRef<HTMLDivElement | null>(null);
  const search = useRef<HTMLInputElement | null>(null);
  const h = useAvailableHeight(frame, { min: height ?? 420 });
  const [size, setSize] = useState<Size>({ width: FIRST_WIDTH, height: h });
  const content: Rect = { x: 0, y: 0, w: l.width, h: l.height };
  const fitNow = (s: Size) => fitRect(content, s, { min: FLOW_FIT_MIN });
  const [v, setV] = useState<Viewport>(() => fitNow({ width: FIRST_WIDTH, height: h }));
  const sized = useRef(false);

  // Measure the stage, and fit on open (and whenever the view itself changes).
  useEffect(() => {
    const el = stage.current;
    if (!el || typeof window === "undefined") return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const s = { width: r.width, height: r.height };
      setSize(s);
      if (!sized.current) {
        sized.current = true;
        setV(fitRect({ x: 0, y: 0, w: l.width, h: l.height }, s, { min: FLOW_FIT_MIN }));
      }
    };
    measure();
    const ro = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    ro?.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [l, full]);
  useEffect(() => {
    sized.current = false;
  }, [l]);

  // Wheel and pinch (a trackpad pinch is a wheel with Ctrl): zoom about the pointer, smoothly.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const at = { x: e.clientX - r.left, y: e.clientY - r.top };
      setV((cur) => zoomAt(cur, wheelFactor(e.deltaY, e.deltaMode), at));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Drag to pan; two fingers pinch. A press on a box is the box's (a click), not a pan.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const [panning, setPanning] = useState(false);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as Element).closest?.("[data-node]")) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    setPanning(true);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const ps = pointers.current;
    const was = ps.get(e.pointerId);
    if (!was) return;
    if (ps.size === 2) {
      const [a, b] = [...ps.values()];
      const other = a === was ? b! : a!;
      const before = Math.hypot(was.x - other.x, was.y - other.y);
      const after = Math.hypot(e.clientX - other.x, e.clientY - other.y);
      const r = e.currentTarget.getBoundingClientRect();
      const mid = { x: (e.clientX + other.x) / 2 - r.left, y: (e.clientY + other.y) / 2 - r.top };
      if (before > 0) setV((cur) => zoomAt(cur, after / before, mid));
    } else {
      const dx = e.clientX - was.x;
      const dy = e.clientY - was.y;
      setV((cur) => ({ ...cur, x: cur.x + dx, y: cur.y + dy }));
    }
    ps.set(e.pointerId, { x: e.clientX, y: e.clientY });
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    if (!pointers.current.size) setPanning(false);
  };

  const marked = new Set(highlight);
  const lit = (e: { from: string; to: string }) =>
    hot !== undefined && (e.from === hot || e.to === hot);
  const label = (id: string) => view.nodes.find((n) => n.id === id)?.label ?? id;
  const hotEdges = hot ? l.edges.filter(lit) : [];
  const near = focusMode && hot ? neighbourhood(l.edges, hot) : undefined;
  const centre = (r: Rect, k = Math.max(v.k, 1)) => setV(centreOn(v, r, size, clampZoom(k)));
  const boxOf = (id: string) => {
    const b = l.nodes.get(id);
    return b ? { x: b.x, y: b.y, w: b.w, h: b.h } : undefined;
  };

  const act = (a: ViewerAction) => {
    const mid = { x: size.width / 2, y: size.height / 2 };
    switch (a) {
      case "zoom-in":
        return setV((cur) => zoomAt(cur, ZOOM.step, mid));
      case "zoom-out":
        return setV((cur) => zoomAt(cur, 1 / ZOOM.step, mid));
      case "reset":
        return setV((cur) => zoomAt(cur, 1 / cur.k, mid));
      case "fit":
        return setV(fitNow(size));
      case "fit-selection": {
        const r = hot ? boxOf(hot) : undefined;
        if (r) centre(r, Math.max(v.k, 1.2));
        return;
      }
      case "focus":
        return setFocusMode((f) => !f);
      case "full-screen":
        sized.current = false;
        setFull();
        requestAnimationFrame(() => frame.current?.focus());
        return;
      case "leave":
        sized.current = false;
        return setFull(false);
      case "search":
        return search.current?.focus();
      default:
        return setV((cur) => panBy(cur, a));
    }
  };
  const find = (id: string) => {
    setHot(id);
    onPick?.(id);
    const r = boxOf(id);
    if (r) centre(r);
  };
  const big = view.nodes.length > MINIMAP_FROM;

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <DiagramFrame
        title={view.title}
        full={full}
        height={h}
        frameRef={frame}
        onKeyAction={act}
        toolbar={
          <ViewerToolbar
            zoom={v.k}
            full={full}
            focus={focusMode}
            picked={!!hot}
            nodes={view.nodes}
            onAction={act}
            onFind={find}
            searchRef={search}
          />
        }
      >
        <div
          ref={stage}
          className={`flow-canvas ${panning ? "panning" : ""}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {/* A group, not an image: its boxes are buttons (an image can hold no control). */}
          <svg
            role="group"
            aria-label={T.nodesInGroupsEdges(
              view.title,
              view.nodes.length,
              view.groups.length,
              view.edges.length,
            )}
            width="100%"
            height="100%"
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
                <path d="M0 0 L8 4 L0 8 z" fill="var(--accent)" />
              </marker>
            </defs>
            <g
              transform={`translate(${n1(v.x)} ${n1(v.y)}) scale(${Math.round(v.k * 1000) / 1000})`}
            >
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
                      fill="var(--wash)"
                      stroke="var(--accent)"
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
                      fill="var(--flow-label)"
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
                    stroke={lit(e) ? "var(--accent-soft)" : "var(--accent)"}
                    strokeOpacity={hot === undefined ? 0.45 : lit(e) ? 1 : near ? 0.06 : 0.12}
                    strokeWidth={(lit(e) ? 1.6 : 1) / Math.max(0.5, Math.min(1, v.k))}
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
                    data-node={n.id}
                    tabIndex={0}
                    role="button"
                    aria-label={`${n.label} (${n.kind})`}
                    aria-pressed={on}
                    className="flow-node"
                    opacity={near && !near.has(n.id) ? 0.2 : 1}
                    style={{ cursor: "pointer" }}
                    onMouseEnter={() => setHot(n.id)}
                    onFocus={() => setHot(n.id)}
                    onClick={() => {
                      setHot(on ? undefined : n.id);
                      onPick?.(n.id);
                    }}
                    // An SVG group gets no click from the keyboard: Enter and Space do what a click does.
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setHot(on ? undefined : n.id);
                        onPick?.(n.id);
                      }
                    }}
                  >
                    <rect
                      x={b.x}
                      y={b.y}
                      width={b.w}
                      height={b.h}
                      rx={n.kind === "table" ? 3 : n.kind === "topic" ? b.h / 2 : 6}
                      fill={
                        on
                          ? "var(--picked-on)"
                          : marked.has(n.id)
                            ? "var(--picked-strong)"
                            : "var(--box)"
                      }
                      stroke={
                        on || marked.has(n.id)
                          ? "var(--accent-soft)"
                          : n.kind === "table"
                            ? "var(--flow-table)"
                            : "var(--accent)"
                      }
                      strokeDasharray={n.kind === "topic" ? "4 3" : undefined}
                      strokeWidth={on ? 1.6 : 1}
                    />
                    <text
                      x={b.x + 9}
                      y={b.y + 15}
                      fontFamily="JetBrains Mono, monospace"
                      fontSize={11}
                      fill={on ? "var(--text)" : "var(--accent-pale)"}
                    >
                      {boxText(n.label, l.inside.get(n.id))}
                    </text>
                  </g>
                );
              })}
            </g>
          </svg>
          {big && <MiniMap l={l} v={v} size={size} onCentre={(r) => centre(r, v.k)} />}
        </div>
      </DiagramFrame>
      <p className="muted" style={{ fontSize: 12, margin: 0 }} aria-live="polite">
        {hot
          ? T.edgePointAtAnother(
              label(hot),
              hotEdges.length,
              hotEdges.length === 1 ? "" : "s",
              edgeLabels(hotEdges.map((e) => e.label)),
              l.inside.get(hot) ? T.callsInsideIt(l.inside.get(hot) ?? 0) : "",
            )
          : view.type === "context" && view.nodes.length === 1
            ? T.everythingHereIsOne
            : T.edgesPointAtA(l.edges.length)}
        {focusMode && hot ? ` ${COPY.viewer.focusOn(label(hot))}` : ""}
      </p>
    </div>
  );
}

/** The whole picture small, with the part in view outlined; a click there centres on it. */
function MiniMap(p: { l: FlowLayout; v: Viewport; size: Size; onCentre: (r: Rect) => void }) {
  const W = 160;
  const s = W / Math.max(1, p.l.width);
  const H = Math.max(40, Math.round(p.l.height * s));
  const view = {
    x: -p.v.x / p.v.k,
    y: -p.v.y / p.v.k,
    w: p.size.width / p.v.k,
    h: p.size.height / p.v.k,
  };
  return (
    // A pointer's shortcut: the arrows and the find box do the same from the keyboard.
    <div
      className="flow-minimap"
      aria-hidden="true"
      data-node="minimap"
      onPointerDown={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const x = (e.clientX - r.left) / s;
        const y = (e.clientY - r.top) / s;
        p.onCentre({ x, y, w: 0, h: 0 });
      }}
    >
      <svg width={W} height={H}>
        {[...p.l.nodes.values()].map((b, i) => (
          <rect
            key={i}
            x={b.x * s}
            y={b.y * s}
            width={Math.max(1, b.w * s)}
            height={Math.max(1, b.h * s)}
            fill="var(--minimap-node)"
          />
        ))}
        <rect
          x={view.x * s}
          y={view.y * s}
          width={view.w * s}
          height={view.h * s}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={1.5}
        />
      </svg>
    </div>
  );
}
