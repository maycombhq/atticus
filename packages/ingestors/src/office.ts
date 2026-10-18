import { isoDate, type DocumentMeta } from "./record.js";
import { ReadError, Sections, type ParsedText } from "./text-model.js";
import {
  attr,
  child,
  childrenNamed,
  elements,
  findAll,
  parseXmlTree,
  relId,
  relationships,
  resolvePart,
  textOf,
  type XNode,
} from "./xml.js";
import type { ZipArchive } from "./zip.js";

/*
 * Word, PowerPoint and Excel files (Office Open XML): ZIPs of XML parts. Only text, headings
 * and tables are read; embedded objects, macros and external links are ignored.
 */

/** Title, author, version and date from docProps/core.xml. */
function coreProps(zip: ZipArchive): { title?: string; meta: DocumentMeta } {
  const doc = parseXmlTree(zip.text("docProps/core.xml") ?? "");
  const get = (name: string) => {
    const t = textOf(child(doc, name)).trim();
    return t || undefined;
  };
  const meta: DocumentMeta = {};
  const author = get("creator");
  const version = get("version");
  const date = isoDate(get("modified")) ?? isoDate(get("created"));
  if (author) meta.author = author;
  if (version) meta.version = version;
  if (date) meta.date = date;
  const title = get("title");
  return { ...(title ? { title } : {}), meta };
}

function need(zip: ZipArchive, part: string): XNode {
  const text = zip.text(part);
  if (text === undefined) throw new ReadError(`${part} is missing`);
  const doc = parseXmlTree(text);
  if (!doc) throw new ReadError(`${part} is not XML`);
  return doc;
}

// ---------- Word ----------

/** Text of a Word paragraph: runs, tabs and breaks, deleted text left out. */
function wordText(p: XNode): string {
  let out = "";
  const walk = (n: XNode) => {
    for (const c of elements(n)) {
      if (c.name === "t") out += textOf(c);
      else if (c.name === "tab") out += "\t";
      else if (c.name === "br" || c.name === "cr") out += "\n";
      else if (c.name === "noBreakHyphen") out += "-";
      else if (c.name !== "pPr" && c.name !== "rPr" && c.name !== "del") walk(c);
    }
  };
  walk(p);
  return out;
}

/** Heading level per paragraph style id: "heading N" styles, Title as 0, outline levels. */
function wordStyles(zip: ZipArchive): Map<string, number> {
  const levels = new Map<string, number>();
  const doc = parseXmlTree(zip.text("word/styles.xml") ?? "");
  for (const s of childrenNamed(doc, "style")) {
    const id = attr(s, "styleId");
    if (!id) continue;
    const name = (attr(child(s, "name") ?? s, "val") ?? "").toLowerCase();
    const outline = attr(child(child(s, "pPr"), "outlineLvl") ?? s, "val");
    const h = /^heading (\d)$/.exec(name) ?? /^Heading(\d)$/.exec(id);
    if (name === "title" || id === "Title") levels.set(id, 0);
    else if (h) levels.set(id, Number(h[1]));
    else if (outline !== undefined && /^\d$/.test(outline)) levels.set(id, Number(outline) + 1);
  }
  return levels;
}

export function readDocx(zip: ZipArchive): ParsedText {
  const doc = need(zip, "word/document.xml");
  const levels = wordStyles(zip);
  const { title, meta } = coreProps(zip);
  const s = new Sections();
  const tables: string[][][] = [];
  const levelOf = (p: XNode): number | undefined => {
    const pPr = child(p, "pPr");
    const pStyle = child(pPr, "pStyle");
    const style = pStyle ? attr(pStyle, "val") : undefined;
    if (style && levels.has(style)) return levels.get(style);
    const style2 = style ? /^Heading(\d)$/.exec(style) : null;
    if (style2) return Number(style2[1]);
    const outline = child(pPr, "outlineLvl");
    const v = outline ? attr(outline, "val") : undefined;
    return v !== undefined && /^\d$/.test(v) ? Number(v) + 1 : undefined;
  };
  const block = (container: XNode | undefined) => {
    for (const el of elements(container)) {
      if (el.name === "p") {
        const text = wordText(el);
        const level = levelOf(el);
        if (level !== undefined && text.trim()) s.heading(text.trim(), level);
        else if (text.trim()) s.add(text);
      } else if (el.name === "tbl") {
        const rows = findAll(el, "tr").map((tr) =>
          findAll(tr, "tc").map((tc) =>
            findAll(tc, "p")
              .map(wordText)
              .map((t) => t.trim())
              .filter(Boolean)
              .join(" "),
          ),
        );
        if (rows.length) {
          tables.push(rows);
          for (const r of rows) s.add(r.join("\t"));
        }
      } else if (el.name === "sdt") block(child(el, "sdtContent"));
      else if (el.name === "customXml" || el.name === "smartTag") block(el);
    }
  };
  block(child(doc, "body"));
  return { ...(title ? { title } : {}), sections: s.done(), tables, meta, notes: [] };
}

// ---------- PowerPoint ----------

/** Text of a DrawingML text body: one line per paragraph, breaks kept. */
function drawingParagraphs(body: XNode | undefined): string[] {
  return findAll(body, "p").map((p) => {
    let out = "";
    const walk = (n: XNode) => {
      for (const c of elements(n)) {
        if (c.name === "t") out += textOf(c);
        else if (c.name === "br") out += "\n";
        else if (c.name === "tab") out += "\t";
        else if (c.name !== "pPr" && c.name !== "rPr" && c.name !== "endParaRPr") walk(c);
      }
    };
    walk(p);
    return out;
  });
}

