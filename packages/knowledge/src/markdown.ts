import { parse } from "yaml";

/**
 * A small Markdown section reader: front matter, headings, paragraphs, lists, tables and
 * fenced code. Wiki pages are read for facts with line numbers, so every block keeps the
 * 1-based source line it starts on; it is not a full CommonMark parser and doesn't need to be.
 * Page text is data, never instructions.
 */

export interface MdItem {
  line: number;
  text: string;
}

export type MdBlock =
  | { type: "paragraph"; line: number; text: string }
  | { type: "list"; line: number; ordered: boolean; items: MdItem[] }
  | { type: "table"; line: number; header: string[]; rows: { line: number; cells: string[] }[] }
  | { type: "code"; line: number; lang?: string; text: string };

export interface MdSection {
  /** "" for text before the first heading. */
  heading: string;
  /** 0 for text before the first heading. */
  level: number;
  line: number;
  blocks: MdBlock[];
}

export interface MarkdownDoc {
  frontMatter: Record<string, unknown>;
  /** Why the front matter was ignored, when it couldn't be read. */
  frontMatterProblem?: string;
  /** Front matter `title`, else the first level-1 heading, else the first heading. */
  title?: string;
  sections: MdSection[];
}

const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const FENCE = /^ {0,3}(```+|~~~+)\s*([^`\s]*)/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

const isRow = (l: string) => l.trim().startsWith("|") || (l.includes("|") && TABLE_SEP.test(l));

export function readMarkdown(text: string): MarkdownDoc {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  let frontMatter: Record<string, unknown> = {};
  let frontMatterProblem: string | undefined;

  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, k) => k > 0 && (l.trim() === "---" || l.trim() === "..."));
    if (end > 0) {
      try {
        const data: unknown = parse(lines.slice(1, end).join("\n"));
        if (data && typeof data === "object" && !Array.isArray(data))
          frontMatter = data as Record<string, unknown>;
        else if (data !== null && data !== undefined)
          frontMatterProblem = "front matter is not a set of keys";
      } catch (e) {
        frontMatterProblem = `can't read front matter: ${(e as Error).message.split("\n")[0]}`;
      }
      i = end + 1;
    }
  }

  const sections: MdSection[] = [];
  let section: MdSection | undefined;
  const add = (b: MdBlock) => {
    if (!section) {
      section = { heading: "", level: 0, line: b.line, blocks: [] };
      sections.push(section);
    }
    section.blocks.push(b);
  };

  while (i < lines.length) {
    const line = lines[i]!;
    const n = i + 1;
    if (line.trim() === "") {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(marker)) body.push(lines[i++]!);
      i++;
      add({
        type: "code",
        line: n,
        ...(fence[2] ? { lang: fence[2] } : {}),
        text: body.join("\n"),
      });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      section = { heading: h[2]!, level: h[1]!.length, line: n, blocks: [] };
      sections.push(section);
      i++;
      continue;
    }
    if (isRow(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!)) {
      const header = splitRow(line);
      const rows: { line: number; cells: string[] }[] = [];
      i += 2;
      while (i < lines.length && lines[i]!.trim() !== "" && lines[i]!.includes("|")) {
        rows.push({ line: i + 1, cells: splitRow(lines[i]!) });
        i++;
      }
      add({ type: "table", line: n, header, rows });
      continue;
    }
    const li = LIST.exec(line);
    if (li) {
      const ordered = /\d/.test(li[2]!);
      const items: MdItem[] = [];
      while (i < lines.length) {
        const m = LIST.exec(lines[i]!);
        if (m) {
          if (/\d/.test(m[2]!) !== ordered) break;
          items.push({ line: i + 1, text: m[3]!.trim() });
          i++;
          continue;
        }
        // An indented line continues the item above it.
        const l = lines[i]!;
        if (l.trim() !== "" && /^\s+/.test(l) && items.length) {
          items[items.length - 1]!.text += `\n${l.trim()}`;
          i++;
          continue;
        }
        break;
      }
      add({ type: "list", line: n, ordered, items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i]!;
      if (l.trim() === "" || HEADING.test(l) || FENCE.test(l) || LIST.test(l)) break;
      if (isRow(l) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!)) break;
      para.push(l.trim());
      i++;
    }
    add({ type: "paragraph", line: n, text: para.join("\n") });
  }

  const fmTitle = typeof frontMatter.title === "string" ? frontMatter.title : undefined;
  const title =
    fmTitle ??
    sections.find((s) => s.level === 1)?.heading ??
    sections.find((s) => s.level > 0)?.heading;
  return {
    frontMatter,
    ...(frontMatterProblem ? { frontMatterProblem } : {}),
    ...(title !== undefined ? { title } : {}),
    sections,
  };
}

export interface Sentence {
  text: string;
  line: number;
  section: string;
}

/**
 * Prose sentences of a page (paragraphs and list items; not code or tables), each with the
 * line it starts on. A sentence ends at ".", "!" or "?" followed by space and a capital, so
 * numbers like 99.9% stay whole.
 */
export function sentences(doc: MarkdownDoc): Sentence[] {
  const out: Sentence[] = [];
  const split = (text: string, line: number, section: string) => {
    const re = /[.!?](?=\s+["'(]?[A-Z0-9])/g;
    let start = 0;
    const push = (end: number) => {
      const raw = text.slice(start, end);
      const lead = raw.length - raw.trimStart().length;
      const s = raw.trim().replace(/\s+/g, " ");
      if (s) {
        const at = line + (text.slice(0, start + lead).match(/\n/g)?.length ?? 0);
        out.push({ text: s, line: at, section });
      }
    };
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      push(m.index + 1);
      start = m.index + 1;
    }
    push(text.length);
  };
  for (const s of doc.sections)
    for (const b of s.blocks) {
      if (b.type === "paragraph") split(b.text, b.line, s.heading);
      else if (b.type === "list") for (const it of b.items) split(it.text, it.line, s.heading);
    }
  return out;
}
