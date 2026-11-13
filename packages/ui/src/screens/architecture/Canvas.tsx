import {
  Background,
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  useInternalNode,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance,
  applyNodeChanges,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  absolute,
  layoutGraph,
  type Laid,
  type LayoutEngine,
  type Point,
} from "../../app/layout/index.js";
import { COPY } from "../../copy.js";
import {
  CANVAS_MAX_TOP,
  DiagramFrame,
  FIT_MAX,
  fitLegibly,
  LABELS_FROM,
  MINIMAP_FROM,
  panBy,
  ViewerToolbar,
  ZOOM,
  neighbourhood,
  useAvailableHeight,
  useFitOnResize,
  useFullScreen,
  type Rect,
  type Size,
  type ViewerAction,
  type Viewport,
} from "../../app/viewer.js";
import { boxSize, type CanvasBox, type CanvasGraph, type CanvasLink } from "./model.js";
import { WORDS } from "./words.js";

const TOPIC = COPY.topics;

type Dir = "RIGHT" | "DOWN";

/** A component type as the box draws it (ADR 0180). */
export interface TypeDraw {
  name: string;
  description: string;
  badge?: string;
  colour?: string;
  shape?: string;
}
export type TypeDraws = Record<string, TypeDraw>;

interface BoxData extends Record<string, unknown> {
  box: CanvasBox;
  dir: Dir;
  selected: boolean;
  types?: TypeDraws;
}
type BoxNode = Node<BoxData, "box">;

interface LinkData extends Record<string, unknown> {
  link: CanvasLink;
  /** The engine's route, and where its two boxes were when it was drawn. */
  points?: Point[];
  labelAt?: Point;
  ends?: { from: Point; to: Point };
  /** ADR 0181: the link picked (its inspector is open). */
  picked?: boolean;
}
type LinkEdge = Edge<LinkData, "link">;

/** A warning mark: shape and words as well as colour (WCAG 1.4.1). */
function GapMark({ n }: { n: number }) {
  return (
    <span className="arch-gap">
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
        <path d="M6 1 L11 11 H1 Z" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M6 5 V7.5 M6 9 V9.5" stroke="currentColor" strokeWidth="1.5" />
      </svg>
      {WORDS.gapsOn(n)}
    </span>
  );
}

function BoxView({ data }: NodeProps<BoxNode>) {
  const { box, dir } = data;
  const shape = box.typeId ? data.types?.[box.typeId]?.shape : undefined;
  const cls = [
    "arch-box",
    shape ? `shape-${shape}` : "",
    box.group ? "group" : "",
    box.outside ? "outside" : "",
    box.kind === "topic" ? "topic" : "",
    box.gaps.length ? "gappy" : "",
    data.selected ? "picked" : "",
    box.mark ? `m-${box.mark}` : "",
    box.badge
      ? `heat-${Math.min(3, box.badge.n === 0 ? 0 : box.badge.n < 3 ? 1 : box.badge.n < 10 ? 2 : 3)}`
      : "",
  ].join(" ");
  return (
    <div className={cls} title={box.gaps.map((g) => WORDS.gap[g] ?? g).join(", ") || undefined}>
      <Handle type="target" position={dir === "RIGHT" ? Position.Left : Position.Top} />
      <div className="arch-box-head">
        {box.typeId && data.types?.[box.typeId] ? (
          // ADR 0180: the component's type, as the organisation draws it: a badge and its colour.
          <span
            className="hud arch-type"
            title={`${data.types[box.typeId]!.name}: ${data.types[box.typeId]!.description}`}
            aria-label={`${data.types[box.typeId]!.name} (${box.kind})`}
            style={
              data.types[box.typeId]!.colour
                ? { borderLeft: `3px solid ${data.types[box.typeId]!.colour}`, paddingLeft: 4 }
                : undefined
            }
          >
            {data.types[box.typeId]!.badge ?? box.typeId}
          </span>
        ) : (
          <span className="hud">{box.kind}</span>
        )}
        {box.childCount > 0 && !box.group && (
          <span className="hud">{WORDS.children(box.childCount)}</span>
        )}
      </div>
      <div className="arch-box-label">
        {box.label}
        {box.outside && ` (${WORDS.outsideMark})`}
      </div>
      {box.kind === "topic" && (
        <div className="hud arch-box-owner">
          {ownerText(box)}
          {box.declared && ` · ${TOPIC.declared}`}
        </div>
      )}
      {box.badge && (
        <div className="arch-box-badge">
          <span className="chip">{`${box.badge.n} ${box.badge.what}`}</span>
        </div>
      )}
      {(box.gaps.length > 0 || box.inside > 0) && (
        <div className="arch-box-foot">
          {box.gaps.length > 0 && <GapMark n={box.gaps.length} />}
          {box.inside > 0 && <span className="hud">{WORDS.insideLinks(box.inside)}</span>}
        </div>
      )}
      <Handle type="source" position={dir === "RIGHT" ? Position.Right : Position.Bottom} />
    </div>
  );
}

/** The elements under a point, topmost first (the document's; tests pass their own). */
type ElementsAt = (x: number, y: number) => readonly Element[];

/**
 * The box a pointer or touch ended on, by the node element under it (its id). Review round 2
 * (beta.23): only through the canvas's own layers (the line being drawn, links, their labels):
 * a drop on the inspector, the Connect panel, the minimap or anything else over the picture
 * connects to no box hidden beneath it.
 */
