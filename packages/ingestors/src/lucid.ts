import { labelText, type Diagram, type DiagramNode, type LegendWords } from "@maycombhq/reconcile";
import { DEFAULT_LEGEND, edgeParts, legendOf, legendWord } from "./labels.js";

/** One CSV record and the line it starts on (quoted fields may span lines). */
export interface CsvRecord {
  line: number;
  cells: string[];
}

/** RFC 4180 CSV: quoted fields with doubled quotes, commas and line breaks inside. */
export function parseCsv(text: string): CsvRecord[] {
  const out: CsvRecord[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let start = 1;
  let any = false;
  const endRecord = () => {
    cells.push(cell);
    if (any || cells.length > 1 || cell !== "") out.push({ line: start, cells });
    cells = [];
    cell = "";
    any = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        if (c === "\n") line++;
        cell += c;
      }
      continue;
    }
    if (c === '"') {
      quoted = true;
      any = true;
    } else if (c === ",") {
      cells.push(cell);
      cell = "";
      any = true;
    } else if (c === "\r" && text[i + 1] === "\n") continue;
    else if (c === "\n" || c === "\r") {
      endRecord();
      line++;
      start = line;
    } else cell += c;
  }
  if (cell !== "" || cells.length || any) endRecord();
  return out;
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Read a Lucidchart CSV export ("Export > CSV of shape data"): one row per document, page,
 * shape and line. Shapes become boxes labelled by their text areas; lines become edges between
 * the boxes named in Line Source and Line Destination, their text read like a draw.io label.
 * A line touching an unlabelled shape (an icon in a container) belongs to the nearest labelled
 * container. A "Legend" column, when a team adds one as shape data, sets the legend.
 */
export function readLucidCsv(text: string, legendWords: LegendWords = DEFAULT_LEGEND): Diagram {
  const diagram: Diagram = { nodes: [], edges: [], problems: [] };
  const rows = parseCsv(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  const header = rows.shift();
  const col = new Map<string, number>();
  header?.cells.forEach((h, i) => col.set(norm(h), i));
  if (!col.has("id")) {
    diagram.problems.push({ cell: "", message: "not a Lucidchart export: no Id column" });
    return diagram;
  }
  const textCols = [...col.entries()]
    .filter(([h]) => /^text area \d+$/.test(h))
    .sort((a, b) => Number(a[0].slice(10)) - Number(b[0].slice(10)))
    .map(([, i]) => i);
  const get = (r: CsvRecord, name: string) => {
    const i = col.get(name);
    return i === undefined ? "" : (r.cells[i] ?? "").trim();
  };
  const textOf = (r: CsvRecord) =>
    labelText(
      textCols
        .map((i) => r.cells[i] ?? "")
        .filter((t) => t.trim())
        .join(" "),
    );

  const pages = new Map<string, string>();
  for (const r of rows) if (norm(get(r, "name")) === "page") pages.set(get(r, "id"), textOf(r));
  const isLine = (r: CsvRecord) =>
    norm(get(r, "name")) === "line" || !!get(r, "line source") || !!get(r, "line destination");

  const byId = new Map(rows.map((r) => [get(r, "id"), r]));
  const nodeOf = new Map<string, DiagramNode>();
  for (const r of rows) {
    const kind = norm(get(r, "name"));
    if (kind === "document" || kind === "page" || isLine(r)) continue;
    const { legend, text: label } = legendOf(
      legendWord(get(r, "legend"), legendWords),
      textOf(r),
      legendWords,
    );
    if (!label) continue;
    const library = get(r, "shape library");
    const n: DiagramNode = {
      cell: get(r, "id"),
      label,
      page: pages.get(get(r, "page id")) ?? "",
      line: r.line,
      ...(legend ? { legend } : {}),
      style: { shape: get(r, "name"), ...(library ? { library } : {}) },
    };
    diagram.nodes.push(n);
    nodeOf.set(n.cell, n);
  }

  /** The labelled box a shape belongs to: itself, or the nearest labelled container. */
  const boxOf = (id: string): DiagramNode | undefined => {
    const seen = new Set<string>();
    for (let cur: string | undefined = id; cur && !seen.has(cur);) {
      seen.add(cur);
      const n = nodeOf.get(cur);
      if (n) return n;
      const r = byId.get(cur);
      cur = r ? (get(r, "contained by") || get(r, "group")).split(/[;,\s]+/)[0] : undefined;
    }
    return undefined;
  };

  for (const r of rows.filter(isLine)) {
    const id = get(r, "id");
    const src = get(r, "line source");
    const dst = get(r, "line destination");
    const from = src ? boxOf(src) : undefined;
    const to = dst ? boxOf(dst) : undefined;
    if (!from || !to) {
      diagram.problems.push({
        cell: id,
        message:
          !from && !to
            ? "edge connects no boxes"
            : !from
              ? "edge has no source box"
              : "edge has no target box",
      });
      continue;
    }
    const { legend, text: label } = legendOf(
      legendWord(get(r, "legend"), legendWords),
      textOf(r),
      legendWords,
    );
    diagram.edges.push({
      cell: id,
      from: from.label,
      to: to.label,
      label,
      ...edgeParts(label),
      ...(legend ? { legend } : {}),
      page: pages.get(get(r, "page id")) ?? "",
      line: r.line,
    });
  }
  return diagram;
}
