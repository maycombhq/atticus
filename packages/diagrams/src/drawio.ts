import { deflateRawSync } from "node:zlib";
import type { Diagram } from "@maycombhq/reconcile";
import {
  viewSlug,
  type FlowView,
  type Legend,
  type ViewEdge,
  type ViewGroup,
  type ViewNode,
} from "./views.js";

type Style = Record<string, string>;

/** Shared with the shape library, so a hand-drawn diagram looks like an exported one. */
const BOX: Style = { rounded: "1", whiteSpace: "wrap", html: "0" };
const BOUNDARY: Record<string, Style> = {
  product: { fillColor: "#dae8fc", strokeColor: "#6c8ebf" },
  internal: { fillColor: "#d5e8d4", strokeColor: "#82b366" },
  vendor: { fillColor: "#f5f5f5", strokeColor: "#666666" },
};
const SHAPES = {
  system: { ...BOX, ...BOUNDARY.product, atticusKind: "system" },
  component: { ...BOX, atticusKind: "component" },
  vendor: {
    shape: "cloud",
    whiteSpace: "wrap",
    html: "0",
    ...BOUNDARY.vendor,
    atticusKind: "vendor",
  },
  datastore: {
    shape: "cylinder3",
    whiteSpace: "wrap",
    html: "0",
    boundedLbl: "1",
    size: "12",
    fillColor: "#fff2cc",
    strokeColor: "#d6b656",
    atticusKind: "datastore",
  },
  topic: {
    shape: "parallelogram",
    perimeter: "parallelogramPerimeter",
    whiteSpace: "wrap",
    html: "0",
    fillColor: "#e1d5e7",
    strokeColor: "#9673a6",
    atticusKind: "topic",
  },
  group: {
    rounded: "0",
    whiteSpace: "wrap",
    html: "0",
    container: "1",
    collapsible: "0",
    dashed: "1",
    fillColor: "none",
    verticalAlign: "top",
    align: "left",
    spacingLeft: "8",
    fontStyle: "1",
    atticusKind: "group",
  },
} satisfies Record<string, Style>;
/** The legend markers reconcile reads (`legend=new|modify|retire`), with a look to match. */
const LEGEND: Record<Legend, Style> = {
  new: { legend: "new", strokeColor: "#2e7d32", strokeWidth: "3", dashed: "1" },
  modify: { legend: "modify", strokeColor: "#ed6c02", strokeWidth: "3" },
  retire: {
    legend: "retire",
    strokeColor: "#b71c1c",
    strokeWidth: "3",
    dashed: "1",
    dashPattern: "2 2",
  },
};
const EDGE: Style = {
  edgeStyle: "orthogonalEdgeStyle",
  rounded: "1",
  html: "0",
  endArrow: "block",
  endFill: "1",
};

const styleText = (...parts: (Style | undefined)[]) =>
  Object.entries(Object.assign({}, ...parts) as Style)
    .map(([k, v]) => `${k}=${v}`)
    .join(";") + ";";

const attr = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\n/g, "&#10;");

function nodeStyle(n: ViewNode): string {
  const legend = n.legend ? LEGEND[n.legend] : undefined;
  if (n.kind === "table") return styleText(SHAPES.datastore, { atticusKind: "table" }, legend);
  if (n.kind === "topic") return styleText(SHAPES.topic, legend);
  if (n.boundary === "vendor")
    return styleText(
      SHAPES.vendor,
      n.kind === "component" ? { atticusKind: "component" } : {},
      legend,
    );
  const base = n.kind === "system" ? SHAPES.system : SHAPES.component;
  return styleText(base, n.boundary ? BOUNDARY[n.boundary] : undefined, legend);
}

function groupStyle(g: ViewGroup): string {
  return styleText(
    SHAPES.group,
    g.kind === "datastore" ? { atticusKind: "datastore-group" } : {},
    g.boundary ? { strokeColor: BOUNDARY[g.boundary]!.strokeColor! } : undefined,
    g.legend ? LEGEND[g.legend] : undefined,
  );
}

/**
 * The text a box carries. Reconcile resolves names by slug, so a system or component whose
 * name doesn't slug to its id is labelled with the id: the round trip then needs no alias.
 */
function boxText(x: { id: string; label: string; kind: string }): string {
  if (x.kind !== "system" && x.kind !== "component") return x.label;
  return viewSlug(x.label) === x.id ? x.label : x.id;
}

const W = 160;
const H = 60;
const GAP = 80;
const PER_ROW = 4;

/**
 * Export a flow view (context or container, also data and event) as an uncompressed draw.io
 * file: groups as containers, edges labelled in the reconcile grammar, planned records with
 * a legend style. Laid out on a simple grid; people rearrange it in draw.io.
 */