export function boxUnder(
  e: MouseEvent | TouchEvent,
  at: ElementsAt = (x, y) => document.elementsFromPoint(x, y),
): string | undefined {
  const t = "changedTouches" in e ? e.changedTouches[0] : undefined;
  const x = t ? t.clientX : "clientX" in e ? e.clientX : undefined;
  const y = t ? t.clientY : "clientY" in e ? e.clientY : undefined;
  if (x === undefined || y === undefined) return undefined;
  for (const el of at(x, y)) {
    const node = el.closest?.(".react-flow__node");
    if (node) return node.getAttribute("data-id") ?? undefined;
    // Topmost first: an overlay (a panel of the canvas, the minimap) or anything outside the
    // canvas ends the look; the canvas's own layers above a box are looked through.
    if (!el.closest?.(".react-flow") || el.closest(".react-flow__panel")) return undefined;
  }
  return undefined;
}

/**
 * A line dropped off a box's dot (xyflow found no handle there): the box under the drop, if any,
 * as [caller, callee]. Review round 2 (beta.23): a line drawn from a box's incoming (target) dot
 * means the other box calls this one, as xyflow reads a drop on a dot.
 */
export function connectEndOf(
  e: MouseEvent | TouchEvent,
  state: {
    isValid: boolean | null;
    fromNode?: { id: string } | null;
    fromHandle?: { type?: string | null } | null;
  },
  under: (e: MouseEvent | TouchEvent) => string | undefined = boxUnder,
): [string, string] | undefined {
  if (state.isValid || !state.fromNode) return undefined;
  const to = under(e);
  if (!to || to === state.fromNode.id) return undefined;
  return state.fromHandle?.type === "target" ? [to, state.fromNode.id] : [state.fromNode.id, to];
}

/** Who owns a topic or queue, as its box says it (F10). */
export const ownerText = (b: Pick<CanvasBox, "owner" | "ownerOutside">) =>
  b.owner
    ? b.ownerOutside
      ? TOPIC.ownerOutside(b.owner)
      : TOPIC.owner(b.owner)
    : TOPIC.ownerUnknown;

const near = (a: Point | undefined, b: Point | undefined) =>
  !!a && !!b && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;

/** An orthogonal polyline as an SVG path, and the middle of its middle segment for the label. */
function polyline(points: Point[]): [string, number, number] {
  const d = points.map((p, i) => `${i ? "L" : "M"}${p.x},${p.y}`).join(" ");
  const i = Math.max(1, Math.floor(points.length / 2));
  const a = points[i - 1]!;
  const b = points[i]!;
  return [d, (a.x + b.x) / 2, (a.y + b.y) / 2];
}

/** A box on the canvas, in canvas coordinates. */
export interface BoxRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The room a link's label takes: its words at 11 px monospace, and the warning mark when shown. */
export const linkLabelSize = (l: Pick<CanvasLink, "label" | "gaps">) => ({
  width: Math.ceil((l.label.length + (l.gaps.length ? 2 : 0)) * 6.6) + 16,
  height: 20,
});

/** Room kept between a label and a box, or another label. */
const LABEL_GAP = 4;
const PLACES = [0.5, 0.35, 0.65, 0.2, 0.8, 0.1, 0.9];
/** Beta.27 review: the most spots a label tries (a long route has many segments). */
export const LABEL_TRIES = 40;

/** A label's room, its centre at `c`. */
const labelRect = (c: Point, size: { width: number; height: number }): BoxRect => ({
  x: c.x - size.width / 2,
  y: c.y - size.height / 2,
  width: size.width,
  height: size.height,
});

/**
 * Beta.27: where a link's label goes (its centre): on its route, clear of every box. Beta.26 put
 * it at the middle of the route's middle segment, which can run beside a box ("2 × calls" under
 * payments.initiated). The middle segment's middle first, then along it, then along the other
 * segments nearest the middle; where nothing on the route is clear, the middle as before.
 * Beta.27 review: clear of the labels already placed (`placed`) too, so two links' words never
 * lie on each other; at most LABEL_TRIES spots are tried, and where none is clear of both, the
 * first clear of the boxes, else the middle.
 */
export function labelSpot(
  points: readonly Point[],
  size: { width: number; height: number },
  boxes: readonly BoxRect[],
  placed: readonly BoxRect[] = [],
): Point {
  const mid = Math.max(0, Math.floor(points.length / 2) - 1);
  const at = (i: number, t: number): Point => {
    const a = points[i]!;
    const b = points[i + 1] ?? a;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  };
  const clearOf = (c: Point, rects: readonly BoxRect[]) =>
    !rects.some(
      (r) =>
        c.x - size.width / 2 < r.x + r.width + LABEL_GAP &&
        c.x + size.width / 2 > r.x - LABEL_GAP &&
        c.y - size.height / 2 < r.y + r.height + LABEL_GAP &&
        c.y + size.height / 2 > r.y - LABEL_GAP,
    );
  const segments = [...Array(Math.max(1, points.length - 1)).keys()].sort(
    (a, b) => Math.abs(a - mid) - Math.abs(b - mid) || a - b,
  );
  let ofBoxes: Point | undefined;
  let tries = 0;
  for (const i of segments)
    for (const t of PLACES) {
      if (tries++ >= LABEL_TRIES) return ofBoxes ?? at(mid, 0.5);
      const c = at(i, t);
      if (!clearOf(c, boxes)) continue;
      if (clearOf(c, placed)) return c;
      ofBoxes ??= c;
    }
  return ofBoxes ?? at(mid, 0.5);
}

