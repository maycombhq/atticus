import { hiddenSpans } from "@maycombhq/ai";

/**
 * The knowledge scan's quote check (ADR 0083): the words an item quotes are on the cited page,
 * under the cited heading, in the snapshot. Deterministic, no AI. Text a person can't see (HTML
 * comments, hidden elements) never counts: a quote has to be in what a reader of the page sees.
 * Whitespace and line breaks are folded, curly quotes match straight ones, single quote marks
 * match double ones, and the punctuation a quote ends with is left out, so a sentence cut short or
 * a table cell quoted as a sentence still matches (ADR 0103); a line's blockquote and list markers
 * are left out, so a sentence wrapping inside a blockquote matches; every word is still on the
 * page, in order. Nothing else is forgiven.
 */

export interface PageLine {
  line: number;
  text: string;
  /** The heading the line sits under; "" before the first heading. */
  section: string;
}

const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^ {0,3}(```+|~~~+)/;

/** Blank out what a person can't see, keeping line breaks so line numbers stay. */
export function visibleText(text: string): string {
  const spans = hiddenSpans(text);
  if (!spans.length) return text;
  let out = "";
  let at = 0;
  for (const s of spans) {
    if (s.start < at) continue;
    out += text.slice(at, s.start) + text.slice(s.start, s.end).replace(/[^\n]/g, " ");
    at = s.end;
  }
  return out + text.slice(at);
}

/** The page's visible lines with the heading each sits under. Front matter is left out. */
export function pageLines(text: string): PageLine[] {
  const lines = visibleText(text.replace(/\r\n?/g, "\n")).split("\n");
  let i = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, k) => k > 0 && (l.trim() === "---" || l.trim() === "..."));
    if (end > 0) i = end + 1;
  }
  const out: PageLine[] = [];
  let section = "";
  let fence: string | undefined;
  for (; i < lines.length; i++) {
    const l = lines[i]!;
    const f = FENCE.exec(l);
    if (f) fence = fence ? (l.trim().startsWith(fence) ? undefined : fence) : f[1];
    const h = fence ? undefined : HEADING.exec(l);
    if (h) {
      section = h[2]!;
      continue;
    }
    out.push({ line: i + 1, text: l, section });
  }
  return out;
}

/** Fold what the check forgives: whitespace runs and curly quotes. */
export const foldQuote = (s: string) =>
  s
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/\s+/g, " ")
    .trim();

const sameHeading = (a: string, b: string) =>
  foldQuote(a)
    .replace(/^#+\s*/, "")
    .toLowerCase() ===
  foldQuote(b)
    .replace(/^#+\s*/, "")
    .toLowerCase();

/** Folded for matching a quote: double quote marks as single ones too (ADR 0103). */
const matchFold = (s: string) => foldQuote(s).replace(/"/g, "'");

/**
 * A line's Markdown container markers: blockquote `>` (nested too), then a list marker (`-`,
 * `*`, `+`, `1.` or `1)`). A sentence that wraps inside a blockquote, or runs from one list item
 * into the next, reads on without them; the words are still on the page, in order.
 */
const MARKERS = /^\s*(?:>\s?)*\s*(?:(?:[-*+]|\d{1,9}[.)])\s+)?/;
const unmark = (s: string) => s.replace(MARKERS, "");

/** Find folded words in a run of lines; the line the match starts on. */
function findIn(lines: PageLine[], q: string): number | undefined {
  let text = "";
  const lineAt: number[] = [];
  for (const l of lines) {
    const t = matchFold(unmark(l.text));
    if (!t) continue;
    if (text) {
      text += " ";
      lineAt.push(l.line);
    }
    for (let k = 0; k < t.length; k++) lineAt.push(l.line);
    text += t;
  }
  const at = text.indexOf(q);
  return at === -1 ? undefined : lineAt[at];
}

export type QuoteCheck =
  | { ok: true; line: number; section: string }
  | { ok: false; problem: string; foundUnder?: string; line?: number };

/**
 * Check a quote against a page: on the page and, when a section is given, under that heading.
 * Sections with the same heading are all searched.
 */
export function checkQuote(text: string, quote: string, section?: string): QuoteCheck {
  // The punctuation a quote ends with is the model's, not always the page's (ADR 0103).
  // A quote copied with the page's marker in front ("> Every restart...") reads as the page does.
  const q = matchFold(unmark(quote)).replace(/[\s.,;:!?]+$/, "");
  if (q.length < 12) return { ok: false, problem: "the quote is too short to check" };
  const lines = pageLines(text);
  const sections = [...new Set(lines.map((l) => l.section))];
  if (section !== undefined && section.trim() !== "") {
    const wanted = sections.filter((s) => sameHeading(s, section));
    for (const s of wanted) {
      const line = findIn(
        lines.filter((l) => l.section === s),
        q,
      );
      if (line !== undefined) return { ok: true, line, section: s };
    }
    for (const s of sections) {
      const line = findIn(
        lines.filter((l) => l.section === s),
        q,
      );
      if (line !== undefined)
        return {
          ok: false,
          problem: wanted.length
            ? `the quote is on the page under "${s || "(no heading)"}", not under "${section}"`
            : `the page has no heading "${section}"; the quote is under "${s || "(no heading)"}"`,
          foundUnder: s,
          line,
        };
    }
    return {
      ok: false,
      problem: wanted.length
        ? `the quote is not on the page, word for word`
        : `the page has no heading "${section}", and the quote is not on the page, word for word`,
    };
  }
  for (const s of sections) {
    const line = findIn(
      lines.filter((l) => l.section === s),
      q,
    );
    if (line !== undefined) return { ok: true, line, section: s };
  }
  return { ok: false, problem: "the quote is not on the page, word for word" };
}
