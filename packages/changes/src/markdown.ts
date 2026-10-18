/**
 * Small, deterministic readers for the Markdown artifacts of a change. They read only the
 * tables the org-flow templates define; anything else in a file is ignored.
 */

/** True when a line is a table separator such as `| --- | :-: |`. */
const SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

const stripComments = (text: string) => text.replace(/<!--[\s\S]*?-->/g, "");

/**
 * Every table in a Markdown text as rows keyed by lower-cased header. Comments are removed
 * first, so template placeholders never count as values.
 */
export function readTables(text: string): Record<string, string>[][] {
  const lines = stripComments(text).replace(/\r\n/g, "\n").split("\n");
  const tables: Record<string, string>[][] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!lines[i]!.includes("|") || !SEPARATOR.test(lines[i + 1]!)) continue;
    const header = cells(lines[i]!).map((h) => h.toLowerCase());
    const rows: Record<string, string>[] = [];
    let j = i + 2;
    for (; j < lines.length && lines[j]!.includes("|"); j++) {
      const v = cells(lines[j]!);
      rows.push(Object.fromEntries(header.map((h, k) => [h, v[k] ?? ""])));
    }
    tables.push(rows);
    i = j - 1;
  }
  return tables;
}

/** Rows of the first table that has every one of these headers (lower case). */
export function tableWith(text: string, headers: string[]): Record<string, string>[] {
  return readTables(text).find((t) => t.length > 0 && headers.every((h) => h in t[0]!)) ?? [];
}

/**
 * Whether someone has written anything in an artifact. Headings, HTML comments, table
 * headers and separators, empty table rows and empty bullets are template scaffolding;
 * a file with nothing else is still the template.
 */
export function isFilled(text: string): boolean {
  const lines = stripComments(text).replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (SEPARATOR.test(line)) continue;
    if (line.includes("|") && i + 1 < lines.length && SEPARATOR.test(lines[i + 1]!)) continue;
    if (line.includes("|") && cells(line).every((c) => c === "")) continue;
    if (/^([-*+]|\d+\.)(\s+\[[ xX]?\])?\s*$/.test(line)) continue;
    return true;
  }
  return false;
}
