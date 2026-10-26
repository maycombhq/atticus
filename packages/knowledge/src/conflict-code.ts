import type { PageRef } from "./knowledge-scan.js";

/**
 * Whether the code settles what two pages disagree on (ADR 0124 addendum B-task-knowledge). A
 * document never overrides a fact verified from code (CLAUDE.md rule 6): when one page's own
 * value (a path, a URL, a dotted key such as a config property) is a value of a catalog record
 * verified from code, and no other page's own value is, the code settles it, and the conflict
 * says so and cites the record and its line. A bare word ("email") or a name the catalog uses as
 * an id ("forge-identity") is never enough: too many records hold one. No model: the same records
 * and pages give the same answer. Both pages matching, or neither, settles nothing: that stays a
 * person's question.
 */

/** A record as this check reads it: any catalog record (C1), its fields read as data. */
export interface CodeFactRecord {
  kind: string;
  id: string;
  confidence: string;
  evidence: { source: string; repo?: string; path?: string; line?: number }[];
}

export interface CodeSettles {
  /** The page whose words the code has. */
  page: PageRef;
  /** The record verified from code, and its kind. */
  record: string;
  kind: string;
  /** The value the page and the record share. */
  value: string;
  /** Where the code says it: repo:path:line. */
  at: string;
}

/** Evidence sources that are the code itself (not a document, diagram, export or a person). */
const CODE_SOURCES = new Set([
  "code",
  "config",
  "spec",
  "gateway",
  "event-config",
  "infrastructure",
  "pipeline",
  "migration",
]);

/** Fields that say where a record is or how sure it is, never what the code holds. */
const SKIP = new Set(["kind", "id", "schemaVersion", "status", "confidence", "evidence", "flags"]);

/**
 * The values a text names that code could hold exactly: paths (/a/b), URLs, dotted keys (a.b.c),
 * and quoted or backticked strings with a slash, dot or colon in them.
 */
export function valuesOf(text: string): string[] {
  const out = new Set<string>();
  const add = (v: string) => {
    const x = v
      .trim()
      .replace(/^[`"']+|[`"']+$/g, "")
      .replace(/[.,;:!?)]+$/, "")
      .trim();
    if (x.length >= 3 && /[/.:]/.test(x)) out.add(x);
  };
  for (const m of text.matchAll(/`([^`]+)`|"([^"]+)"/g)) add(m[1] ?? m[2] ?? "");
  for (const m of text.matchAll(/\bhttps?:\/\/[^\s"'`<>]+/g)) add(m[0]);
  for (const m of text.matchAll(/(?<![\w:/])(?:\/[\w\-.{}~%]+)+\/?/g)) add(m[0]);
  for (const m of text.matchAll(/\b[A-Za-z][\w-]*(?:\.[A-Za-z][\w-]*)+\b/g)) add(m[0]);
  return [...out];
}

const norm = (v: string) => v.toLowerCase().replace(/\/+$/, "");

/** The string values a record holds, two levels deep, apart from where it is. */
function recordValues(r: CodeFactRecord): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown, depth: number) => {
    if (typeof v === "string") out.add(norm(v));
    else if (Array.isArray(v)) for (const x of v) walk(x, depth);
    else if (v && typeof v === "object" && depth < 2)
      for (const [k, x] of Object.entries(v)) if (!SKIP.has(k)) walk(x, depth + 1);
  };
  for (const [k, v] of Object.entries(r)) if (!SKIP.has(k)) walk(v, 0);
  return out;
}

const fromCode = (r: CodeFactRecord) =>
  r.confidence === "verified" && r.evidence.some((e) => CODE_SOURCES.has(e.source));

const atOf = (r: CodeFactRecord) => {
  const e = r.evidence.find((x) => CODE_SOURCES.has(x.source) && x.path) ?? r.evidence[0]!;
  return `${e.repo ? `${e.repo}:` : ""}${e.path ?? r.id}${e.line ? `:${e.line}` : ""}`;
};

/** The page the code settles a conflict for, with the record that says so; undefined otherwise. */
export function codeSettles(
  c: { pages: PageRef[]; says: string[] },
  records: readonly CodeFactRecord[],
): CodeSettles | undefined {
  if (c.pages.length < 2 || !records.length) return undefined;
  const values = c.pages.map((_, k) => valuesOf(c.says[k] ?? ""));
  const ids = new Set(records.map((r) => norm(r.id)));
  // Each page's own values: what no other page of the conflict says, and no record's id.
  const own = values.map((vs, k) => {
    const others = new Set(values.filter((_, j) => j !== k).flatMap((x) => x.map(norm)));
    return vs.filter((v) => !others.has(norm(v)) && !ids.has(norm(v)));
  });
  const facts = records
    .filter(fromCode)
    .map((r) => ({ r, values: recordValues(r) }))
    .sort((a, b) => a.r.id.localeCompare(b.r.id));
  const hits = own.map((vs) => {
    for (const v of vs) {
      const f = facts.find((x) => x.values.has(norm(v)));
      if (f) return { v, r: f.r };
    }
    return undefined;
  });
  const which = hits.flatMap((h, k) => (h ? [k] : []));
  if (which.length !== 1) return undefined;
  const k = which[0]!;
  const h = hits[k]!;
  return { page: c.pages[k]!, record: h.r.id, kind: h.r.kind, value: h.v, at: atOf(h.r) };
}
