import type { CanvasBox, CanvasGraph, CanvasLink } from "./model.js";

/**
 * G6 (ADR 0175): the canvas's tools, worked out from the picture already loaded, so none of them
 * asks the model anything or changes a fact. Layers and filters choose what is drawn; blast
 * radius and trace walk the links; the inbox lists what has gaps; compare marks what changed
 * since a snapshot; the exporters write the picture as Mermaid, draw.io or SVG. Pure.
 */

export const LAYERS = [
  "verified",
  "guessed",
  "declared",
  "paired",
  // ADR 0181: links the AI paired, "Detected by AI".
  "ai",
  "outside",
  "topics",
] as const;
export type Layer = (typeof LAYERS)[number];
export type Layers = Record<Layer, boolean>;
export const ALL_LAYERS: Layers = {
  verified: true,
  guessed: true,
  declared: true,
  paired: true,
  // On by default, so what the AI decided is seen.
  ai: true,
  outside: true,
  topics: true,
};

/** The layers a link is on (the others choose boxes). */
const LINK_LAYERS = ["verified", "guessed", "declared", "paired", "ai"] as const;

/**
 * Which layer a link is on: a person's word, the AI's, a guess or gap, or read and cited. The AI's
 * comes before the guesses: an AI pairing is inferred, but it is shown as the AI's.
 */
export function layerOf(l: CanvasLink): "declared" | "paired" | "ai" | "guessed" | "verified" {
  if (l.declared) return "declared";
  if (l.paired) return "paired";
  if (l.ai) return "ai";
  // A contract finding is about the payload, not about where the call goes.
  return l.gaps.some((g) => !g.startsWith("contract-")) ? "guessed" : "verified";
}

/** Only links detected by AI: the AI's layer on, every other link layer off. */
export const isOnlyAi = (on: Layers): boolean =>
  on.ai && LINK_LAYERS.every((l) => l === "ai" || !on[l]);

/**
 * ADR 0181: show only the links the AI detected, or, when that is what is shown, every link layer
 * again. Boxes (outside systems, topics) stay as they were. Kept views save it as their layers.
 */
export function onlyAi(on: Layers): Layers {
  const only = !isOnlyAi(on);
  const out = { ...on };
  for (const l of LINK_LAYERS) out[l] = only ? l === "ai" : true;
  return out;
}

/** The picture with only the layers asked for; with `mismatches`, only links the check marks. */
export function withLayers(
  g: CanvasGraph,
  on: Layers,
  o: { mismatches?: ReadonlySet<string> } = {},
): CanvasGraph {
  const boxes = g.boxes.filter(
    (b) => (on.outside || !b.outside || b.group) && (on.topics || b.kind !== "topic"),
  );
  const keep = new Set(boxes.map((b) => b.id));
  const links = g.links.filter(
    (l) =>
      keep.has(l.from) &&
      keep.has(l.to) &&
      on[layerOf(l)] &&
      (!o.mismatches || o.mismatches.has(l.id)),
  );
  return { ...g, boxes, links };
}

/**
 * The words a filter takes: `team:<id>`, `system:<id>`, `type:<repo type>`, `path:/prefix/**`,
 * and plain words a box's label or properties must have. Every term must hold.
 */
export interface FilterTerm {
  key?: "team" | "system" | "type" | "path";
  value: string;
}

export function parseFilter(q: string): FilterTerm[] {
  return q
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => {
      const m = /^(team|system|type|path):(.+)$/i.exec(w);
      return m
        ? { key: m[1]!.toLowerCase() as FilterTerm["key"] & string, value: m[2]!.toLowerCase() }
        : { value: w.toLowerCase() };
    });
}

type Props = Record<string, string | number | boolean | string[]>;

/** Whether a box matches every term, from its label, kind and properties. */
export function boxMatches(b: CanvasBox, props: Props | undefined, terms: FilterTerm[]): boolean {
  const val = (k: string) => {
    const v = props?.[k];
    return (Array.isArray(v) ? v.join(" ") : v === undefined ? "" : String(v)).toLowerCase();
  };
  return terms.every((t) => {
    switch (t.key) {
      case "team":
        return val("owner").includes(t.value) || val("team").includes(t.value);
      case "system":
        return (
          val("system").includes(t.value) ||
          (b.kind === "system" && b.label.toLowerCase().includes(t.value))
        );
      case "type":
        return val("type").includes(t.value);
      case "path": {
        const prefix = t.value.replace(/\/\*\*$/, "").replace(/\*+$/, "");
        return (
          Object.values(props ?? {}).some((v) =>
            (Array.isArray(v) ? v : [String(v)]).some((x) => x.toLowerCase().startsWith(prefix)),
          ) || b.label.toLowerCase().startsWith(prefix)
        );
      }
      default:
        return (
          b.label.toLowerCase().includes(t.value) ||
          b.kind.toLowerCase() === t.value ||
          Object.values(props ?? {}).some((v) => String(v).toLowerCase().includes(t.value))
        );
    }
  });
}

