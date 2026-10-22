import {
  Background,
  BaseEdge,
  Controls,
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  absolute,
  layoutGraph,
  type Laid,
  type LayoutEngine,
  type Point,
} from "../../app/layout/index.js";
import { boxSize, type CanvasBox, type CanvasGraph, type CanvasLink } from "./model.js";
import { WORDS } from "./words.js";

type Dir = "RIGHT" | "DOWN";

interface BoxData extends Record<string, unknown> {
  box: CanvasBox;
  dir: Dir;
  selected: boolean;
}
type BoxNode = Node<BoxData, "box">;

interface LinkData extends Record<string, unknown> {
  link: CanvasLink;
  /** The engine's route, and where its two boxes were when it was drawn. */
  points?: Point[];
  labelAt?: Point;
  ends?: { from: Point; to: Point };
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
  const cls = [
    "arch-box",
    box.group ? "group" : "",
    box.outside ? "outside" : "",
    box.gaps.length ? "gappy" : "",
    data.selected ? "picked" : "",
  ].join(" ");
  return (
    <div className={cls} title={box.gaps.map((g) => WORDS.gap[g] ?? g).join(", ") || undefined}>
      <Handle type="target" position={dir === "RIGHT" ? Position.Left : Position.Top} />
      <div className="arch-box-head">
        <span className="hud">{box.kind}</span>
        {box.childCount > 0 && !box.group && (
          <span className="hud">{WORDS.children(box.childCount)}</span>
        )}
      </div>
      <div className="arch-box-label">
        {box.label}
        {box.outside && ` (${WORDS.outsideMark})`}
      </div>
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
  const cls = `arch-link ${d.link.async ? "async" : ""} ${d.link.gaps.length ? "gappy" : ""}`;
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
          className={`arch-link-label nodrag nopan ${d.link.gaps.length ? "gappy" : ""}`}
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
        data: { box: b, dir, selected: b.id === selected },
        width: p.width,
        height: p.height,
        ariaLabel: `${b.kind} ${b.label}${b.gaps.length ? `, ${WORDS.gapsOn(b.gaps.length)}` : ""}`,
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
  height?: number;
}) {
  const [state, setState] = useState<LayoutState>(
    p.initial ? { state: "ready" } : { state: "running" },
  );
  const [first] = useState(() =>
    p.initial ? flowElements(p.graph, p.initial, p.direction, p.selected) : undefined,
  );
  const [nodes, setNodes] = useState<BoxNode[]>(first?.nodes ?? []);
  const [edges, setEdges] = useState<LinkEdge[]>(first?.edges ?? []);
  const rf = useRef<ReactFlowInstance<BoxNode, LinkEdge> | undefined>(undefined);
  const pinned = useRef(p.pinned);
  pinned.current = p.pinned;
  const latest = useRef(p);
  latest.current = p;

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
        const el = flowElements(graph, laid, direction, latest.current.selected);
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
        return box === n.data.box && selected === n.data.selected
          ? n
          : { ...n, data: { ...n.data, box, selected } };
      }),
    );
  }, [p.graph, p.selected]);

  const onNodesChange = useCallback(
    (changes: NodeChange<BoxNode>[]) => setNodes((ns) => applyNodeChanges(changes, ns)),
    [],
  );

  if (state.state === "failed")
    return (
      <div className="state error" role="alert">
        {WORDS.layoutFailed(state.error)}
      </div>
    );
  return (
    <div
      className="arch-canvas"
      style={{ height: p.height ?? 560 }}
      aria-busy={state.state === "running"}
    >
      {state.state === "running" && !nodes.length ? (
        <div className="stack" aria-live="polite">
          <span className="sr">{WORDS.layingOut}</span>
          <div className="skeleton" style={{ width: "70%" }} />
          <div className="skeleton" style={{ width: "50%" }} />
        </div>
      ) : (
        <ReactFlow<BoxNode, LinkEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onInit={(i) => {
            rf.current = i;
          }}
          onNodeClick={(_, n) => p.onSelect(n.id)}
          onSelectionChange={({ nodes: picked }) => {
            if (picked.length === 1 && picked[0]!.id !== p.selected) p.onSelect(picked[0]!.id);
          }}
          onNodeDoubleClick={(_, n) => {
            if (n.data.box.childCount > 0) p.onToggle(n.id);
          }}
          onNodeDragStop={(_, n, dragged) => {
            for (const d of dragged.length ? dragged : [n]) p.onMoved(d.id, d.position);
          }}
          nodesConnectable={false}
          edgesFocusable={false}
          zoomOnDoubleClick={false}
          minZoom={0.1}
          fitView
          fitViewOptions={{ padding: 0.08, minZoom: FIT_MIN_ZOOM }}
          colorMode="dark"
          aria-label={WORDS.canvasLabel}
        >
          <Background gap={24} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable ariaLabel={WORDS.minimap} />
        </ReactFlow>
      )}
    </div>
  );
}
