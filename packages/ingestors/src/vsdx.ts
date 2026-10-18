import type { Diagram, DiagramNode, Legend, LegendWords } from "@maycombhq/reconcile";
import { DEFAULT_LEGEND, edgeParts, legendOf, legendWord, squash } from "./labels.js";
import {
  child,
  childrenNamed,
  findAll,
  parseXmlTree,
  relId,
  relationships,
  resolvePart,
  type XNode,
} from "./xml.js";
import { readZip, type ZipLimits } from "./zip.js";

/*
 * Visio .vsdx: a ZIP of XML parts. Pages are listed in visio/pages/pages.xml (names, and a
 * relationship to each page part); each page holds shapes (text, master, shape data) and
 * Connects that glue connector ends to shapes. A connector is any shape glued by its BeginX or
 * EndX, or a one-dimensional shape (it has BeginX/EndX cells) left unglued.
 *
 * Cells are "<page ID>.<shape ID>" because Visio numbers shapes per page.
 */

interface Shape {
  el: XNode;
  id: string;
  parent?: Shape;
  children: Shape[];
  text: string;
  master?: string;
  group: boolean;
  oneD: boolean;
  legend?: Legend;
  cells: Record<string, string>;
}

/** Text of a <Text> element: character runs, fields and line breaks, whitespace collapsed. */
function shapeText(el: XNode): string {
  const t = child(el, "Text");
  if (!t) return "";
  const walk = (n: XNode): string =>
    n.children.map((c) => (typeof c === "string" ? c : walk(c))).join("");
  return squash(walk(t));
}

/** A legend from shape data: a row named Legend or labelled Legend. */
function dataLegend(el: XNode, words: LegendWords): Legend | undefined {
  for (const section of childrenNamed(el, "Section")) {
    if (section.attrs.N !== "Property") continue;
    for (const row of childrenNamed(section, "Row")) {
      const cells = new Map(childrenNamed(row, "Cell").map((c) => [c.attrs.N, c]));
      const label = cells.get("Label")?.attrs.V;
      if (row.attrs.N?.toLowerCase() !== "legend" && label?.toLowerCase() !== "legend") continue;
      const value = cells.get("Value");
      const v = value?.attrs.V ?? (value ? squash(value.children.join(" ")) : undefined);
      const legend = legendWord(v, words);
      if (legend) return legend;
    }
  }
  return undefined;
}

function shapesOf(
  container: XNode | undefined,
  parent: Shape | undefined,
  masters: Map<string, string>,
  words: LegendWords,
  out: Shape[],
): Shape[] {
  const list: Shape[] = [];
  for (const el of childrenNamed(child(container, "Shapes"), "Shape")) {
    const cells: Record<string, string> = {};
    for (const c of childrenNamed(el, "Cell"))
      if (c.attrs.N && c.attrs.V !== undefined) cells[c.attrs.N] = c.attrs.V;
    const masterName = el.attrs.Master ? masters.get(el.attrs.Master) : undefined;
    const s: Shape = {
      el,
      id: el.attrs.ID ?? "",
      ...(parent ? { parent } : {}),
      children: [],
      text: shapeText(el),
      ...(masterName ? { master: masterName } : {}),
      group: el.attrs.Type === "Group",
      oneD: "BeginX" in cells || "EndX" in cells,
      ...((): { legend?: Legend } => {
        const l = dataLegend(el, words);
        return l ? { legend: l } : {};
      })(),
      cells,
    };
    out.push(s);
    list.push(s);
    s.children = shapesOf(el, s, masters, words, out);
  }
  return list;
}