/** The boxes a filter keeps, and what they link to (one step), with the links among them. */
export function withFilter(
  g: CanvasGraph,
  q: string,
  propsOf: (id: string) => Props | undefined,
): CanvasGraph {
  const terms = parseFilter(q);
  if (!terms.length) return g;
  const hit = new Set(
    g.boxes.filter((b) => !b.group && boxMatches(b, propsOf(b.id), terms)).map((b) => b.id),
  );
  const keep = new Set(hit);
  for (const l of g.links) {
    if (hit.has(l.from)) keep.add(l.to);
    if (hit.has(l.to)) keep.add(l.from);
  }
  // A group stays when anything inside it stays.
  for (const b of g.boxes) if (b.parent && keep.has(b.id)) keep.add(b.parent);
  return {
    ...g,
    boxes: g.boxes.filter((b) => keep.has(b.id)),
    links: g.links.filter((l) => keep.has(l.from) && keep.has(l.to)),
  };
}

export type Direction = "up" | "down" | "both";

/** Every box within `depth` links of `id`, upstream (what calls it), downstream or both, with its depth. */
export function blastRadius(
  links: readonly Pick<CanvasLink, "from" | "to">[],
  id: string,
  depth: number,
  dir: Direction,
): Map<string, number> {
  const out = new Map<string, number>([[id, 0]]);
  let front = [id];
  for (let d = 1; d <= depth && front.length; d++) {
    const next: string[] = [];
    for (const n of front)
      for (const l of links) {
        const to =
          (dir !== "up" && l.from === n ? l.to : undefined) ??
          (dir !== "down" && l.to === n ? l.from : undefined);
        if (to && !out.has(to)) {
          out.set(to, d);
          next.push(to);
        }
      }
    front = next;
  }
  return out;
}

/** A request's path from a box, hop by hop: each step's links, in order, as far as they go. */
export function trace(
  links: readonly CanvasLink[],
  id: string,
  max = 8,
): { depth: number; link: CanvasLink }[] {
  const out: { depth: number; link: CanvasLink }[] = [];
  const seen = new Set([id]);
  let front = [id];
  for (let d = 1; d <= max && front.length; d++) {
    const next: string[] = [];
    for (const n of front)
      for (const l of links.filter((x) => x.from === n).sort((a, b) => (a.to < b.to ? -1 : 1))) {
        out.push({ depth: d, link: l });
        if (!seen.has(l.to)) {
          seen.add(l.to);
          next.push(l.to);
        }
      }
    front = next;
  }
  return out;
}

/** What the picture has open: boxes and links with gaps, most first. */
export function inbox(
  g: CanvasGraph,
): { id: string; what: "box" | "link"; label: string; gaps: string[] }[] {
  const label = new Map(g.boxes.map((b) => [b.id, b.label]));
  return [
    ...g.boxes
      .filter((b) => b.gaps.length)
      .map((b) => ({ id: b.id, what: "box" as const, label: b.label, gaps: b.gaps })),
    ...g.links
      .filter((l) => l.gaps.length)
      .map((l) => ({
        id: l.from,
        what: "link" as const,
        label: `${label.get(l.from) ?? l.from} → ${label.get(l.to) ?? l.to}`,
        gaps: l.gaps,
      })),
  ].sort((a, b) => b.gaps.length - a.gaps.length || (a.label < b.label ? -1 : 1));
}

/** A snapshot of the links drawn, to compare with later. */
export interface Snapshot {
  at: string;
  links: { id: string; from: string; to: string; label: string }[];
}

export const snapshotOf = (g: CanvasGraph, at: string): Snapshot => ({
  at,
  links: g.links.map((l) => ({ id: l.id, from: l.from, to: l.to, label: l.label })),
});

/** The links added since a snapshot (marked new on the picture) and those gone. */
export function compare(
  before: Snapshot,
  g: CanvasGraph,
): { added: CanvasLink[]; removed: Snapshot["links"] } {
  const was = new Set(before.links.map((l) => l.id));
  const now = new Set(g.links.map((l) => l.id));
  return {
    added: g.links.filter((l) => !was.has(l.id)),
    removed: before.links.filter((l) => !now.has(l.id)),
  };
}

