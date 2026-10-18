import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { parseXml, type XmlElement } from "@maycombhq/extractors";
import type { CatalogRecord } from "@maycombhq/core";
import type { Ingestor } from "@maycombhq/sdk";

export type Legend = "new" | "modify" | "retire";

export interface DiagramNode {
  cell: string;
  label: string;
  page: string;
  line: number;
  legend?: Legend;
  style: Record<string, string>;
}

export interface DiagramEdge {
  cell: string;
  /** Labels of the boxes at each end. */
  from: string;
  to: string;
  /** The edge's text, tags removed. */
  label: string;
  /** A pattern code at the start of the label, e.g. S.GW.SOR. */
  pattern?: string;
  method?: string;
  path?: string;
  /** For an event edge: the topic named in the label. */
  topic?: string;
  legend?: Legend;
  page: string;
  line: number;
}

export interface Diagram {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  problems: { cell: string; message: string }[];
}

export interface LegendWords {
  new: string[];
  modify: string[];
  retire: string[];
}

const DEFAULT_LEGEND: LegendWords = { new: ["New"], modify: ["Modify"], retire: ["Retire"] };
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const PATTERN = /^[A-Z][A-Z0-9]*(\.[A-Z0-9]+)+$/;

const ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Text of a draw.io label: HTML tags become spaces, entities are decoded, space is collapsed. */
export function labelText(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e.startsWith("#x")) return String.fromCodePoint(parseInt(e.slice(2), 16));
      if (e.startsWith("#")) return String.fromCodePoint(parseInt(e.slice(1), 10));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, " ")
    .trim();
}

function parseStyle(style: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (style ?? "").split(";")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq < 0) out[part] = "1";
    else out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

/** A legend marker in the style (legend=new) or in brackets in the text ("[New]", "(Changed)"). */
function legendOf(
  style: Record<string, string>,
  text: string,
  words: LegendWords,
): { legend?: Legend; text: string } {
  const fromStyle = style.legend?.toLowerCase();
  let legend =
    fromStyle === "new" || fromStyle === "modify" || fromStyle === "retire"
      ? (fromStyle as Legend)
      : undefined;
  let rest = text;
  for (const k of ["new", "modify", "retire"] as const) {
    for (const w of words[k]) {
      const re = new RegExp(
        `\\s*[[(]\\s*${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[\\])]\\s*`,
        "i",
      );
      if (re.test(rest)) {
        legend ??= k;
        rest = rest.replace(re, " ").trim();
      }
    }
  }
  return { ...(legend ? { legend } : {}), text: rest };
}

/** The graph models in a draw.io file, one per page, inflating compressed pages. */
function pages(doc: XmlElement): { name: string; model: XmlElement }[] {
  if (doc.name === "mxGraphModel") return [{ name: "", model: doc }];
  if (doc.name !== "mxfile") return [];
  const out: { name: string; model: XmlElement }[] = [];
  for (const d of doc.children.filter((c) => c.name === "diagram")) {
    const name = d.attrs.name ?? d.attrs.id ?? "";
    let model = d.children.find((c) => c.name === "mxGraphModel");
    if (!model && d.text.trim()) {
      const xml = decodeURIComponent(
        inflateRawSync(Buffer.from(d.text.trim(), "base64")).toString("utf8"),
      );
      const parsed = parseXml(xml);
      if (parsed?.name === "mxGraphModel") model = parsed;
    }
    if (model) out.push({ name, model });
  }
  return out;
}

interface Cell {
  id: string;
  value: string;
  parent?: string;
  source?: string;
  target?: string;
  vertex: boolean;
  edge: boolean;
  style: Record<string, string>;
  line: number;
}

function cells(model: XmlElement): Cell[] {
  const root = model.children.find((c) => c.name === "root");
  const out: Cell[] = [];
  for (const el of root?.children ?? []) {
    // <object>/<UserObject> wrap an mxCell and carry the id and label.
    const cell = el.name === "mxCell" ? el : el.children.find((c) => c.name === "mxCell");
    if (!cell) continue;
    const id = el.attrs.id ?? cell.attrs.id;
    if (!id) continue;
    out.push({
      id,
      value:
        el.name === "mxCell" ? (cell.attrs.value ?? "") : (el.attrs.label ?? el.attrs.value ?? ""),
      ...(cell.attrs.parent ? { parent: cell.attrs.parent } : {}),
      ...(cell.attrs.source ? { source: cell.attrs.source } : {}),
      ...(cell.attrs.target ? { target: cell.attrs.target } : {}),
      vertex: cell.attrs.vertex === "1",
      edge: cell.attrs.edge === "1",
      style: parseStyle(cell.attrs.style),
      line: el.line,
    });
  }
  return out;
}