/**
 * Beta.27 review: every link's label spot, in order, each clear of the boxes and of the labels
 * placed before it (labelSpot). Links without a route of two points or more get none.
 */
export function labelSpots(
  links: readonly {
    id: string;
    points?: readonly Point[];
    size: { width: number; height: number };
  }[],
  boxes: readonly BoxRect[],
): Map<string, Point> {
  const out = new Map<string, Point>();
  const placed: BoxRect[] = [];
  for (const l of links) {
    if (!l.points || l.points.length < 2) continue;
    const c = labelSpot(l.points, l.size, boxes, placed);
    out.set(l.id, c);
    placed.push(labelRect(c, l.size));
  }
  return out;
}

/**
 * An edge on the engine's route while both its boxes stay where the layout put them; once
 * either is dragged, a stepped line between them, so edges follow the boxes.
 */
function LinkView(p: EdgeProps<LinkEdge>) {
  const s = useInternalNode(p.source);
  const t = useInternalNode(p.target);
  const d = p.data!;
  const still =
    d.points &&
    near(s?.internals.positionAbsolute, d.ends?.from) &&
    near(t?.internals.positionAbsolute, d.ends?.to);
  const [path, mx, my] = still
    ? polyline(d.points!)
    : getSmoothStepPath({
        sourceX: p.sourceX,
        sourceY: p.sourceY,
        targetX: p.targetX,
        targetY: p.targetY,
        sourcePosition: p.sourcePosition,
        targetPosition: p.targetPosition,
      });
  // Beta.27: on the engine's route, the spot kept clear of the boxes.
  const lx = still && d.labelAt ? d.labelAt.x : mx;
  const ly = still && d.labelAt ? d.labelAt.y : my;
  // ADR 0174: a person's word (declared, or paired on the canvas) is drawn dashed; ADR 0181: the
  // AI's pairing dotted, with ◆ and the words in its label.
  const word = d.link.declared || d.link.paired;
  const ai = !word && !!d.link.ai;
  // ADR 0192: a build dependency, never a call: dash-dot, its label "depends on" in words.
  const dep = !!d.link.dependency;
  // Beta.28, Edit the map: a change staged on it, drawn and said (WCAG 1.4.1).
  const st = d.link.staged ? `staged-${d.link.staged}` : "";
  const cls = `arch-link ${d.link.async ? "async" : ""} ${d.link.gaps.length ? "gappy" : ""} ${d.link.mark ? `m-${d.link.mark}` : ""} ${word ? "word" : ""} ${ai ? "ai" : ""} ${dep ? "dep" : ""} ${d.picked ? "picked" : ""} ${st}`;
  return (
    <>
      <BaseEdge
        id={p.id}
        path={path}
        className={cls}
        {...(p.markerEnd ? { markerEnd: p.markerEnd } : {})}
      />
      <EdgeLabelRenderer>
        <div
          className={`arch-link-label nodrag nopan ${d.link.gaps.length ? "gappy" : ""} ${d.link.mark ? `m-${d.link.mark}` : ""} ${ai ? "ai" : ""} ${dep ? "dep" : ""} ${d.picked ? "picked" : ""} ${st}`}
          style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}
        >
          {d.link.gaps.length > 0 && <span aria-hidden="true">⚠ </span>}
          {d.link.label}
          {d.link.staged && <span> · {COPY.editMap.onCanvas[d.link.staged]}</span>}
          {d.link.gaps.length > 0 && (
            <span className="sr"> ({WORDS.gapsOn(d.link.gaps.length)})</span>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const nodeTypes = { box: BoxView };
/**
 * The smallest zoom a fit goes to: below it a box's words are too small to read. Beta.27: 0.6
 * drew a box's name at about 8 px and its kind at 6 px; at 0.9 they are 11 px and 10 px, and a
 * picture bigger than that is panned (fitLegibly starts it at its top-left).
 */
export const FIT_MIN_ZOOM = 0.9;
/** Beta.27 review: how long the view stays still before the boxes out of view are announced. */
export const ANNOUNCE_AFTER_MS = 700;
const edgeTypes = { link: LinkView };

/** The room round a fitted picture, as React Flow's fitView padding (a share of the view). */
export const FIT_PADDING = 0.08;
/**
 * Beta.27 review: FIT_PADDING in pixels on each side, as fitView makes it: the picture takes
 * the view's size over (1 + padding), so each side keeps half of the rest.
 */
export const fitPad = (view: Size): number =>
  Math.round((Math.min(view.width, view.height) * (1 - 1 / (1 + FIT_PADDING))) / 2);

/**
 * Beta.27 review: the canvas's fit (Fit, the first fit, a resize's): legible (never below
 * FIT_MIN_ZOOM; a bigger picture starts at its top-left), never zoomed in past actual size
 * (FIT_MAX: beta.27's first cut let a small estate fit at 300 %), with fitView's padding.
 */
export function canvasFit(
  content: Rect,
  view: Size,
  /**
   * Beta.27 review: the boxes, so a picture too big for the view starts at its first box (the
   * top-most, centred across when the picture is wider than the view), not at its bounds' empty
   * corner: a big estate opened on an empty canvas, "0 of 67 boxes in view".
   */
  rects?: readonly (BoxRect & { group?: boolean })[],
): Viewport {
  const pad = fitPad(view);
  const v = fitLegibly(content, view, { min: FIT_MIN_ZOOM, max: FIT_MAX, pad });
  const first = (rects ?? [])
    .filter((r) => !r.group)
    .reduce<BoxRect | undefined>(
      (a, r) => (!a || r.y < a.y || (r.y === a.y && r.x < a.x) ? r : a),
      undefined,
    );
  if (!first) return v;
  const wide = content.w * v.k > view.width - pad * 2;
  const tall = content.h * v.k > view.height - pad * 2;
  // Across: the first box in the middle, never past the picture's own edges.
  const across = (view.width - first.width * v.k) / 2 - first.x * v.k;
  const most = pad - content.x * v.k;
  const least = view.width - pad - (content.x + content.w) * v.k;
  return {
    k: v.k,
    x: wide ? Math.min(most, Math.max(least, across)) : v.x,
    y: tall ? pad - first.y * v.k : v.y,
  };
}

/**
 * Beta.27 review: Fit (the button, the 0 key) fits everything, however small: the legibility
 * floor is for the picture a page opens on (canvasFit), not for the person asking to see it all.
 */
export function canvasFitAll(content: Rect, view: Size): Viewport {
  return fitLegibly(content, view, { min: ZOOM.min, max: FIT_MAX, pad: fitPad(view) });
}

/** Where each box is on the canvas (a box inside a group is placed in it), groups marked. */
export function contentRects(
  nodes: readonly Pick<BoxNode, "id" | "position" | "width" | "height" | "parentId" | "data">[],
): (BoxRect & { group: boolean })[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const at = (id: string, seen = 0): { x: number; y: number } => {
    const n = byId.get(id);
    if (!n) return { x: 0, y: 0 };
    const up = n.parentId && seen < 32 ? at(n.parentId, seen + 1) : { x: 0, y: 0 };
    return { x: up.x + n.position.x, y: up.y + n.position.y };
  };
  return nodes.map((n) => ({
    ...at(n.id),
    width: n.width ?? 0,
    height: n.height ?? 0,
    group: !!n.data.box.group,
  }));
}

/** The rectangle round every box. */
export function boundsOf(rects: readonly BoxRect[]): Rect | undefined {
  if (!rects.length) return undefined;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const w = Math.max(...rects.map((r) => r.x + r.width)) - x;
  const h = Math.max(...rects.map((r) => r.y + r.height)) - y;
  return { x, y, w, h };
}

/**
 * Beta.27 review: how many boxes (not groups) lie wholly outside the view, so the page says so
 * ("1 of 67 boxes in view" read as an empty canvas).
 */
export function boxesOutside(
  rects: readonly (BoxRect & { group?: boolean })[],
  v: Viewport,
  view: Size,
): number {
  const left = -v.x / v.k;
  const top = -v.y / v.k;
  const right = left + view.width / v.k;
  const bottom = top + view.height / v.k;
  return rects.filter(
    (r) =>
      !r.group && (r.x + r.width <= left || r.x >= right || r.y + r.height <= top || r.y >= bottom),
  ).length;
}

/** The input the layout gets for a canvas graph. */
export function layoutInput(g: CanvasGraph) {
  return {
    nodes: g.boxes.map((b) => ({
      id: b.id,
      ...boxSize(b),
      ...(b.parent ? { parent: b.parent } : {}),
    })),
    groups: g.boxes
      .filter((b) => b.group)
      .map((b) => ({ id: b.id, ...(b.parent ? { parent: b.parent } : {}) })),
    edges: g.links.map((l) => ({
      id: l.id,
      from: l.from,
      to: l.to,
      label: linkLabelSize(l),
    })),
  };
}

/** React Flow's nodes and edges for a laid-out graph; groups come before what is inside them. */
export function flowElements(
  g: CanvasGraph,
  laid: Laid,
  dir: Dir,
  selected?: string,
  types?: TypeDraws,
): { nodes: BoxNode[]; edges: LinkEdge[] } {
  const depth = (id: string | undefined): number => {
    const b = id ? laid.boxes[id] : undefined;
    return b ? 1 + depth(b.parent) : 0;
  };
  const nodes = g.boxes
    .filter((b) => laid.boxes[b.id])
    .map((b) => {
      const p = laid.boxes[b.id]!;
      const n: BoxNode = {
        id: b.id,
        type: "box",
        position: { x: p.x, y: p.y },
        data: { box: b, dir, selected: b.id === selected, ...(types ? { types } : {}) },
        width: p.width,
        height: p.height,
        ariaLabel: `${b.kind} ${b.label}${b.kind === "topic" ? `, ${ownerText(b)}` : ""}${b.declared ? `, ${TOPIC.declared}` : ""}${b.gaps.length ? `, ${b.gaps.map((g) => WORDS.gap[g] ?? g).join(", ")}` : ""}`,
        ...(b.parent ? { parentId: b.parent, expandParent: true } : {}),
        ...(b.group ? { zIndex: -1 } : {}),
      };
      return n;
    })
    .sort((a, b) => depth(a.id) - depth(b.id));
  // Beta.27: the boxes a label keeps clear of (a group holds them, so it isn't one).
  const rects: BoxRect[] = Object.values(laid.boxes)
    .filter((b) => !b.group)
    .map((b) => ({ ...absolute(laid.boxes, b.id), width: b.width, height: b.height }));
  const drawn = g.links.filter((l) => laid.boxes[l.from] && laid.boxes[l.to] && l.from !== l.to);
  // Beta.27 review: each label clear of the boxes and of the labels placed before it.
  const spots = labelSpots(
    drawn.map((l) => ({
      id: l.id,
      ...(laid.routes[l.id] ? { points: laid.routes[l.id]!.points } : {}),
      size: linkLabelSize(l),
    })),
    rects,
  );
  const edges = drawn.map((l): LinkEdge => {
    const r = laid.routes[l.id];
    const data: LinkData = { link: l };
    if (r) {
      data.points = r.points;
      const at = spots.get(l.id);
      if (at) data.labelAt = at;
      data.ends = { from: absolute(laid.boxes, l.from), to: absolute(laid.boxes, l.to) };
    }
    return {
      id: l.id,
      source: l.from,
      target: l.to,
      type: "link",
      data,
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
      ariaLabel: `${l.from} ${l.label} ${l.to}`,
    };
  });
  return { nodes, edges };
}

type LayoutState = { state: "running" } | { state: "failed"; error: string } | { state: "ready" };

/**
 * The Architecture screen's interactive canvas (plan 4.6): React Flow drawing what ELK laid out.
 * Pan, zoom, a minimap and zoom buttons; groups for parts opened in place; boxes dragged with
 * their edges following. `pinned` holds the kept and dragged boxes; `tidy` changes to lay the
 * rest out again.
 */
export function ArchitectureCanvas(p: {
  graph: CanvasGraph;
  direction: Dir;
  pinned: Record<string, Point>;
  tidy: number;
  selected?: string;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  onMoved: (id: string, at: Point) => void;
  onLaid: (laid: Laid) => void;
  /** Tests: a layout to start from, and an engine to use instead of ELK's worker. */
  initial?: Laid;
  engine?: LayoutEngine;
  /** A fixed height; by default the picture takes the height left on the page (F10). */
  height?: number;
  /** ADR 0180: how each component type is drawn, by id. */
  types?: TypeDraws;
  /** Details laid over the picture's right edge (the inspector), or beside it (`asideBeside`). */
  aside?: ReactNode;
  /** Beta.26: the details as a right-hand panel beside the picture, which can be closed. */
  asideBeside?: boolean;
  /** Beta.26: changed to something, the details open again (a panel was asked for in them). */
  reveal?: string;
  /** Beta.27 review: nothing is picked, so empty details start closed in a narrow frame. */
  asideIdle?: boolean;
  /** Beta.26: laid over the picture itself (the legend, in a corner). */
  overlay?: ReactNode;
  /** Beta.26: where the picture's controls go outside full screen (the map's bar). */
  toolbarIn?: HTMLElement | null;
  /** Tests: open in full screen, or in focus mode. */
  initialFull?: boolean;
  initialFocus?: boolean;
  /** G1 (ADR 0174): a line drawn from one box to another: connect them call by call. */
  onConnect?: (from: string, to: string) => void;
  /** G6 (ADR 0175): the boxes to keep lit (a blast radius); the rest are dimmed. */
  lit?: ReadonlySet<string>;
  /** ADR 0181: a link clicked, and the link picked (drawn picked). */
  onSelectLink?: (id: string) => void;
  selectedLink?: string;
}) {
  const [state, setState] = useState<LayoutState>(
    p.initial ? { state: "ready" } : { state: "running" },
  );
  const [first] = useState(() =>
    p.initial ? flowElements(p.graph, p.initial, p.direction, p.selected, p.types) : undefined,
  );
  const [nodes, setNodes] = useState<BoxNode[]>(first?.nodes ?? []);
  const [edges, setEdges] = useState<LinkEdge[]>(first?.edges ?? []);
  const rf = useRef<ReactFlowInstance<BoxNode, LinkEdge> | undefined>(undefined);
  const pinned = useRef(p.pinned);
  pinned.current = p.pinned;
  const latest = useRef(p);
  latest.current = p;
  const frame = useRef<HTMLDivElement | null>(null);
  const search = useRef<HTMLInputElement | null>(null);
  const [full, setFull] = useFullScreen(p.initialFull);
  const [focusMode, setFocusMode] = useState(!!p.initialFocus);
  const [zoom, setZoom] = useState(1);
  // Beta.27 review: a notice above the picture is counted (CANVAS_MAX_TOP), so its foot stays
  // above the bottom panel; min 320 so a short window still fits it.
  const height = useAvailableHeight(
    frame,
    p.height !== undefined ? { fixed: p.height } : { maxTop: CANVAS_MAX_TOP, min: 320 },
  );
  // Beta.26 review: the picture fits the measured height (not the guess before it), and again
  // as that height changes, until the person pans or zooms it themselves.
  const moved = useRef(false);
  // Beta.27: every fit is a legible one (fitLegibly), in the canvas's own size.
  const stage = useRef<HTMLDivElement | null>(null);
  // Beta.27 review: the boxes as laid out, not React Flow's store (a store not yet updated
  // after a new layout fitted the old one: drilling into Portal cut its top box).
  const nodesNow = useRef<BoxNode[]>(nodes);
  nodesNow.current = nodes;
  const [outside, setOutside] = useState(0);
  const countOutside = (v?: { x: number; y: number; zoom: number }) => {
    const el = stage.current;
    const at = v ?? rf.current?.getViewport();
    if (!el || !at || !el.clientWidth || !el.clientHeight) return;
    const n = boxesOutside(
      contentRects(nodesNow.current),
      { x: at.x, y: at.y, k: at.zoom },
      { width: el.clientWidth, height: el.clientHeight },
    );
    setOutside((o) => (o === n ? o : n));
  };
  // Beta.27 review: the count is said to a screen reader once the view settles (a fit, or the
  // end of a pan), not at every step of a pan; the line on the page follows it as it moves.
  const [announced, setAnnounced] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setAnnounced(outside), ANNOUNCE_AFTER_MS);
    return () => clearTimeout(t);
  }, [outside]);
  /** Fit the picture: legibly (a page opening on it), or `all` of it (Fit, the 0 key). */
  const fitNow = (duration?: number, all = false) => {
    const i = rf.current;
    const el = stage.current;
    const rects = contentRects(nodesNow.current);
    const b = boundsOf(rects);
    if (!i || !el || !b || !el.clientWidth || !el.clientHeight) {
      void i?.fitView({
        padding: FIT_PADDING,
        minZoom: all ? ZOOM.min : FIT_MIN_ZOOM,
        maxZoom: FIT_MAX,
        ...(duration ? { duration } : {}),
      });
      return;
    }
    const view = { width: el.clientWidth, height: el.clientHeight };
    const v = all ? canvasFitAll(b, view) : canvasFit(b, view, rects);
    void i.setViewport({ x: v.x, y: v.y, zoom: v.k }, duration ? { duration } : undefined);
    countOutside({ x: v.x, y: v.y, zoom: v.k });
  };
  const fitRef = useRef(fitNow);
  fitRef.current = fitNow;
  /** A box is being dragged, or a pointer is down on the canvas (review of the fix). */
  const dragging = useRef(false);
  const pointerDown = useRef(false);
  useEffect(
    () => (typeof window === "undefined" ? undefined : releasePointerOn(window, pointerDown)),
    [],
  );
  /** The view panned to a box, at the zoom it has (a box Tab reached out of view). */
  const centerOn = (id: string) => {
    const i = rf.current;
    const n = i?.getInternalNode(id);
    // Review of the fix: never an animated pan while a box is dragged.
    if (!i || !n || dragging.current) return;
    const { x, y } = n.internals.positionAbsolute;
    moved.current = true;
    void i.setCenter(x + (n.measured.width ?? 0) / 2, y + (n.measured.height ?? 0) / 2, {
      zoom: i.getZoom(),
      duration: 200,
    });
  };
  const fitter = useRef({ fitView: () => fitRef.current() });
  useFitOnResize(fitter, {
    height,
    ready: state.state === "ready" && nodes.length > 0,
    full,
    moved,
    minZoom: FIT_MIN_ZOOM,
  });

  // Lay out again when the boxes or links change, or on Tidy up; not when a box is dragged.
  const shape = useMemo(
    () =>
      JSON.stringify([
        p.direction,
        p.graph.boxes.map((b) => [b.id, b.parent ?? "", b.group]),
        p.graph.links.map((l) => [l.id, l.label]),
      ]),
    [p.graph, p.direction],
  );
  const run = `${shape}#${p.tidy}`;
  const ran = useRef(p.initial ? run : "");
  useEffect(() => {
    if (ran.current === run) return;
    ran.current = run;
    let live = true;
    const { graph, direction, engine } = latest.current;
    const input = layoutInput(graph);
    setState((s) => (s.state === "ready" ? s : { state: "running" }));
    layoutGraph(
      input.nodes,
      input.edges,
      input.groups,
      { direction, pinned: pinned.current },
      engine,
    ).then(
      (laid) => {
        if (!live) return;
        const el = flowElements(
          graph,
          laid,
          direction,
          latest.current.selected,
          latest.current.types,
        );
        setNodes(el.nodes);
        setEdges(el.edges);
        setState({ state: "ready" });
        latest.current.onLaid(laid);
        // A new layout is fitted again, whatever the person did with the last one.
        moved.current = false;
        // Fit, but never so small the words can't be read: a bigger picture pans instead.
        requestAnimationFrame(() => fitRef.current(200));
      },
      (e: unknown) =>
        live && setState({ state: "failed", error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [run]);

  // Selection and box details change without a new layout.
  useEffect(() => {
    const byId = new Map(p.graph.boxes.map((b) => [b.id, b]));
    setNodes((ns) =>
      ns.map((n) => {
        const box = byId.get(n.id) ?? n.data.box;
        const selected = n.id === p.selected;
        return box === n.data.box && selected === n.data.selected && p.types === n.data.types
          ? n
          : { ...n, data: { ...n.data, box, selected, ...(p.types ? { types: p.types } : {}) } };
      }),
    );
    // A link's marks and gaps (compare, the contract check) change without a new layout too.
    const linkById = new Map(p.graph.links.map((l) => [l.id, l]));
    setEdges((es) =>
      es.map((e) => {
        const link = linkById.get(e.id) ?? e.data!.link;
        const picked = e.id === p.selectedLink;
        return link === e.data!.link && picked === !!e.data!.picked
          ? e
          : { ...e, data: { ...e.data!, link, picked } };
      }),
    );
  }, [p.graph, p.selected, p.types, p.selectedLink]);

  const onNodesChange = useCallback(
    (changes: NodeChange<BoxNode>[]) => setNodes((ns) => applyNodeChanges(changes, ns)),
    [],
  );

  // Focus mode (F10): everything but the picked box and its neighbours is dimmed.
  const lit = useMemo(
    () => p.lit ?? (focusMode && p.selected ? neighbourhood(p.graph.links, p.selected) : undefined),
    [p.lit, focusMode, p.selected, p.graph.links],
  );
  const shownNodes = useMemo(() => (lit ? nodes.map((n) => dimNode(n, lit)) : nodes), [nodes, lit]);
  const shownEdges = useMemo(
    () =>
      p.lit
        ? edges.map((e) =>
            p.lit!.has(e.source) && p.lit!.has(e.target)
              ? e
              : { ...e, style: { ...e.style, opacity: 0.15 } },
          )
        : lit && p.selected
          ? edges.map((e) => dimEdge(e, p.selected!))
          : edges,
    [edges, lit, p.lit, p.selected],
  );

  const act = (a: ViewerAction) => {
    const i = rf.current;
    const d = { duration: 200 };
    // The person's own zoom or pan is kept as the height changes; Fit hands it back to fitting.
    if (a === "fit") moved.current = false;
    else if (!["focus", "full-screen", "leave", "search"].includes(a)) moved.current = true;
    switch (a) {
      case "zoom-in":
        void i?.zoomIn(d);
        return;
      case "zoom-out":
        void i?.zoomOut(d);
        return;
      case "reset":
        void i?.zoomTo(1, d);
        return;
      case "fit":
        fitNow(d.duration, true);
        return;
      case "fit-selection":
        if (p.selected) void i?.fitView({ nodes: [{ id: p.selected }], maxZoom: 1.2, ...d });
        return;
      case "focus":
        setFocusMode((f) => !f);
        return;
      case "full-screen":
        setFull();
        requestAnimationFrame(() => frame.current?.focus());
        return;
      case "leave":
        setFull(false);
        return;
      case "search":
        search.current?.focus();
        return;
      default: {
        const v = i?.getViewport();
        if (!v) return;
        const to = panBy({ x: v.x, y: v.y, k: v.zoom }, a);
        void i?.setViewport({ x: to.x, y: to.y, zoom: v.zoom }, { duration: 120 });
      }
    }
  };
  const find = (id: string) => {
    moved.current = true;
    p.onSelect(id);
    requestAnimationFrame(
      () => void rf.current?.fitView({ nodes: [{ id }], maxZoom: 1, duration: 250 }),
    );
  };

  if (state.state === "failed")
    return (
      <div className="state error" role="alert">
        {WORDS.layoutFailed(state.error)}
      </div>
    );
  return (
    <DiagramFrame
      title={WORDS.canvasLabel}
      full={full}
      height={height}
      frameRef={frame}
      onKeyAction={act}
      {...(p.aside ? { aside: p.aside } : {})}
      {...(p.asideBeside ? { asideBeside: true } : {})}
      {...(p.reveal ? { reveal: p.reveal } : {})}
      {...(p.asideIdle ? { asideIdle: true } : {})}
      {...(p.toolbarIn ? { toolbarIn: p.toolbarIn } : {})}
      toolbar={
        <ViewerToolbar
          zoom={zoom}
          full={full}
          focus={focusMode}
          picked={!!p.selected}
          nodes={p.graph.boxes}
          onAction={act}
          onFind={find}
          searchRef={search}
        />
      }
    >
      <div
        ref={stage}
        className={`arch-canvas ${zoom < LABELS_FROM ? "far" : ""} ${lit ? "focusing" : ""}`}
        style={{ height: "100%", ...labelScale(zoom) }}
        aria-busy={state.state === "running"}
        // Beta.27 review: a box Tab reaches out of view is panned to, never scrolled to. Review
        // of the fix: only the keyboard's focus pans; a click or a drag focuses a box too, and
        // the view never moves under the pointer.
        // Beta.27 review, final round: the pointer comes up anywhere (released over the toolbar,
        // outside the canvas or the window): `releasePointerOn(window)` hears it, and a key.
        onPointerDownCapture={() => {
          pointerDown.current = true;
        }}
        onFocusCapture={(e) => {
          const el = stage.current;
          if (!el) return;
          const t = e.target as Element;
          boxFocused(t, el, centerOn, {
            keyboard: !pointerDown.current && !dragging.current && keyboardFocus(t),
          });
          // The browser may scroll the wrapper after the event: put it back on the next frame.
          requestAnimationFrame(() => boxFocused(t, el, () => undefined));
        }}
      >
        {state.state === "running" && !nodes.length ? (
          <div className="stack" aria-live="polite">
            <p className="hud">{WORDS.layingOutBoxes(p.graph.boxes.length)}</p>
            <div className="skeleton" style={{ width: "70%" }} />
            <div className="skeleton" style={{ width: "50%" }} />
          </div>
        ) : (
          <ReactFlow<BoxNode, LinkEdge>
            nodes={shownNodes}
            edges={shownEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onInit={(i) => {
              rf.current = i;
              setZoom(i.getZoom());
            }}
            onMove={(_, v) => {
              setZoom(v.zoom);
              countOutside(v);
            }}
            // A move the person started (a wheel, a drag, a pinch) has its event; a fit has none.
            onMoveStart={(e) => {
              if (e) moved.current = true;
            }}
            onNodeClick={(_, n) => p.onSelect(n.id)}
            // ADR 0181: a link clicked opens it in the inspector (the keyboard's way is the
            // inspector's links and the Detected by AI list in the tools).
            {...(p.onSelectLink ? { onEdgeClick: (_, e) => p.onSelectLink!(e.id) } : {})}
            onSelectionChange={({ nodes: picked }) => {
              if (picked.length === 1 && picked[0]!.id !== p.selected) p.onSelect(picked[0]!.id);
            }}
            onNodeDoubleClick={(_, n) => {
              if (n.data.box.childCount > 0) p.onToggle(n.id);
            }}
            onNodeDragStart={() => {
              dragging.current = true;
            }}
            onNodeDragStop={(_, n, dragged) => {
              dragging.current = false;
              for (const d of dragged.length ? dragged : [n]) p.onMoved(d.id, d.position);
            }}
            nodesConnectable={!!p.onConnect}
            onConnect={(c) => {
              if (c.source && c.target && c.source !== c.target) p.onConnect?.(c.source, c.target);
            }}
            // A line dropped anywhere on a box connects to it, not only on the box's small dot.
            {...(p.onConnect
              ? {
                  onConnectEnd: (
                    e: MouseEvent | TouchEvent,
                    state: Parameters<typeof connectEndOf>[1],
                  ) => {
                    const ends = connectEndOf(e, state);
                    if (ends) p.onConnect!(ends[0], ends[1]);
                  },
                }
              : {})}
            edgesFocusable={false}
            zoomOnDoubleClick={false}
            zoomOnPinch
            zoomOnScroll
            panOnDrag
            minZoom={ZOOM.min}
            maxZoom={ZOOM.max}
            fitView
            fitViewOptions={{ padding: FIT_PADDING, minZoom: FIT_MIN_ZOOM, maxZoom: FIT_MAX }}
            colorMode="dark"
            aria-label={WORDS.canvasLabel}
          >
            <Background gap={24} />
            {nodes.length > MINIMAP_FROM && (
              <MiniMap pannable zoomable ariaLabel={COPY.viewer.minimap} />
            )}
          </ReactFlow>
        )}
        {outside > 0 && nodes.length > 0 && state.state === "ready" && (
          <div className="arch-outside viewer-own">
            <span>
              {WORDS.outside(outside, contentRects(nodes).filter((r) => !r.group).length)}
            </span>{" "}
            <button type="button" className="btn" onClick={() => act("fit")}>
              {WORDS.fitAll}
            </button>
          </div>
        )}
        <span className="sr" role="status">
          {announced > 0 && nodes.length > 0 && state.state === "ready"
            ? WORDS.outside(announced, contentRects(nodes).filter((r) => !r.group).length)
            : ""}
        </span>
        {p.overlay}
      </div>
    </DiagramFrame>
  );
}

/**
 * Beta.27 review, final round: a pointer down on the canvas is up again when it comes up anywhere
 * (`pointerup` or `pointercancel` on the window: released over the toolbar or outside the canvas,
 * the canvas's own handlers never hear it), or when a key is pressed (a person on the keyboard is
 * not dragging), so Tab into a box out of view pans to it. Returns the way to stop listening.
 */
export function releasePointerOn(
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">,
  down: { current: boolean },
): () => void {
  // A modifier key pressed during a drag (Shift to select more, say) clears the flag too, and
  // harmlessly: the drag itself is `dragging`, and the flag only stops a focus from panning.
  const up = () => {
    down.current = false;
  };
  const events = ["pointerup", "pointercancel", "keydown"] as const;
  const capture = { capture: true };
  for (const e of events) target.addEventListener(e, up, capture);
  return () => {
    for (const e of events) target.removeEventListener(e, up, capture);
  };
}

/**
 * Review of the fix (beta.27): whether focus came from the keyboard, as the browser says it
 * (`:focus-visible`: a click focuses a box without it). A browser that can't say: not.
 */
export function keyboardFocus(el: Element): boolean {
  try {
    return typeof el.matches === "function" && el.matches(":focus-visible");
  } catch {
    return false;
  }
}

/**
 * Beta.27 review: Tab to a box outside the view made the browser scroll React Flow's
 * overflow-hidden wrapper to bring it in (React Flow 12.3 has no autoPanOnNodeFocus), so the
 * boxes and the pane under them went out of step until a reload. The scroll between the box and
 * the canvas is put back on any focus, and, when the box is out of view and the keyboard brought
 * focus there (`keyboard`, as the canvas tells it: never a click or a drag), `center` pans the
 * view to it. Whether it panned; nothing happens for focus on anything but a box.
 */
export function boxFocused(
  target: Element,
  stage: Element,
  center: (id: string) => void,
  o: { keyboard?: boolean } = {},
): boolean {
  const box = target.closest(".react-flow__node");
  if (!box || !stage.contains(box)) return false;
  for (let el = box.parentElement; el && el !== stage; el = el.parentElement) {
    if (el.scrollTop) el.scrollTop = 0;
    if (el.scrollLeft) el.scrollLeft = 0;
  }
  if (!o.keyboard) return false;
  const r = box.getBoundingClientRect();
  const v = stage.getBoundingClientRect();
  const inView = r.left >= v.left && r.right <= v.right && r.top >= v.top && r.bottom <= v.bottom;
  const id = box.getAttribute("data-id");
  if (inView || !id) return false;
  center(id);
  return true;
}

/** A node dimmed unless focus mode keeps it lit (a group stays: it holds lit boxes). */
export function dimNode(n: BoxNode, lit: ReadonlySet<string>): BoxNode {
  const on = lit.has(n.id) || n.data.box.group;
  const dim = n.className === "dim";
  return on === !dim ? n : { ...n, className: on ? "" : "dim" };
}

/** A link dimmed unless it touches the focused box. */
export function dimEdge(e: LinkEdge, focus: string): LinkEdge {
  return e.source === focus || e.target === focus ? e : { ...e, className: "dim" };
}

/**
 * Words stay readable as the picture shrinks (F10): a box's label grows against the zoom, up to
 * 1.8 times, and below LABELS_FROM the link labels are hidden (the `far` class).
 */
export const labelScale = (zoom: number) => ({
  "--label-scale": String(Math.round(Math.min(1.8, Math.max(1, 0.7 / zoom)) * 100) / 100),
});
