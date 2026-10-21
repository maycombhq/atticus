import {
  overLimits,
  scoreLayout,
  type LaidOut,
  type LayoutScore,
} from "../../../node_modules/@maycombhq/diagrams/dist/layout-score.js";
import type { ElkNode } from "elkjs/lib/elk-api.js";
import { absolute, fromElk, toElk } from "./elk-graph.js";
import { applyPinned } from "./pinned.js";
import type {
  LayoutEdge,
  LayoutEngine,
  LayoutGroup,
  LayoutNode,
  LayoutOptions,
  LayoutResult,
} from "./types.js";

export type * from "./types.js";
export { absolute } from "./elk-graph.js";
export type { LayoutScore } from "../../../node_modules/@maycombhq/diagrams/dist/layout-score.js";

/** Anything that lays out an ELK graph: ELK in a worker in the app, ELK in-process in tests. */
export interface ElkLike {
  layout(graph: ElkNode): Promise<ElkNode>;
}

/** The ELK engine over any ELK instance. */
export function elkEngine(elk: ElkLike): LayoutEngine {
  return {
    name: "elk",
    async layout(input, direction) {
      const { graph, dropped } = toElk(input, direction);
      return fromElk(await elk.layout(graph), input, dropped);
    },
  };
}

let shared: Promise<LayoutEngine> | undefined;

/**
 * The app's engine: ELK's own worker script (elk-worker.min.js, loaded by Vite as a file) runs
 * the layout off the main thread; elk-api is the small front that talks to it.
 */
export function workerEngine(): Promise<LayoutEngine> {
  shared ??= Promise.all([
    import("elkjs/lib/elk-api.js"),
    import("elkjs/lib/elk-worker.min.js?url"),
  ]).then(([api, url]) => elkEngine(new api.default({ workerUrl: url.default })));
  return shared;
}

/** The laid-out graph in canvas coordinates, as the layout score reads it. */
export function laidOut(r: LayoutResult, edges: LayoutEdge[]): LaidOut {
  const centre = (id: string) => {
    const p = absolute(r.boxes, id);
    const b = r.boxes[id]!;
    return { x: p.x + b.width / 2, y: p.y + b.height / 2 };
  };
  return {
    nodes: Object.values(r.boxes).map((b) => ({
      id: b.id,
      ...absolute(r.boxes, b.id),
      width: b.width,
      height: b.height,
      ...(b.parent ? { parent: b.parent } : {}),
    })),
    edges: edges
      .filter((e) => r.boxes[e.from] && r.boxes[e.to] && e.from !== e.to)
      .map((e) => ({ id: e.id, points: r.routes[e.id]?.points ?? [centre(e.from), centre(e.to)] })),
  };
}

export interface Laid extends LayoutResult {
  score: LayoutScore;
  /** Which of the spike's limits the view is over (ADR 0081, `LAYOUT_LIMITS`). */
  over: ReturnType<typeof overLimits>;
}

/**
 * Lay out a view: the engine places everything, then kept boxes go back where they were kept and
 * the rest move clear of them, then the result is scored against the spike's limits.
 */
export async function layoutGraph(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  groups: LayoutGroup[],
  options: LayoutOptions,
  engine?: LayoutEngine,
): Promise<Laid> {
  const e = engine ?? (await workerEngine());
  const raw = await e.layout({ nodes, edges, groups }, options.direction);
  const r = applyPinned(raw, options.pinned ?? {});
  const score = scoreLayout(laidOut(r, edges));
  return { ...r, score, over: overLimits(score, "detailed") };
}