/** Split an edge label into pattern code, then METHOD /path, or a topic. */
function edgeParts(text: string): Pick<DiagramEdge, "pattern" | "method" | "path" | "topic"> {
  const toks = text.split(" ").filter(Boolean);
  const out: Pick<DiagramEdge, "pattern" | "method" | "path" | "topic"> = {};
  if (toks[0] && PATTERN.test(toks[0])) out.pattern = toks.shift()!;
  if (toks[0] && METHODS.has(toks[0].toUpperCase()) && toks[1]) {
    out.method = toks[0].toUpperCase();
    out.path = toks[1];
  } else if (toks.length === 1 && /^[A-Za-z0-9][\w.-]*$/.test(toks[0]!)) out.topic = toks[0];
  return out;
}

/**
 * Read a draw.io file: boxes with their labels and legend, and edges between the labelled
 * boxes they connect (an edge attached to a shape inside a box belongs to the box). Reads
 * files only; never fetches anything a diagram links to.
 */
export function readDrawio(xml: string, legendWords: LegendWords = DEFAULT_LEGEND): Diagram {
  const doc = parseXml(xml);
  const diagram: Diagram = { nodes: [], edges: [], problems: [] };
  if (!doc) return diagram;
  for (const { name: page, model } of pages(doc)) {
    const all = cells(model);
    const byId = new Map(all.map((c) => [c.id, c]));
    const nodeOf = new Map<string, DiagramNode>();
    for (const c of all) {
      if (!c.vertex || c.style.edgeLabel !== undefined || byId.get(c.parent ?? "")?.edge) continue;
      const { legend, text } = legendOf(c.style, labelText(c.value), legendWords);
      if (!text) continue;
      const n: DiagramNode = {
        cell: c.id,
        label: text,
        page,
        line: c.line,
        ...(legend ? { legend } : {}),
        style: c.style,
      };
      diagram.nodes.push(n);
      nodeOf.set(c.id, n);
    }
    /** The labelled box a cell belongs to: itself or its nearest labelled ancestor. */
    const boxOf = (id: string | undefined): DiagramNode | undefined => {
      for (
        let cur = id ? byId.get(id) : undefined, hops = 0;
        cur && hops < 50;
        cur = cur.parent ? byId.get(cur.parent) : undefined, hops++
      ) {
        const n = nodeOf.get(cur.id);
        if (n && !n.style.group) return n;
      }
      return undefined;
    };
    for (const c of all.filter((x) => x.edge)) {
      const childText = all
        .filter((x) => x.parent === c.id && x.vertex)
        .map((x) => labelText(x.value))
        .filter(Boolean);
      const raw = [labelText(c.value), ...childText].filter(Boolean).join(" ");
      const { legend, text } = legendOf(c.style, raw, legendWords);
      const from = boxOf(c.source);
      const to = boxOf(c.target);
      if (!from || !to) {
        diagram.problems.push({
          cell: c.id,
          message:
            !from && !to
              ? "edge connects no boxes"
              : !from
                ? "edge has no source box"
                : "edge has no target box",
        });
        continue;
      }
      diagram.edges.push({
        cell: c.id,
        from: from.label,
        to: to.label,
        label: text,
        ...edgeParts(text),
        ...(legend ? { legend } : {}),
        page,
        line: c.line,
      });
    }
  }
  return diagram;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** The ingestor (C4): a draw.io file becomes a SourceDocument; reconcile reads its content. */
export const drawioIngestor: Ingestor = {
  id: "drawio",
  version: "0.1.0",
  sniff(fileName, head) {
    if (/\.drawio(\.xml)?$/i.test(fileName)) return 1;
    return /^\s*(<\?xml[^>]*>\s*)?<mxfile/.test(new TextDecoder().decode(head.slice(0, 200)))
      ? 0.9
      : 0;
  },
  async *ingest(fileName, content) {
    const base = fileName
      .split(/[\\/]/)
      .pop()!
      .replace(/\.drawio(\.xml)?$/i, "")
      .replace(/\.xml$/i, "");
    const record = {
      schemaVersion: 1,
      kind: "SourceDocument",
      id: `doc.${slug(base)}`,
      status: "current",
      confidence: "verified",
      path: fileName,
      docType: "diagram",
      hash: createHash("sha256").update(content).digest("hex"),
      recordsProduced: [],
      evidence: [{ source: "diagram", path: fileName }],
    };
    yield record as unknown as CatalogRecord;
  },
};
