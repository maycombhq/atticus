import { arrange } from "../../../node_modules/@maycombhq/diagrams/dist/layout-score.js";
import { absolute } from "./elk-graph.js";
import type { LayoutResult, PlacedBox, Point } from "./types.js";

const PAD = 16;

/**
 * A kept arrangement over a fresh layout (ADR 0081): every pinned box stays where the person put
 * it, relative to its group; the rest keep the layout's place unless that lands on a pinned box,
 * when `arrange` moves them clear. Each group grows to hold what is inside, deepest first, so the
 * level above arranges against its real size. A route whose ends moved is dropped: the canvas
 * draws that edge itself. Pins for boxes the view no longer has are ignored.
 */
export function applyPinned(result: LayoutResult, pinned: Record<string, Point>): LayoutResult {
  const live = Object.keys(pinned).filter((id) => result.boxes[id]);
  if (!live.length) return result;
  const before = new Map(
    Object.keys(result.boxes).map((id) => [id, absolute(result.boxes, id)] as const),
  );
  const boxes: Record<string, PlacedBox> = {};
  for (const [id, b] of Object.entries(result.boxes)) boxes[id] = { ...b };

  const depth = (id: string | undefined): number => (id ? 1 + depth(boxes[id]?.parent) : 0);
  const containers = [
    ...Object.values(boxes)
      .filter((b) => b.group)
      .map((b) => b.id)
      .sort((a, b) => depth(b) - depth(a) || (a < b ? -1 : 1)),
    undefined,
  ];
  for (const c of containers) {
    const kids = Object.values(boxes)
      .filter((b) => b.parent === c)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const pins: Record<string, Point> = {};
    for (const k of kids) if (pinned[k.id]) pins[k.id] = pinned[k.id]!;
    const placed = arrange(
      kids.map((k) => ({ id: k.id, x: k.x, y: k.y, width: k.width, height: k.height })),
      pins,
    );
    for (const k of kids) Object.assign(boxes[k.id]!, placed[k.id]);
    if (c && kids.length) {
      const g = boxes[c]!;
      g.width = Math.max(g.width, ...kids.map((k) => boxes[k.id]!.x + k.width + PAD));
      g.height = Math.max(g.height, ...kids.map((k) => boxes[k.id]!.y + k.height + PAD));
    }
  }

  const moved = new Set(
    Object.keys(boxes).filter((id) => {
      const a = before.get(id)!;
      const b = absolute(boxes, id);
      const o = result.boxes[id]!;
      const n = boxes[id]!;
      return [a.x - b.x, a.y - b.y, o.width - n.width, o.height - n.height].some(
        (d) => Math.abs(d) > 0.5,
      );
    }),
  );
  const routes: LayoutResult["routes"] = {};
  for (const [id, r] of Object.entries(result.routes))
    if (!moved.has(r.from) && !moved.has(r.to)) routes[id] = r;
  return { boxes, routes, dropped: result.dropped };
}
