import { itemTitle } from "./knowledge-store.js";
import type { KnowledgeRecord } from "./knowledge-scan.js";
import { rankItems, termsOf } from "./knowledge-ask.js";
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
function visibleLines(text: string): { lines: string[]; from: number } {
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
export function pageSections(p: PassagePage): Passage[] {
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
        text: clip(text),
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
  const hash = id.indexOf("#");
  const where = hash < 0 ? id : id.slice(0, hash);
  const want = hash < 0 ? "" : id.slice(hash + 1).trim();
  const page = pages.find(
    (p) => `${p.source}/${p.page}` === where || p.path === where || p.page === where,
  );
  if (!page) return undefined;
  const sections = pageSections(page);
  if (!want) return sections[0];
  const w = want.toLowerCase();
  const last = (h: string) => h.split(" › ").at(-1) ?? h;
  return (
    sections.find((s) => s.heading.toLowerCase() === w || last(s.heading).toLowerCase() === w) ??
    sections.find((s) => slug(s.heading) === slug(want) || slug(last(s.heading)) === slug(want)) ??
    sections.find((s) => slug(want).endsWith(slug(last(s.heading))) && slug(last(s.heading)))
  );
}

/** The sections that share the most of the question's words (rarer words count more), best first. */
export function rankPassages(
  question: string,
  pages: readonly PassagePage[],
  limit = 5,
): Passage[] {
  const q = [...new Set(termsOf(question))];
  if (!q.length) return [];
  const all = pages.flatMap(pageSections);
  const docs = all.map((s) => new Set(termsOf(`${s.heading} ${s.text}`)));
  const idf = new Map(
    q.map((t) => [t, Math.log(1 + all.length / (1 + docs.filter((d) => d.has(t)).length))]),
  );
  // A passage needs more than one of the question's words unless the question has one.
  const need = q.length > 2 ? 2 : 1;
  return all
    .map((s, k) => {
      const hits = q.filter((t) => docs[k]!.has(t));
      const heading = new Set(termsOf(s.heading));
      const score = hits.reduce((n, t) => n + idf.get(t)! * (heading.has(t) ? 1.5 : 1), 0);
      return { s, hits: hits.length, score };
    })
    .filter((x) => x.hits >= need)
    .sort((a, b) => b.score - a.score || a.s.path.localeCompare(b.s.path) || a.s.line - b.s.line)
    .slice(0, limit)
    .map((x) => x.s);
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
  const q = termsOf(question);
  const need = new Set(q).size > 2 ? 2 : 1;
  const items = rankItems(question, [...o.items])
    .filter((x) => {
      const own = new Set(
        termsOf(`${itemTitle(x.item)} ${x.item.quote?.text ?? ""} ${x.item.tags.join(" ")}`),
      );
      return [...new Set(q)].filter((t) => own.has(t)).length >= need;
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
  return { items, passages: rankPassages(question, o.pages, limit) };
}