export function readVsdx(
  bytes: Uint8Array,
  legendWords: LegendWords = DEFAULT_LEGEND,
  limits: Partial<ZipLimits> = {},
): Diagram {
  const zip = readZip(bytes, limits);
  const diagram: Diagram = { nodes: [], edges: [], problems: [] };

  const masters = new Map<string, string>();
  for (const m of findAll(parseXmlTree(zip.text("visio/masters/masters.xml") ?? ""), "Master"))
    if (m.attrs.ID) masters.set(m.attrs.ID, m.attrs.NameU ?? m.attrs.Name ?? "");

  // Pages in the order pages.xml lists them; any page part it doesn't name follows by number.
  const rels = relationships(zip.text("visio/pages/_rels/pages.xml.rels"));
  const listed: { id: string; name: string; part: string }[] = [];
  childrenNamed(parseXmlTree(zip.text("visio/pages/pages.xml") ?? ""), "Page").forEach((p, i) => {
    const rel = child(p, "Rel");
    const rid = rel ? relId(rel) : undefined;
    const target = rid ? rels.get(rid) : undefined;
    if (!target) return;
    listed.push({
      id: p.attrs.ID ?? String(i),
      name: p.attrs.Name ?? p.attrs.NameU ?? "",
      part: resolvePart("visio/pages", target),
    });
  });
  const pageNo = (n: string) => Number(/page(\d+)\.xml$/.exec(n)?.[1] ?? 0);
  for (const part of zip.names
    .filter((n) => /^visio\/pages\/page\d+\.xml$/.test(n))
    .sort((a, b) => pageNo(a) - pageNo(b)))
    if (!listed.some((l) => l.part === part))
      listed.push({ id: String(pageNo(part)), name: "", part });

  const pages = listed.filter((p) => zip.has(p.part));
  if (!pages.length) {
    diagram.problems.push({ cell: "", message: "no pages found in the Visio file" });
    return diagram;
  }

  for (const page of pages) {
    const doc = parseXmlTree(zip.text(page.part) ?? "");
    const all: Shape[] = [];
    shapesOf(doc, undefined, masters, legendWords, all);
    const byId = new Map(all.map((s) => [s.id, s]));
    const ends = new Map<string, { begin?: string; end?: string }>();
    for (const c of findAll(child(doc, "Connects"), "Connect")) {
      const from = c.attrs.FromSheet;
      const to = c.attrs.ToSheet;
      if (!from || !to) continue;
      const e = ends.get(from) ?? {};
      if (c.attrs.FromCell === "BeginX") e.begin = to;
      else if (c.attrs.FromCell === "EndX") e.end = to;
      else continue;
      ends.set(from, e);
    }
    const isConnector = (s: Shape) => ends.has(s.id) || s.oneD;
    const cell = (s: Shape) => `${page.id}.${s.id}`;

    const nodeOf = new Map<Shape, DiagramNode>();
    for (const s of all) {
      if (isConnector(s)) continue;
      const { legend, text } = legendOf(s.legend, s.text, legendWords);
      if (!text) continue;
      const style: Record<string, string> = {};
      if (s.master) style.master = s.master;
      if (s.cells.PinX !== undefined) style.x = s.cells.PinX;
      if (s.cells.PinY !== undefined) style.y = s.cells.PinY;
      if (s.group) style.group = "1";
      const n: DiagramNode = {
        cell: cell(s),
        label: text,
        page: page.name,
        line: s.el.line,
        ...(legend ? { legend } : {}),
        style,
      };
      diagram.nodes.push(n);
      nodeOf.set(s, n);
    }

    /**
     * The labelled box a glued shape belongs to: itself or its nearest labelled ancestor (an
     * icon inside a labelled group), else the one labelled shape inside it (a group whose
     * label sits on a child). Visio groups bind a box's parts, so unlike draw.io containers
     * a labelled group is a box.
     */
    const boxOf = (id: string | undefined): DiagramNode | undefined => {
      const start = id ? byId.get(id) : undefined;
      for (let cur = start; cur; cur = cur.parent) {
        const n = nodeOf.get(cur);
        if (n) return n;
      }
      if (!start) return undefined;
      const inside: DiagramNode[] = [];
      const walk = (s: Shape) =>
        s.children.forEach((c) => {
          const n = nodeOf.get(c);
          if (n) inside.push(n);
          else walk(c);
        });
      walk(start);
      return inside.length === 1 ? inside[0] : undefined;
    };

    for (const s of all.filter(isConnector)) {
      const e = ends.get(s.id) ?? {};
      const from = boxOf(e.begin);
      const to = boxOf(e.end);
      if (!from || !to) {
        diagram.problems.push({
          cell: cell(s),
          message:
            !from && !to
              ? "edge connects no boxes"
              : !from
                ? "edge has no source box"
                : "edge has no target box",
        });
        continue;
      }
      const { legend, text } = legendOf(s.legend, s.text, legendWords);
      diagram.edges.push({
        cell: cell(s),
        from: from.label,
        to: to.label,
        label: text,
        ...edgeParts(text),
        ...(legend ? { legend } : {}),
        page: page.name,
        line: s.el.line,
      });
    }
  }
  return diagram;
}
