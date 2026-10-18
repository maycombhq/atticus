/**
 * A small Markdown reader that keeps line numbers, because every finding points at a line.
 * HTML comments are blanked (their characters become spaces, newlines stay), so template
 * placeholders never count as content and line numbers don't move.
 */

export interface DocLine {
  /** 1-based line number. */
  n: number;
  text: string;
}

export interface Section {
  heading: string;
  level: number;
  /** Line of the heading. */
  line: number;
  /** Last line of the section's body (inclusive). */
  end: number;
}

export interface TableRow {
  line: number;
  /** Cells keyed by lower-cased header, cleaned of backticks and emphasis. */
  cells: Record<string, string>;
}

export interface Table {
  line: number;
  headers: string[];
  rows: TableRow[];
  /** The heading the table sits under, if any. */
  section?: string;
}

export interface Doc {
  path: string;
  raw: string;
  /** Lines with comments blanked, index 0 is line 1. */
  lines: string[];
  /** Lines as written, comments included (for quotes and for checks that look inside comments). */
  rawLines: string[];
  sections: Section[];
  tables: Table[];
}

const SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

function splitCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

/** A table cell without Markdown decoration. */
export const clean = (s: string) => s.replace(/[`*]/g, "").trim();

function blankComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
}

export function parseDoc(path: string, text: string): Doc {
  const raw = text.replace(/\r\n/g, "\n");
  const rawLines = raw.split("\n");
  const lines = blankComments(raw).split("\n");
  const sections: Section[] = [];
  let fence = false;
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    if (fence) return;
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
    if (m) sections.push({ heading: m[2]!, level: m[1]!.length, line: i + 1, end: lines.length });
  });
  sections.forEach((s, i) => {
    const next = sections.slice(i + 1).find((x) => x.level <= s.level);
    s.end = next ? next.line - 1 : lines.length;
  });
  const tables: Table[] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!lines[i]!.includes("|") || !SEPARATOR.test(lines[i + 1]!)) continue;
    const headers = splitCells(lines[i]!).map((h) => clean(h).toLowerCase());
    const rows: TableRow[] = [];
    let j = i + 2;
    for (; j < lines.length && lines[j]!.includes("|"); j++) {
      const v = splitCells(lines[j]!);
      rows.push({
        line: j + 1,
        cells: Object.fromEntries(headers.map((h, k) => [h, clean(v[k] ?? "")])),
      });
    }
    const section = [...sections].reverse().find((s) => s.line <= i + 1)?.heading;
    tables.push({ line: i + 1, headers, rows, ...(section ? { section } : {}) });
    i = j - 1;
  }
  return { path, raw, lines, rawLines, sections, tables };
}

/** The first table that has every one of these headers (lower case). */
export function tableWith(doc: Doc | undefined, headers: string[]): Table | undefined {
  return doc?.tables.find((t) => headers.every((h) => t.headers.includes(h)));
}

/** The first section whose heading matches. */
export function sectionMatching(doc: Doc | undefined, re: RegExp): Section | undefined {
  return doc?.sections.find((s) => re.test(s.heading));
}

/** Body lines of a section (heading excluded), comments blanked, empty lines dropped. */
export function sectionLines(doc: Doc, s: Section): DocLine[] {
  const out: DocLine[] = [];
  for (let n = s.line + 1; n <= s.end; n++) {
    const text = doc.lines[n - 1]!;
    if (text.trim()) out.push({ n, text });
  }
  return out;
}

/** Every non-empty line of a document, comments blanked. */
export function contentLines(doc: Doc): DocLine[] {
  return doc.lines.map((text, i) => ({ n: i + 1, text })).filter((l) => l.text.trim() !== "");
}

/** The section a line sits in, for a finding's locator. */
export function headingAt(doc: Doc, line: number): string | undefined {
  return [...doc.sections].reverse().find((s) => s.line <= line)?.heading;
}

/** A quote of a line for evidence: trimmed and under 200 characters. */
export function quoteOf(doc: Doc, line: number): string | undefined {
  const t = doc.rawLines[line - 1]?.trim();
  if (!t) return undefined;
  return t.length <= 190 ? t : `${t.slice(0, 187)}...`;
}

/** Whether someone wrote anything beyond template scaffolding. */
export function isFilledDoc(doc: Doc): boolean {
  for (let i = 0; i < doc.lines.length; i++) {
    const line = doc.lines[i]!.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (SEPARATOR.test(line)) continue;
    if (line.includes("|") && i + 1 < doc.lines.length && SEPARATOR.test(doc.lines[i + 1]!))
      continue;
    if (line.includes("|") && splitCells(line).every((c) => c === "")) continue;
    if (/^([-*+]|\d+\.)(\s+\[[ xX]?\])?\s*$/.test(line)) continue;
    return true;
  }
  return false;
}
