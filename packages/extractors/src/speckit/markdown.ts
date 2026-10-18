/**
 * The small Markdown reading the speckit extractor needs: headings, pipe tables, bullet
 * lists and `**Key**: value` lines, each with its line number. HTML comments and fenced code
 * blocks are skipped (comments are blanked so line numbers stay put). Free prose is never
 * interpreted: only these structures are read.
 */

export interface MdHeading {
  level: number;
  text: string;
  line: number;
  /** Last line of the section (inclusive). */
  end: number;
}

export interface MdTable {
  line: number;
  headers: string[];
  rows: { line: number; cells: Record<string, string> }[];
}

export interface MdDoc {
  lines: string[];
  headings: MdHeading[];
  tables: MdTable[];
  /** Lines inside fenced code blocks, by line number, with the fence's info string. */
  fences: { info: string; line: number; body: { line: number; text: string }[] }[];
}

const SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

const cells = (line: string): string[] => {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
};

/** A cell without Markdown emphasis or code ticks. */
export const plain = (s: string) => s.replace(/[`*]/g, "").trim();

export function parseMd(text: string): MdDoc {
  const raw = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const lines = raw.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " ")).split("\n");
  const headings: MdHeading[] = [];
  const fences: MdDoc["fences"] = [];
  const inFence = new Set<number>();
  let open: MdDoc["fences"][number] | undefined;
  lines.forEach((l, i) => {
    const fence = /^\s*(```|~~~)\s*([\w-]*)/.exec(l);
    if (fence) {
      if (open) {
        fences.push(open);
        open = undefined;
      } else open = { info: fence[2] ?? "", line: i + 1, body: [] };
      inFence.add(i);
      return;
    }
    if (open) {
      open.body.push({ line: i + 1, text: l });
      inFence.add(i);
      return;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
    if (h) headings.push({ level: h[1]!.length, text: h[2]!, line: i + 1, end: lines.length });
  });
  headings.forEach((h, i) => {
    const next = headings.slice(i + 1).find((x) => x.level <= h.level);
    h.end = next ? next.line - 1 : lines.length;
  });
  const tables: MdTable[] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    if (inFence.has(i) || !lines[i]!.includes("|") || !SEPARATOR.test(lines[i + 1]!)) continue;
    const headers = cells(lines[i]!).map((h) => plain(h).toLowerCase());
    const rows: MdTable["rows"] = [];
    let j = i + 2;
    for (; j < lines.length && lines[j]!.includes("|") && !inFence.has(j); j++) {
      const v = cells(lines[j]!);
      rows.push({
        line: j + 1,
        cells: Object.fromEntries(headers.map((h, k) => [h, plain(v[k] ?? "")])),
      });
    }
    tables.push({ line: i + 1, headers, rows });
    i = j - 1;
  }
  return { lines, headings, tables, fences };
}

/** The section of the first heading matching `re`. */
export function section(doc: MdDoc, re: RegExp): MdHeading | undefined {
  return doc.headings.find((h) => re.test(h.text));
}

/** Tables inside a section. */
export function tablesIn(doc: MdDoc, s: MdHeading): MdTable[] {
  return doc.tables.filter((t) => t.line > s.line && t.line <= s.end);
}

/** `**Key**: value` lines (a Spec Kit Technical Context), keys lower-cased. */
export function keyValues(
  doc: MdDoc,
  from = 1,
  to = doc.lines.length,
): Map<string, { value: string; line: number }> {
  const out = new Map<string, { value: string; line: number }>();
  for (let n = from; n <= to; n++) {
    const m = /^\s*\*\*([^*]+)\*\*\s*:\s*(.+?)\s*$/.exec(doc.lines[n - 1] ?? "");
    if (m && !out.has(m[1]!.trim().toLowerCase()))
      out.set(m[1]!.trim().toLowerCase(), { value: m[2]!, line: n });
  }
  return out;
}

/** Bullet lines in a range, with their text after the marker. */
export function bullets(doc: MdDoc, from: number, to: number): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  for (let n = from; n <= to; n++) {
    const m = /^\s*[-*+]\s+(.*)$/.exec(doc.lines[n - 1] ?? "");
    if (m) out.push({ line: n, text: m[1]! });
  }
  return out;
}
