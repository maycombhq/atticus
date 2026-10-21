/**
 * The canvas's layout interface (plan 4.6, docs/plan/diagram-spike.md): boxes, groups and edges
 * in; a position for every box and a route for every edge out. Engine-neutral: ELK.js runs it
 * today (in a Web Worker); dagre can stand in behind the same `LayoutEngine` for flat views.
 */

export interface Point {
  x: number;
  y: number;
}

/** A box to place. `parent` is the group it sits in (a node opened in place). */
export interface LayoutNode {
  id: string;
  width: number;
  height: number;
  parent?: string;
}

/** A group around other boxes: a node opened in place. Its size comes from what is inside. */
export interface LayoutGroup {
  id: string;
  parent?: string;
  /** Room for the group's title above its boxes. */
  header?: number;
}

export interface LayoutEdge {
  id: string;
  from: string;
  to: string;
  /** Room the edge's label needs, so the layout keeps it clear. */
  label?: { width: number; height: number };
}

/** RIGHT for flows and calls, DOWN for context (who sits above whom). */
export type Direction = "RIGHT" | "DOWN";

export interface LayoutOptions {
  direction: Direction;
  /** Kept positions (relative to the box's group, or the canvas): these boxes don't move. */
  pinned?: Record<string, Point>;
}

/** A placed box. x and y are its top-left corner relative to its group (React Flow's frame). */
export interface PlacedBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  parent?: string;
  group: boolean;
}

/** An edge's route in canvas coordinates: start, bends, end. */
export interface Route {
  id: string;
  from: string;
  to: string;
  points: Point[];
  /** Where the label's top-left corner goes, when the engine placed it. */
  label?: Point;
}

export interface LayoutResult {
  boxes: Record<string, PlacedBox>;
  /** Only edges whose route still fits their boxes; the canvas draws its own for the rest. */
  routes: Record<string, Route>;
  /** Edges left out: an end isn't a box or group in the input, or both ends are the same. */
  dropped: string[];
}

export interface LayoutInput {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  groups: LayoutGroup[];
}

/** One layout engine (ELK today; dagre as a fallback for flat views) behind one interface. */
export interface LayoutEngine {
  name: string;
  layout(input: LayoutInput, direction: Direction): Promise<LayoutResult>;
}