function slideParts(zip: ZipArchive): string[] {
  const rels = relationships(zip.text("ppt/_rels/presentation.xml.rels"));
  const pres = parseXmlTree(zip.text("ppt/presentation.xml") ?? "");
  const parts: string[] = [];
  for (const id of findAll(child(pres, "sldIdLst"), "sldId")) {
    const target = rels.get(relId(id) ?? "");
    if (target) parts.push(resolvePart("ppt", target));
  }
  const num = (n: string) => Number(/slide(\d+)\.xml$/.exec(n)?.[1] ?? 0);
  const rest = zip.names
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n) && !parts.includes(n))
    .sort((a, b) => num(a) - num(b));
  return [...parts, ...rest].filter((p) => zip.has(p));
}

export function readPptx(zip: ZipArchive): ParsedText {
  const parts = slideParts(zip);
  if (!parts.length && !zip.has("ppt/presentation.xml"))
    throw new ReadError("ppt/presentation.xml is missing");
  const { title, meta } = coreProps(zip);
  const s = new Sections();
  const tables: string[][][] = [];
  parts.forEach((part, i) => {
    const doc = parseXmlTree(zip.text(part) ?? "");
    let heading = "";
    const lines: string[] = [];
    const walk = (n: XNode) => {
      for (const c of elements(n)) {
        if (c.name === "sp") {
          const ph = findAll(child(c, "nvSpPr"), "ph")[0];
          const type = ph?.attrs.type;
          const paras = drawingParagraphs(child(c, "txBody"));
          if ((type === "title" || type === "ctrTitle") && !heading)
            heading = paras.join(" ").replace(/\s+/g, " ").trim();
          else lines.push(...paras.filter((p) => p.trim()));
        } else if (c.name === "graphicFrame") {
          for (const tbl of findAll(c, "tbl")) {
            const rows = findAll(tbl, "tr").map((tr) =>
              findAll(tr, "tc").map((tc) =>
                drawingParagraphs(child(tc, "txBody"))
                  .map((t) => t.trim())
                  .filter(Boolean)
                  .join(" "),
              ),
            );
            if (rows.length) {
              tables.push(rows);
              lines.push(...rows.map((r) => r.join("\t")));
            }
          }
        } else walk(c);
      }
    };
    const tree = child(child(doc, "cSld"), "spTree") ?? doc;
    if (tree) walk(tree);
    s.heading(heading, 1, { page: i + 1 });
    for (const l of lines) s.add(l);
  });
  return { ...(title ? { title } : {}), sections: s.done(), tables, meta, notes: [] };
}

// ---------- Excel ----------

const colIndex = (ref: string) => {
  const letters = /^[A-Z]+/i.exec(ref)?.[0].toUpperCase() ?? "";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

/** Text of a shared or inline string: plain text or rich runs, phonetic hints left out. */
const stringItem = (si: XNode | undefined) =>
  elements(si)
    .flatMap((c) => (c.name === "t" ? [c] : c.name === "r" ? childrenNamed(c, "t") : []))
    .map(textOf)
    .join("");

export function readXlsx(zip: ZipArchive): ParsedText {
  const wb = need(zip, "xl/workbook.xml");
  const rels = relationships(zip.text("xl/_rels/workbook.xml.rels"));
  const shared = childrenNamed(parseXmlTree(zip.text("xl/sharedStrings.xml") ?? ""), "si").map(
    stringItem,
  );
  const { title, meta } = coreProps(zip);
  const s = new Sections();
  const tables: string[][][] = [];
  findAll(child(wb, "sheets"), "sheet").forEach((sheet, i) => {
    const target = rels.get(relId(sheet) ?? "");
    const part = target ? resolvePart("xl", target) : undefined;
    const doc = part ? parseXmlTree(zip.text(part) ?? "") : undefined;
    const rows: string[][] = [];
    let prev: number | undefined;
    for (const row of findAll(child(doc, "sheetData"), "row")) {
      const r = Number(row.attrs.r) || (prev ?? 0) + 1;
      if (prev !== undefined) for (let k = prev + 1; k < r; k++) rows.push([]);
      prev = r;
      const cells: string[] = [];
      let next = 0;
      for (const c of childrenNamed(row, "c")) {
        const at = c.attrs.r ? colIndex(c.attrs.r) : next;
        const v = textOf(child(c, "v"));
        let value: string;
        switch (c.attrs.t) {
          case "s":
            value = shared[Number(v)] ?? "";
            break;
          case "inlineStr":
            value = stringItem(child(c, "is"));
            break;
          case "b":
            value = v === "1" ? "TRUE" : v === "0" ? "FALSE" : v;
            break;
          default:
            value = v;
        }
        while (cells.length < at) cells.push("");
        cells[at] = value;
        next = at + 1;
      }
      while (cells.length && cells.at(-1) === "") cells.pop();
      rows.push(cells);
    }
    tables.push(rows);
    s.heading(sheet.attrs.name ?? `Sheet ${i + 1}`, 1, { page: i + 1 });
    for (const r of rows) s.add(r.join("\t"));
  });
  return { ...(title ? { title } : {}), sections: s.done(), tables, meta, notes: [] };
}
