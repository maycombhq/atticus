import { hiddenSpans } from "@maycombhq/ai";

/**
 * The knowledge scan's quote check (ADR 0083): the words an item quotes are on the cited page,
 * under the cited heading, in the snapshot. Deterministic, no AI. Text a person can't see (HTML
 * comments, hidden elements) never counts: a quote has to be in what a reader of the page sees.
 * Whitespace and line breaks are folded, curly quotes match straight ones, single quote marks
 * match double ones, and the punctuation a quote ends with is left out, so a sentence cut short or
 * a table cell quoted as a sentence still matches (ADR 0103); a line's blockquote and list markers
 * are left out, so a sentence wrapping inside a blockquote matches; every word is still on the
 * page, in order. Inline Markdown and HTML read as the text a reader sees (bold, emphasis, code,
 * links, inline tags, entities, zero-width spaces), dashes as "-" and "…" as "...", on the page and
 * in the quote alike (review round 50). A quote matches whole words only: one starting or ending
 * with a letter or digit never matches inside a longer word or number ("safe" in "Unsafe", "5" in
 * "500"). Nothing else is forgiven.
 */

export interface PageLine {
  line: number;
  text: string;
  /** The heading the line sits under; "" before the first heading. */
  section: string;
}

const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^ {0,3}(```+|~~~+)/;
/** A setext heading's underline: `===` (level 1) or `---` (level 2) under a line of text. */
const SETEXT = /^ {0,3}(?:=+|-+)\s*$/;

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
    // A setext heading: a line of text with `===` or `---` under it (after a blank line, `---`
    // is a thematic break, and a fence line is never a heading).
    const next = lines[i + 1];
    if (!fence && !f && l.trim() && next !== undefined && SETEXT.test(next) && !SETEXT.test(l)) {
      section = l.trim();
      i++;
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

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
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
  zwsp: "",
  shy: "",
};

/** Inline HTML a page may use around words; other tags are left as they are. */
const INLINE_TAG =
  /<\/?(?:a|abbr|b|bdi|big|cite|code|del|dfn|em|font|i|ins|kbd|mark|q|s|samp|small|span|strike|strong|sub|sup|time|tt|u|var)(?:\s[^<>]*)?\/?>/gi;

const ALNUM = /[\p{L}\p{N}]/u;

/**
 * What a reader sees of a line of Markdown: the text of links, images, code, emphasis and inline
 * HTML, entities decoded, zero-width characters gone, dashes as "-" and "…" as "...". The same
 * fold is used on the page and on the quote, so a quote that keeps the page's marks matches too.
 * Underscores are dropped only at a word's edge: `max_retry_count` keeps its own.
 */
export function readerText(s: string): string {
  return (
    s
      // Entities, named and numbered.
      .replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (m, e: string) => {
        if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? m;
        const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
        return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
      })
      .replace(/[\u200b-\u200d\u2060\ufeff\u00ad]/g, "")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(INLINE_TAG, "")
      // Images and links: their text; reference links too.
      .replace(/!?\[([^\]]*)\]\([^)\s]*(?:\s+"[^"]*")?\)/g, "$1")
      .replace(/!?\[([^\]]+)\]\[[^\]]*\]/g, "$1")
      .replace(/<((?:https?|mailto):[^<>\s]+)>/g, "$1")
      // Backslash escapes, then code spans' backticks.
      .replace(/\\([!-/:-@[-`{-~])/g, "$1")
      .replace(/`+/g, "")
      // Emphasis and strike-through marks at a word's edge.
      .replace(/(^|[^\p{L}\p{N}*_~])(?:\*{1,3}|_{1,3}|~~)(?=[^\s*_~])/gu, "$1")
      .replace(/([^\s*_~])(?:\*{1,3}|_{1,3}|~~)(?=$|[^\p{L}\p{N}*_~])/gu, "$1")
      // `*` emphasis may sit inside a word (`**Un**safe`); `_` inside a word is the word's.
      .replace(/([\p{L}\p{N}])\*{1,3}(?=[\p{L}\p{N}])/gu, "$1")
      .replace(/[\u2010-\u2015\u2212]/g, "-")
      .replace(/\u2026/g, "...")
  );
}

const sameHeading = (a: string, b: string) =>
  foldQuote(readerText(a))
    .replace(/^#+\s*/, "")
    .toLowerCase() ===
  foldQuote(readerText(b))
    .replace(/^#+\s*/, "")
    .toLowerCase();

/** Folded for matching a quote: double quote marks as single ones too (ADR 0103). */
const matchFold = (s: string) => foldQuote(readerText(s)).replace(/"/g, "'");

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
  // Whole words only: a quote starting (ending) with a letter or digit doesn't start (end)
  // inside a longer word or number on the page. Every match is tried, not only the first.
  const wordStart = ALNUM.test(q[0] ?? "");
  const wordEnd = ALNUM.test(q.at(-1) ?? "");
  for (let at = text.indexOf(q); at !== -1; at = text.indexOf(q, at + 1)) {
    if (wordStart && at > 0 && ALNUM.test(text[at - 1]!)) continue;
    const end = at + q.length;
    if (wordEnd && end < text.length && ALNUM.test(text[end]!)) continue;
    return lineAt[at];
  }
  return undefined;
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
