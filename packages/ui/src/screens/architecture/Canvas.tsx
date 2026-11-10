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
  DiagramFrame,
  LABELS_FROM,
  MINIMAP_FROM,
  panBy,
  ViewerToolbar,
  ZOOM,
  neighbourhood,
  useAvailableHeight,
  useFullScreen,
  type ViewerAction,
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
  const [path, lx, ly] = still
    ? polyline(d.points!)
    : getSmoothStepPath({
        sourceX: p.sourceX,
        sourceY: p.sourceY,
        targetX: p.targetX,
        targetY: p.targetY,
        sourcePosition: p.sourcePosition,
        targetPosition: p.targetPosition,
      });
  // ADR 0174: a person's word (declared, or paired on the canvas) is drawn dashed; ADR 0181: the
  // AI's pairing dotted, with ◆ and the words in its label.
  const word = d.link.declared || d.link.paired;
  const ai = !word && !!d.link.ai;
  // ADR 0192: a build dependency, never a call: dash-dot, its label "depends on" in words.
  const dep = !!d.link.dependency;
  const cls = `arch-link ${d.link.async ? "async" : ""} ${d.link.gaps.length ? "gappy" : ""} ${d.link.mark ? `m-${d.link.mark}` : ""} ${word ? "word" : ""} ${ai ? "ai" : ""} ${dep ? "dep" : ""} ${d.picked ? "picked" : ""}`;
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
          className={`arch-link-label nodrag nopan ${d.link.gaps.length ? "gappy" : ""} ${d.link.mark ? `m-${d.link.mark}` : ""} ${ai ? "ai" : ""} ${dep ? "dep" : ""} ${d.picked ? "picked" : ""}`}
          style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}
        >
          {d.link.gaps.length > 0 && <span aria-hidden="true">⚠ </span>}
          {d.link.label}
          {d.link.gaps.length > 0 && (
            <span className="sr"> ({WORDS.gapsOn(d.link.gaps.length)})</span>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const nodeTypes = { box: BoxView };
/** The smallest zoom a fit goes to: below it a box's words are too small to read. */
export const FIT_MIN_ZOOM = 0.6;
const edgeTypes = { link: LinkView };

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
      label: { width: Math.ceil(l.label.length * 6.6) + 16, height: 20 },
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
  const edges = g.links
    .filter((l) => laid.boxes[l.from] && laid.boxes[l.to] && l.from !== l.to)
    .map((l): LinkEdge => {
      const r = laid.routes[l.id];
      const data: LinkData = { link: l };
      if (r) {
        data.points = r.points;
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
  /** Details laid over the picture's right edge (the inspector), never beside it. */
  aside?: ReactNode;
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
  const height = useAvailableHeight(frame, p.height !== undefined ? { fixed: p.height } : {});

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
        // Fit, but never so small the words can't be read: a bigger picture pans instead.
        requestAnimationFrame(
          () => void rf.current?.fitView({ padding: 0.08, duration: 200, minZoom: FIT_MIN_ZOOM }),
        );
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
        void i?.fitView({ padding: 0.08, minZoom: FIT_MIN_ZOOM, ...d });
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
        className={`arch-canvas ${zoom < LABELS_FROM ? "far" : ""} ${lit ? "focusing" : ""}`}
        style={{ height: "100%", ...labelScale(zoom) }}
        aria-busy={state.state === "running"}
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
            onMove={(_, v) => setZoom(v.zoom)}
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
            onNodeDragStop={(_, n, dragged) => {
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
            fitViewOptions={{ padding: 0.08, minZoom: FIT_MIN_ZOOM }}
            colorMode="dark"
            aria-label={WORDS.canvasLabel}
          >
            <Background gap={24} />
            {nodes.length > MINIMAP_FROM && (
              <MiniMap pannable zoomable ariaLabel={COPY.viewer.minimap} />
            )}
          </ReactFlow>
        )}
      </div>
    </DiagramFrame>
  );
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