const mid = (id: string) => `n_${id.replace(/[^A-Za-z0-9_]/g, "_")}`;
const quote = (s: string) => s.replace(/"/g, "#quot;");

/**
 * How an exported link is stroked: a person's word dashed, the AI's (ADR 0181) dotted, so the two
 * differ in shape; each also says so in its label (◆ and the words), never by colour alone.
 */
const strokeOf = (l: CanvasLink): "ai" | "word" | undefined =>
  l.declared || l.paired ? "word" : l.ai ? "ai" : undefined;

/** The picture as a Mermaid flowchart, labels intact; a person's word and the AI's drawn dotted. */
export function toMermaid(g: CanvasGraph, dir: "LR" | "TB" = "LR"): string {
  const lines = [`flowchart ${dir}`];
  for (const b of g.boxes.filter((x) => !x.group))
    lines.push(`  ${mid(b.id)}["${quote(`${b.label}`)}"]`);
  for (const l of g.links) {
    // Mermaid has one dotted arrow: the label tells the AI's (◆) from a person's word.
    const arrow = strokeOf(l) ? "-.->" : "-->";
    lines.push(`  ${mid(l.from)} ${arrow}|"${quote(l.label)}"| ${mid(l.to)}`);
  }
  return lines.join("\n") + "\n";
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface Placed {
  x: number;
  y: number;
  width: number;
  height: number;
}

const DRAWIO_STROKE = { word: "dashed=1;", ai: "dashed=1;dashPattern=1 4;", none: "" } as const;
const SVG_STROKE = {
  word: ' stroke-dasharray="6 4"',
  ai: ' stroke-dasharray="1 4" stroke-linecap="round"',
  none: "",
} as const;

/** The picture as a draw.io file: each box where the layout put it, each link with its label. */
export function toDrawio(g: CanvasGraph, at: (id: string) => Placed | undefined): string {
  const cells: string[] = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>'];
  for (const b of g.boxes.filter((x) => !x.group)) {
    const p = at(b.id) ?? { x: 0, y: 0, width: 160, height: 60 };
    cells.push(
      `<mxCell id="${esc(mid(b.id))}" value="${esc(b.label)}" style="rounded=1;whiteSpace=wrap;${b.outside ? "dashed=1;" : ""}" vertex="1" parent="1"><mxGeometry x="${Math.round(p.x)}" y="${Math.round(p.y)}" width="${Math.round(p.width)}" height="${Math.round(p.height)}" as="geometry"/></mxCell>`,
    );
  }
  g.links.forEach((l, i) =>
    cells.push(
      `<mxCell id="e${i}" value="${esc(l.label)}" style="endArrow=block;${DRAWIO_STROKE[strokeOf(l) ?? "none"]}" edge="1" parent="1" source="${esc(mid(l.from))}" target="${esc(mid(l.to))}"><mxGeometry relative="1" as="geometry"/></mxCell>`,
    ),
  );
  return `<mxfile host="atticus"><diagram name="Atticus"><mxGraphModel><root>${cells.join("")}</root></mxGraphModel></diagram></mxfile>\n`;
}

/** The picture as a standalone SVG: boxes, straight links and their labels, readable anywhere. */
export function toSvg(g: CanvasGraph, at: (id: string) => Placed | undefined): string {
  const placed = g.boxes
    .filter((b) => !b.group)
    .map((b) => ({ b, p: at(b.id) }))
    .filter((x): x is { b: CanvasBox; p: Placed } => !!x.p);
  const by = new Map(placed.map((x) => [x.b.id, x.p]));
  const minX = Math.min(0, ...placed.map((x) => x.p.x)) - 20;
  const minY = Math.min(0, ...placed.map((x) => x.p.y)) - 20;
  const maxX = Math.max(100, ...placed.map((x) => x.p.x + x.p.width)) + 20;
  const maxY = Math.max(100, ...placed.map((x) => x.p.y + x.p.height)) + 20;
  const parts: string[] = [];
  for (const l of g.links) {
    const a = by.get(l.from);
    const b = by.get(l.to);
    if (!a || !b) continue;
    const [x1, y1, x2, y2] = [
      a.x + a.width / 2,
      a.y + a.height / 2,
      b.x + b.width / 2,
      b.y + b.height / 2,
    ];
    parts.push(
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="dimgray" stroke-width="1.5" marker-end="url(#arrow)"${SVG_STROKE[strokeOf(l) ?? "none"]}/>`,
      `<text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 4}" font-size="11" text-anchor="middle" fill="darkslategray">${esc(l.label)}</text>`,
    );
  }
  for (const { b, p } of placed)
    parts.push(
      `<rect x="${p.x}" y="${p.y}" width="${p.width}" height="${p.height}" rx="6" fill="white" stroke="darkslategray"${b.outside ? ' stroke-dasharray="4 3"' : ""}/>`,
      `<text x="${p.x + p.width / 2}" y="${p.y + p.height / 2 + 4}" font-size="12" text-anchor="middle" fill="black">${esc(b.label)}</text>`,
    );
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${maxX - minX} ${maxY - minY}" width="${maxX - minX}" height="${maxY - minY}" font-family="sans-serif">`,
    `<defs><marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="dimgray"/></marker></defs>`,
    `<rect x="${minX}" y="${minY}" width="${maxX - minX}" height="${maxY - minY}" fill="white"/>`,
    ...parts,
    "</svg>",
    "",
  ].join("\n");
}
