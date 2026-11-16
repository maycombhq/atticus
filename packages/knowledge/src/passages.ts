import { itemTitle } from "./knowledge-store.js";
import type { KnowledgeRecord } from "./knowledge-scan.js";
import type { InitialismBook } from "@maycombhq/core";
import { initialismsIn, itemText, rankItems, termsOf } from "./knowledge-ask.js";
import { visibleText } from "./quotes.js";

/**
 * ADR 0191: what the organisation's wikis and documents say to a person's question, by its words
 * (no AI), so Ask Atticus can answer "How do I request a firewall rule?" from knowledge, not only
 * from the catalog; and one section of a page by its id, so a change's suggested knowledge opens
 * in place. Pages are a source's snapshot copies or the metarepo's inputs/ files read as they are
 * (ADR 0122); the text is data, shown with where it is from, never instructions.
 */

/** A page to read passages from: a snapshot copy, or an inputs/ file read now. */
export interface PassagePage {
  source: string;
  /** The page's path inside its source. */
  page: string;
  /** Its root-relative path. */
  path: string;
  text: string;
}

export interface Passage {
  source: string;
  page: string;
  path: string;
  /** The section's heading path ("Firewall rules › Requesting one"), "" before the first. */
  heading: string;
  /** The line its heading (or its first line) is on, from 1. */
  line: number;
  text: string;
}

/** Most of a section shown, and of an answer's passages. */
const MAX_TEXT = 1500;

const clip = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1).trimEnd()}…` : s);

/**
 * The page's lines as a person sees them: hidden text (comments, hidden elements, display:none
 * spans) blanked as quotes are, and YAML front matter left out, each line kept where it was.
 */
export function visibleLines(text: string): { lines: string[]; from: number } {
  const raw = text.replace(/\r\n?/g, "\n").split("\n");
  const lines = visibleText(raw.join("\n"))
    .split("\n")
    .map((l, i) => (l === raw[i] ? l : l.replace(/[ \t]{2,}/g, " ").trimEnd()));
  let from = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, k) => k > 0 && (l.trim() === "---" || l.trim() === "..."));
    if (end > 0) {
      for (let k = 0; k <= end; k++) lines[k] = "";
      from = end + 1;
    }
  }
  return { lines, from };
}

/** A page's sections: each heading with the text under it (deeper headings start their own). */
export function pageSections(p: PassagePage, o: { whole?: boolean } = {}): Passage[] {
  const cut = o.whole ? (s: string) => s : clip;
  const { lines, from } = visibleLines(p.text);
  const out: Passage[] = [];
  const path: { level: number; text: string }[] = [];
  let start = from;
  let heading = "";
  const flush = (end: number) => {
    const body = lines.slice(start, end);
    const text = body
      .filter((l, i) => !(i === 0 && /^#{1,6}\s/.test(l)))
      .join("\n")
      .trim();
    if (text || heading)
      out.push({
        source: p.source,
        page: p.page,
        path: p.path,
        heading,
        line: start + 1,
        text: cut(text),
      });
  };
  let inFence = false;
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) inFence = !inFence;
    const h = inFence ? null : /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
    if (!h) return;
    if (i > start || heading) flush(i);
    const level = h[1]!.length;
    while (path.length && path.at(-1)!.level >= level) path.pop();
    path.push({ level, text: h[2]! });
    heading = path.map((x) => x.text).join(" › ");
    start = i;
  });
  flush(lines.length);
  return out.filter((s) => s.text || s.heading);
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * The section a knowledge id names: `<source>/<page>#<heading>`, where the heading is the
 * section's own heading, its whole path, or either as a slug (the ids the context engine gives).
 * Without `#`, the page's first section. Undefined when no page or section is so named.
 */
export function sectionOf(pages: readonly PassagePage[], id: string): Passage | undefined {
  // beta.28.3: a page's name may have a "#" in it ("Release #4 notes.md"), so the page is the
  // longest name the id starts with, not what is before the first "#".
  const names = (p: PassagePage) => [`${p.source}/${p.page}`, p.path, p.page];
  let page: PassagePage | undefined;
  let named = -1;
  for (const p of pages)
    for (const n of names(p))
      if (n.length > named && (id === n || id.startsWith(`${n}#`))) {
        page = p;
        named = n.length;
      }
  if (!page) return undefined;
  const sections = pageSections(page);
  const want = id.slice(named + 1).trim();
  if (!want) return sections[0];
  const last = (h: string) => h.split(" › ").at(-1) ?? h;
  const exact = (wanted: string) => {
    const w = wanted.toLowerCase();
    return sections.find(
      (s) => s.heading.toLowerCase() === w || last(s.heading).toLowerCase() === w,
    );
  };
  const loose = (wanted: string) =>
    sections.find(
      (s) => slug(s.heading) === slug(wanted) || slug(last(s.heading)) === slug(wanted),
    ) ??
    sections.find((s) => slug(wanted).endsWith(slug(last(s.heading))) && slug(last(s.heading)));
  // A long section is indexed in parts, the later ones as `<heading>#2`, `#3`: its section. The
  // heading as written comes first, then the part's, before any looser match ("Step#2" is part
  // 2 of Step, not the section "Step 2").
  const part = /^(.*\S)\s*#\d+$/.exec(want)?.[1];
  return (
    exact(want) ??
    (part ? exact(part) : undefined) ??
    (part ? loose(part) : undefined) ??
    loose(want)
  );
}

/**
 * What of a long section is shown: its start, or (beta.28.3) from the paragraph that first has
 * one of the question's words when that is past what fits, so the sentence found is the one read.
 */