export function toDrawio(view: FlowView, o: { page?: string } = {}): string {
  if ((view as { type: string }).type === "sequence")
    throw new Error("A sequence view can't be exported to draw.io: render it as Mermaid.");
  const cells: string[] = [];
  const cellOf = new Map<string, string>();
  const grouped = new Set(view.groups.map((g) => g.id));
  const blocks: { w: number; h: number; emit: (x: number, y: number) => void }[] = [];
  const vertex = (
    id: string,
    value: string,
    style: string,
    parent: string,
    x: number,
    y: number,
    w: number,
    h: number,
  ) =>
    cells.push(
      `        <mxCell id="${attr(id)}" value="${attr(value)}" style="${attr(style)}" vertex="1" parent="${attr(parent)}">\n` +
        `          <mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry"/>\n` +
        `        </mxCell>`,
    );
  for (const g of view.groups) {
    const members = view.nodes.filter((n) => n.group === g.id);
    const gw = W + 40;
    const gh = 40 + members.length * (H + 20);
    blocks.push({
      w: gw,
      h: gh,
      emit: (x, y) => {
        const gcell = `group.${g.id}`;
        vertex(gcell, boxText(g), groupStyle(g), "1", x, y, gw, gh);
        members.forEach((n, i) => {
          const cell = `node.${n.id}`;
          cellOf.set(n.id, cell);
          vertex(cell, boxText(n), nodeStyle(n), gcell, 20, 30 + i * (H + 20), W, H);
        });
      },
    });
  }
  for (const n of view.nodes.filter((x) => x.group === undefined || !grouped.has(x.group)))
    blocks.push({
      w: W,
      h: H,
      emit: (x, y) => {
        const cell = `node.${n.id}`;
        cellOf.set(n.id, cell);
        vertex(cell, boxText(n), nodeStyle(n), "1", x, y, W, H);
      },
    });
  let y = 40;
  for (let r = 0; r < blocks.length; r += PER_ROW) {
    const row = blocks.slice(r, r + PER_ROW);
    let x = 40;
    for (const b of row) {
      b.emit(x, y);
      x += b.w + GAP;
    }
    y += Math.max(...row.map((b) => b.h)) + GAP;
  }
  for (const e of view.edges) {
    const source = cellOf.get(e.from);
    const target = cellOf.get(e.to);
    if (!source || !target) continue;
    cells.push(
      `        <mxCell id="${attr(`edge.${e.id}`)}" value="${attr(e.label)}" style="${attr(edgeStyle(e))}" edge="1" parent="1" source="${attr(source)}" target="${attr(target)}">\n` +
        `          <mxGeometry relative="1" as="geometry"/>\n` +
        `        </mxCell>`,
    );
  }
  return [
    `<mxfile host="atticus">`,
    `  <diagram id="${attr(view.type)}" name="${attr(o.page ?? view.title)}">`,
    `    <mxGraphModel grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="827">`,
    `      <root>`,
    `        <mxCell id="0"/>`,
    `        <mxCell id="1" parent="0"/>`,
    ...cells,
    `      </root>`,
    `    </mxGraphModel>`,
    `  </diagram>`,
    `</mxfile>`,
    ``,
  ].join("\n");
}

function edgeStyle(e: ViewEdge): string {
  return styleText(
    EDGE,
    e.async ? { dashed: "1" } : undefined,
    e.legend
      ? { legend: e.legend, strokeColor: LEGEND[e.legend].strokeColor!, strokeWidth: "2" }
      : undefined,
  );
}

/** draw.io's own compression: deflate-raw of the URI-encoded XML, in base64. */
const compress = (xml: string) =>
  deflateRawSync(Buffer.from(encodeURIComponent(xml), "utf8"), { level: 9 }).toString("base64");

/**
 * A draw.io shape library (File > Open Library) with Atticus's shapes: system, component,
 * vendor, data store and topic, each plain and with the legend styles reconcile reads. Boxes
 * drawn from it come back from `atticus reconcile` with the right legend.
 */
export function shapeLibrary(): string {
  const base: [string, Style, number, number][] = [
    ["System", SHAPES.system, W, H],
    ["Component", SHAPES.component, W, H],
    ["Vendor", SHAPES.vendor, W, H + 20],
    ["Data store", SHAPES.datastore, 120, 80],
    ["Topic", SHAPES.topic, W, H],
  ];
  const entries = base.flatMap(([title, style, w, h]) =>
    ([undefined, "new", "modify", "retire"] as const).map((legend) => {
      const value = attr(title);
      const st = attr(styleText(style, legend ? LEGEND[legend] : undefined));
      const xml =
        `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>` +
        `<mxCell id="2" value="${value}" style="${st}" vertex="1" parent="1">` +
        `<mxGeometry width="${w}" height="${h}" as="geometry"/></mxCell></root></mxGraphModel>`;
      return {
        xml: compress(xml),
        w,
        h,
        aspect: "fixed",
        title: legend ? `${title} (${legend})` : title,
      };
    }),
  );
  return `<mxlibrary>${JSON.stringify(entries)}</mxlibrary>\n`;
}

/**
 * A view of a draw.io diagram as drawn (read with `readDrawio`), so `atticus diagram render`
 * can show any diagram file as Mermaid. Keeps the file's order; ends are matched by label on
 * the same page.
 */
export function viewFromDiagram(diagram: Diagram, source: string): FlowView {
  const multi = new Set(diagram.nodes.map((n) => n.page)).size > 1;
  const key = (page: string, cell: string) => (multi ? `${page}:${cell}` : cell);
  const nodes: ViewNode[] = diagram.nodes.map((n) => ({
    id: key(n.page, n.cell),
    label: n.label,
    kind: "box",
    ...(n.legend ? { legend: n.legend } : {}),
  }));
  const find = (page: string, label: string) =>
    diagram.nodes.find((n) => n.page === page && n.label === label);
  const edges: ViewEdge[] = [];
  for (const e of diagram.edges) {
    const from = find(e.page, e.from);
    const to = find(e.page, e.to);
    if (!from || !to) continue;
    edges.push({
      id: key(e.page, e.cell),
      from: key(from.page, from.cell),
      to: key(to.page, to.cell),
      label: e.label,
      async: e.topic !== undefined,
      ...(e.legend ? { legend: e.legend } : {}),
    });
  }
  return { type: "diagram", title: "Diagram view", source, groups: [], nodes, edges };
}
