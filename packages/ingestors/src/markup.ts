import { parse as parseYaml } from "yaml";
import { decodeEntities } from "./xml.js";
import { isoDate, type DocumentMeta } from "./record.js";
import { Sections, type ParsedText } from "./text-model.js";

/*
 * Markdown, HTML and plain text. The text is kept as text: links are not followed, HTML is
 * not rendered, scripts and styles are dropped unread, and nothing in the text is treated as
 * an instruction.
 */

const str = (v: unknown): string | undefined => {
  if (typeof v === "string") return v.trim() || undefined;
  if (Array.isArray(v)) {
    const parts = v.filter((x): x is string => typeof x === "string" && !!x.trim());
    return parts.length ? parts.join(", ") : undefined;
  }
  return undefined;
};

/** Cells of a pipe-table row: outer pipes dropped, "\|" kept as a literal pipe. */
function tableCells(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

export function readMarkdown(src: string): ParsedText {
  const lines = src.replace(/^\uFEFF/, "").split(/\r?\n/);
  const notes: string[] = [];
  const meta: DocumentMeta = {};
  let title: string | undefined;
  let start = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, i) => i > 0 && (l.trim() === "---" || l.trim() === "..."));
    if (end > 0) {
      start = end + 1;
      try {
        // failsafe: every value stays a string, so version 1.10 stays "1.10".
        const fm = parseYaml(lines.slice(1, end).join("\n"), { schema: "failsafe" }) as unknown;
        if (fm && typeof fm === "object" && !Array.isArray(fm)) {
          const o = fm as Record<string, unknown>;
          title = str(o.title);
          const version = str(o.version);
          const author = str(o.author ?? o.authors);
          const date = isoDate(str(o.date));
          if (version) meta.version = version;
          if (author) meta.author = author;
          if (date) meta.date = date;
        }
      } catch {
        notes.push("The front matter could not be read, so its fields were skipped.");
      }
    }
  }

  const s = new Sections();
  const tables: string[][][] = [];
  let fence: { char: string; len: number } | undefined;
  let table: string[][] | undefined;
  let prevPara = false;
  for (let i = start; i < lines.length; i++) {
    const l = lines[i]!;
    const lineNo = i + 1;
    if (fence) {
      s.add(l, lineNo);
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(l);
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.len) fence = undefined;
      prevPara = false;
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(l);
    if (open) {
      fence = { char: open[1]![0]!, len: open[1]!.length };
      table = undefined;
      s.add(l, lineNo);
      prevPara = false;
      continue;
    }
    const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(l);
    if (atx) {
      s.heading((atx[2] ?? "").trim(), atx[1]!.length, { line: lineNo });
      table = undefined;
      prevPara = false;
      continue;
    }
    const setext = /^ {0,3}(=+|-+)[ \t]*$/.exec(l);
    if (setext && prevPara) {
      const text = s.popLine();
      s.heading((text ?? "").trim(), setext[1]![0] === "=" ? 1 : 2, { line: lineNo - 1 });
      prevPara = false;
      continue;
    }
    // Pipe tables: a header row, a separator row, then rows with pipes until something else.
    const next = lines[i + 1] ?? "";
    if (table) {
      if (l.trim() && l.includes("|")) {
        if (!TABLE_SEP.test(l)) table.push(tableCells(l));
      } else table = undefined;
    } else if (l.includes("|") && next.includes("-") && TABLE_SEP.test(next)) {
      table = [tableCells(l)];
      tables.push(table);
    }
    s.add(l, lineNo);
    prevPara = !!l.trim() && !table;
  }
  return { ...(title ? { title } : {}), sections: s.done(), tables, meta, notes };
}

export function readPlainText(src: string): ParsedText {
  const s = new Sections();
  src
    .replace(/^\uFEFF/, "")
    .split(/\r\n|\r|\n/)
    .forEach((l, i) => s.add(l, i + 1));
  return { sections: s.done(), tables: [], meta: {}, notes: [] };
}

const HTML_ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  bull: "•",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  times: "×",
  euro: "€",
  pound: "£",
  aacute: "á",
  agrave: "à",
  acirc: "â",
  auml: "ä",
  aring: "å",
  ccedil: "ç",
  eacute: "é",
  egrave: "è",
  ecirc: "ê",
  euml: "ë",
  iacute: "í",
  iuml: "ï",
  ntilde: "ñ",
  oacute: "ó",
  ocirc: "ô",
  ouml: "ö",
  oslash: "ø",
  uacute: "ú",
  uuml: "ü",
  szlig: "ß",
};