function shown(text: string, q: readonly string[]): string {
  if (text.length <= MAX_TEXT) return text;
  const has = (s: string) => {
    const words = new Set(termsOf(s));
    return q.some((t) => words.has(t));
  };
  // The start already shows one of the words: nothing to move.
  if (has(text.slice(0, MAX_TEXT - 1))) return clip(text);
  // Where each paragraph starts, then each line of the paragraph that has the word.
  const starts = [0, ...[...text.matchAll(/\n\s*\n/g)].map((m) => m.index + m[0].length)];
  let at = -1;
  for (let i = 0; i < starts.length && at < 0; i++) {
    const para = text.slice(starts[i]!, starts[i + 1] ?? text.length);
    if (!has(para)) continue;
    at = starts[i]!;
    if (para.length > MAX_TEXT) {
      let line = at;
      for (const l of para.split("\n")) {
        if (has(l)) break;
        line += l.length + 1;
      }
      if (line < at + para.length) at = line;
    }
  }
  if (at < 0) return clip(text);
  let rest = text.slice(at).trim();
  // One very long line: from the sentence that has the word, else from the word itself.
  if (rest.length > MAX_TEXT - 2 && !has(rest.slice(0, MAX_TEXT - 2))) {
    const sentences = rest.split(/(?<=[.!?])\s+/);
    let from = 0;
    for (const sentence of sentences) {
      if (has(sentence)) break;
      from += sentence.length + 1;
    }
    if (from < rest.length) rest = rest.slice(from).trim();
  }
  return `… ${rest}`.length > MAX_TEXT
    ? `${`… ${rest}`.slice(0, MAX_TEXT - 1).trimEnd()}…`
    : `… ${rest}`;
}

/**
 * The sections that share the most of the question's words (rarer words count more), best first.
 * beta.28.3: the whole section is searched, not its first 1,500 characters; a heading with
 * nothing under it is never an answer; and a name the pages define ("Enterprise Data Warehouse
 * (EDW)"), written as its acronym on one side and its words on the other, counts as two rare
 * words in common.
 */
export function rankPassages(
  question: string,
  pages: readonly PassagePage[],
  limit = 5,
  o: { acronyms?: InitialismBook; sections?: readonly Passage[] } = {},
): Passage[] {
  const q = [...new Set(termsOf(question))];
  if (!q.length) return [];
  const all = (o.sections ?? pages.flatMap((p) => pageSections(p, { whole: true }))).filter(
    (s) => s.text,
  );
  const docs = all.map((s) => new Set(termsOf(`${s.heading} ${s.text}`)));
  const idf = new Map(
    q.map((t) => [t, Math.log(1 + all.length / (1 + docs.filter((d) => d.has(t)).length))]),
  );
  const acronyms = o.acronyms ?? initialismsIn(all.map((s) => `${s.heading}\n${s.text}`));
  const name = Math.log(1 + all.length);
  // A passage needs more than one of the question's words unless the question has one.
  const need = q.length > 2 ? 2 : 1;
  return all
    .map((s, k) => {
      const hits = q.filter((t) => docs[k]!.has(t));
      const heading = new Set(termsOf(s.heading));
      const names = acronyms.links(question, `${s.heading}\n${s.text}`).length;
      const score =
        hits.reduce((n, t) => n + idf.get(t)! * (heading.has(t) ? 1.5 : 1), 0) + 2 * name * names;
      return { s, hits: hits.length + 2 * names, score };
    })
    .filter((x) => x.hits >= need)
    .sort((a, b) => b.score - a.score || a.s.path.localeCompare(b.s.path) || a.s.line - b.s.line)
    .slice(0, limit)
    .map((x) => ({ ...x.s, text: shown(x.s.text, q) }));
}

export interface KnowledgeFound {
  items: {
    id: string;
    kind: string;
    title: string;
    quote?: { source: string; page: string; section?: string; text: string };
  }[];
  passages: Passage[];
}

/**
 * What the knowledge says to a question: the items it matches (each with the quote it rests on)
 * and the passages of the pages that share its words. Nothing is worded by a model here.
 */
export function knowledgeAnswer(
  question: string,
  o: { items: readonly KnowledgeRecord[]; pages: readonly PassagePage[]; limit?: number },
): KnowledgeFound {
  const limit = o.limit ?? 5;
  // The acronyms the pages and the items define, read once for both rankings.
  const sections = o.pages.flatMap((p) => pageSections(p, { whole: true }));
  const acronyms = initialismsIn([
    ...sections.map((s) => `${s.heading}\n${s.text}`),
    ...o.items.map(itemText),
  ]);
  const q = termsOf(question);
  const need = new Set(q).size > 2 ? 2 : 1;
  const items = rankItems(question, [...o.items], { acronyms })
    .filter((x) => {
      // beta.28.3: counted over everything the item says, as rankItems (and so knowledge ask)
      // reads it; an acronym and its words count as a name in common.
      const text = itemText(x.item);
      const own = new Set(termsOf(text));
      const names = acronyms.links(question, text).length;
      return [...new Set(q)].filter((t) => own.has(t)).length + 2 * names >= need;
    })
    .slice(0, limit)
    .map(({ item }) => ({
      id: item.id,
      kind: item.kind,
      title: itemTitle(item),
      ...(item.quote
        ? {
            quote: {
              source: item.quote.source,
              page: item.quote.page,
              ...(item.quote.section ? { section: item.quote.section } : {}),
              text: item.quote.text,
            },
          }
        : {}),
    }));
  return { items, passages: rankPassages(question, o.pages, limit, { acronyms, sections }) };
}
