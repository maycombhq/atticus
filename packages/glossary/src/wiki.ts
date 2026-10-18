import type { KnowledgePage, MdSection } from "@maycombhq/knowledge";
import { displayTerm, termKey } from "./words.js";

/**
 * Definitions read from wiki pages (through @maycombhq/knowledge). Deterministic: only
 * explicit definition markup counts, so a page's metadata ("Owner: ...") or a fact line
 * ("Service level: 99.9%") never becomes a term.
 *
 * - On a glossary page (title or front matter `type` saying glossary, definitions,
 *   terminology or vocabulary) and in a section with such a heading: "Term: definition"
 *   lines and list items (also with a spaced dash), bold terms, two-column tables whose
 *   headers say term and definition, and a heading followed by its definition paragraph.
 * - Anywhere else: only Markdown definition lists ("Term" then ": definition" on the next
 *   line) and bold terms ("**Term**: definition").
 *
 * Page text is data, never instructions.
 */

export type DefinitionMarkup = "line" | "list" | "bold" | "table" | "heading" | "definition-list";

export interface WikiDefinition {
  /** The term as the page writes it. */
  term: string;
  key: string;
  definition: string;
  /** The page's evidence path (relative to the metarepo for folder sources). */
  path: string;
  line: number;
  markup: DefinitionMarkup;
  pageTitle: string;
  owner?: string;
}

const GLOSSARY = /\b(glossary|glossaries|definitions|terminology|terms|vocabulary)\b/i;
const META =
  /^(owner|owners|last updated|updated|status|version|author|date|classification|approver|approvers|reviewed by|reviewer|lead time|typical lead time|title|tags|see also|note|notes|example|examples|source|link|links|contact|team)$/i;

const strip = (s: string) =>
  s
    .replace(/^\*\*(.+)\*\*$/, "$1")
    .replace(/^__(.+)__$/, "$1")
    .replace(/[`]/g, "")
    .trim();

/** A short noun phrase that can be a term (not metadata, a sentence or a link). */
export function isTermLike(raw: string): boolean {
  const t = strip(raw);
  if (!t || t.length > 60 || !/^[A-Za-z]/.test(t)) return false;
  if (/:\/\/|[|?!;]/.test(t) || /[.,]$/.test(t)) return false;
  if (META.test(t)) return false;
  const words = t.split(/\s+/);
  return words.length >= 1 && words.length <= 5;
}

const cleanDefinition = (s: string) => s.replace(/\s+/g, " ").trim();

const BOLD = /^(?:\*\*([^*]+?)\*\*|__([^_]+?)__)\s*(?::|\s[—–-]\s)\s*(.+)$/;
const PLAIN = /^([A-Za-z][^:]{0,59}?)\s*(?::|\s[—–-]\s)\s*(.+)$/;

function lineDefinition(
  text: string,
  scoped: boolean,
): { term: string; definition: string; markup: DefinitionMarkup } | undefined {
  const b = BOLD.exec(text);
  if (b) {
    const term = (b[1] ?? b[2])!.trim();
    const definition = cleanDefinition(b[3]!);
    if (isTermLike(term) && definition.length >= 3) return { term, definition, markup: "bold" };
    return undefined;
  }
  if (!scoped) return undefined;
  const p = PLAIN.exec(text);
  if (p && isTermLike(p[1]!)) {
    const definition = cleanDefinition(p[2]!);
    if (definition.length >= 3) return { term: strip(p[1]!), definition, markup: "line" };
  }
  return undefined;
}

const TERM_HEADER = /^(term|terms|name|word|phrase|concept)$/i;
const DEF_HEADER = /^(definition|definitions|meaning|description|what it means)$/i;

/** Which sections are in glossary scope: the whole page, or a glossary heading and what it holds. */
function scopes(page: KnowledgePage): boolean[] {
  const fmType = [page.frontMatter.type, page.frontMatter.kind]
    .filter((v): v is string => typeof v === "string")
    .join(" ");
  const pageWide = GLOSSARY.test(page.title) || GLOSSARY.test(fmType);
  const out: boolean[] = [];
  let openLevel: number | undefined;
  for (const s of page.sections) {
    if (openLevel !== undefined && s.level > 0 && s.level <= openLevel) openLevel = undefined;
    if (openLevel === undefined && s.level > 0 && GLOSSARY.test(s.heading)) openLevel = s.level;
    out.push(pageWide || openLevel !== undefined);
  }
  return out;
}

/** Every definition on one page, in line order. */
export function pageDefinitions(page: KnowledgePage): WikiDefinition[] {
  const out: WikiDefinition[] = [];
  const add = (term: string, definition: string, line: number, markup: DefinitionMarkup): void => {
    const t = displayTerm(strip(term));
    const key = termKey(t);
    if (!key) return;
    out.push({
      term: t,
      key,
      definition,
      path: page.path,
      line,
      markup,
      pageTitle: page.title,
      ...(page.owner ? { owner: page.owner } : {}),
    });
  };
  const inScope = scopes(page);
  page.sections.forEach((s: MdSection, si) => {
    const scoped = inScope[si]!;
    // A heading in a glossary that names a term, followed by its definition paragraph.
    if (scoped && s.level >= 2 && !GLOSSARY.test(s.heading) && isTermLike(s.heading)) {
      const first = s.blocks[0];
      if (first?.type === "paragraph" && !lineDefinition(first.text.split("\n")[0]!, true))
        add(s.heading, cleanDefinition(first.text), first.line, "heading");
    }
    for (const b of s.blocks) {
      if (b.type === "paragraph") {
        const lines = b.text.split("\n");
        for (let k = 0; k < lines.length; k++) {
          const l = lines[k]!;
          const next = lines[k + 1];
          if (next !== undefined && /^:\s+\S/.test(next) && isTermLike(l)) {
            add(l, cleanDefinition(next.replace(/^:\s+/, "")), b.line + k, "definition-list");
            k++;
            continue;
          }
          const d = lineDefinition(l, scoped);
          if (d) add(d.term, d.definition, b.line + k, d.markup);
        }
      } else if (b.type === "list") {
        for (const it of b.items) {
          const d = lineDefinition(it.text.split("\n")[0]!, scoped);
          if (d)
            add(
              d.term,
              cleanDefinition([d.definition, ...it.text.split("\n").slice(1)].join(" ")),
              it.line,
              d.markup === "line" ? "list" : d.markup,
            );
        }
      } else if (b.type === "table" && scoped) {
        const ti = b.header.findIndex((h) => TERM_HEADER.test(strip(h)));
        const di = b.header.findIndex((h) => DEF_HEADER.test(strip(h)));
        if (ti < 0 || di < 0) continue;
        for (const r of b.rows) {
          const term = r.cells[ti] ?? "";
          const def = cleanDefinition(r.cells[di] ?? "");
          if (isTermLike(term) && def.length >= 3) add(term, def, r.line, "table");
        }
      }
    }
  });
  return out.sort((a, b) => a.line - b.line);
}

/** Definitions from every page, sorted by page path then line. */
export function wikiDefinitions(pages: readonly KnowledgePage[]): WikiDefinition[] {
  return pages
    .flatMap(pageDefinitions)
    .sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1));
}