const BLOCK = new Set(
  "p div br li ul ol dl dt dd tr table thead tbody tfoot section article header footer nav main aside blockquote pre hr figure figcaption form fieldset address caption h1 h2 h3 h4 h5 h6".split(
    " ",
  ),
);

/** Blank out a matched region but keep its line breaks, so later line numbers stay right. */
const blank = (m: string) => m.replace(/[^\n]/g, "");

export function readHtml(src: string): ParsedText {
  const meta: DocumentMeta = {};
  const titleM = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(src);
  const title = titleM
    ? decodeEntities(titleM[1]!.replace(/<[^>]*>/g, " "), HTML_ENTITIES)
        .replace(/\s+/g, " ")
        .trim()
    : undefined;
  for (const m of src.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const name = /\b(?:name|property)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (!name || content === undefined) continue;
    const value = decodeEntities(content, HTML_ENTITIES).trim();
    if (name === "author" && value) meta.author ??= value;
    if (["date", "dcterms.date", "article:published_time"].includes(name))
      meta.date ??= isoDate(value);
  }
  if (!meta.date) delete meta.date;
  const clean = src
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, blank)
    .replace(/<![^>]*>|<\?[\s\S]*?\?>/g, blank)
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, blank)
    .replace(/<head\b[\s\S]*?<\/head\s*>/gi, blank);

  const s = new Sections();
  const tables: string[][][] = [];
  let line = "";
  let lineStart: number | undefined;
  let heading: { level: number; text: string; line: number } | undefined;
  let table: string[][] | undefined;
  let row: string[] | undefined;
  let cell: string | undefined;
  let pos = 0;
  let lineNo = 1;
  const lineAt = (to: number) => {
    for (; pos < to; pos++) if (clean.charCodeAt(pos) === 10) lineNo++;
    return lineNo;
  };
  const flush = () => {
    const t = line.replace(/\s+/g, " ").trim();
    if (t) s.add(t, lineStart);
    line = "";
    lineStart = undefined;
  };
  const tag = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
  let last = 0;
  const text = (raw: string, at: number) => {
    const t = decodeEntities(raw, HTML_ENTITIES);
    if (heading) heading.text += t;
    else if (cell !== undefined) cell += t;
    else if (table) return;
    else {
      if (t.trim() && lineStart === undefined) lineStart = lineAt(at + raw.search(/\S/));
      line += t;
    }
  };
  for (let m = tag.exec(clean); m; m = tag.exec(clean)) {
    text(clean.slice(last, m.index), last);
    last = tag.lastIndex;
    const close = m[1] === "/";
    const name = m[2]!.toLowerCase();
    const h = /^h([1-6])$/.exec(name);
    if (h) {
      if (!close) {
        flush();
        heading = { level: Number(h[1]), text: "", line: lineAt(m.index) };
      } else if (heading) {
        s.heading(heading.text.replace(/\s+/g, " ").trim(), heading.level, { line: heading.line });
        heading = undefined;
      }
      continue;
    }
    if (name === "table") {
      flush();
      if (!close) {
        table = [];
        tables.push(table);
      } else table = undefined;
      continue;
    }
    if (table && name === "tr") {
      if (!close) row = [];
      else if (row) {
        if (row.length) {
          table.push(row);
          s.add(row.join("\t"));
        }
        row = undefined;
      }
      continue;
    }
    if (table && (name === "td" || name === "th")) {
      if (!close) cell = "";
      else if (cell !== undefined) {
        row?.push(cell.replace(/\s+/g, " ").trim());
        cell = undefined;
      }
      continue;
    }
    if (name === "br" && heading) heading.text += " ";
    else if (name === "br" && cell !== undefined) cell += " ";
    else if (BLOCK.has(name) && !heading && cell === undefined) flush();
  }
  text(clean.slice(last), last);
  flush();
  return {
    ...(title ? { title } : {}),
    sections: s.done(),
    tables: tables.filter((t) => t.length),
    meta,
    notes: [],
  };
}
