import { parseRecord, type CatalogRecord, type EvidenceT, type RecordOf } from "@maycombhq/core";
import { namingHint, type KnowledgePage, type NamingHint } from "@maycombhq/knowledge";
import { codeTerms, fieldNames, type CodeTerm } from "./code.js";
import type { DefinitionProposal } from "./proposals.js";
import { wikiDefinitions, type WikiDefinition } from "./wiki.js";
import { compoundOf, definitionKey, displayTerm, singleOf, termId, termKey } from "./words.js";

/**
 * The glossary as catalog records: one GlossaryTerm per term found on wiki pages, in code or
 * named by people, before curated decisions are applied (a person's definition, link or
 * alias wins on every scan, like every other curated decision).
 *
 * - The definition is the first page's (by path, then line); a code-only term takes an AI
 *   proposal (flag `ai-proposed`) or says it isn't defined yet (flag `undefined`). Terms are
 *   `inferred` until a person defines them (a curated assert makes them `asserted`).
 * - `fields` lists the columns and schema fields (`<schema>#<field>`) whose name is the term or
 *   one of its other names, and columns people linked to it; matching columns get
 *   `Column.glossaryTerm` unless they already have one.
 * - Conflicts: two different definitions of one term (flag `conflict:definition`, unless a
 *   person defined it), and a term used differently in code: its fields have types of
 *   different sorts, or the definition says amount or date and a field isn't one (flag
 *   `conflict:code-usage`).
 * - Synonyms come from alias decisions (target a term id, value the other names).
 */

export type GlossaryTermRecord = RecordOf<"GlossaryTerm">;
type Decision = RecordOf<"CuratedDecision">;

export interface GlossaryInput {
  pages: readonly KnowledgePage[];
  records: readonly CatalogRecord[];
  /** Curated decisions (catalog/curated): aliases, definitions and links of terms. */
  decisions?: readonly CatalogRecord[];
  /** AI definition proposals for code-only terms (catalog/proposals/glossaryterm). */
  proposals?: readonly DefinitionProposal[];
}

export interface GlossaryConflict {
  term: string;
  kind: "definition" | "code-usage";
  message: string;
  /** Where each side was read. */
  evidence: EvidenceT[];
  /** A person's definition settles a definition conflict. */
  resolved: boolean;
}

export interface TermEntry {
  id: string;
  term: string;
  sources: ("wiki" | "code" | "person" | "ai")[];
  definitions: WikiDefinition[];
  code?: CodeTerm;
  aliases: string[];
  /** Columns, schema fields and other records linked by people. */
  linked: string[];
}

export interface ColumnLink {
  column: string;
  term: string;
  how: "name" | "alias" | "decision";
}

export interface GlossaryBuild {
  terms: GlossaryTermRecord[];
  entries: TermEntry[];
  columnLinks: ColumnLink[];
  conflicts: GlossaryConflict[];
  hints: NamingHint[];
  problems: string[];
}

const isDecision = (r: CatalogRecord): r is Decision =>
  r.kind === "CuratedDecision" && r.status === "current";
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Sort of a column or field type, to compare how code uses a term. */
export function typeSort(type: string): string {
  const t = type.toLowerCase();
  if (
    /^(numeric|decimal|number|money|int|integer|bigint|smallint|tinyint|float|double|real|long|short)\b/.test(
      t,
    )
  )
    return "number";
  if (/^(date|time|timestamp|datetime|timestamptz|instant|localdate)/.test(t)) return "time";
  if (/^(bool|boolean|bit)\b/.test(t)) return "boolean";
  if (/^(uuid|guid)\b/.test(t)) return "identifier";
  if (/^(varchar|char|character|nvarchar|nchar|text|string|clob|citext)/.test(t)) return "text";
  return t.replace(/\(.*$/, "");
}

/** What a definition says the term is, when it says: an amount or count, or a date or time. */
function definitionSort(d: string): string | undefined {
  if (/\b(amount|sum|total|count|number of|quantity)\b/i.test(d)) return "number";
  if (/\b(date|timestamp|time at which|day on which)\b/i.test(d)) return "time";
  return undefined;
}

const ALIASES = (d: Decision) => (Array.isArray(d.value) ? d.value : [d.value]).map(String);

export function buildGlossary(input: GlossaryInput): GlossaryBuild {
  const problems: string[] = [];
  const decisions = (input.decisions ?? []).filter(isDecision);
  const records = input.records.filter((r) => r.kind !== "GlossaryTerm");
  const byId = new Map(records.map((r) => [r.id, r]));

  // ---- people: other names, definitions, links
  const aliasTo = new Map<string, string>(); // alias key → term id
  const aliasesOf = new Map<string, string[]>();
  for (const d of decisions.filter((x) => x.action === "alias" && x.target.startsWith("term."))) {
    for (const a of ALIASES(d)) {
      const k = termKey(a);
      if (!k) continue;
      aliasTo.set(k, d.target);
      aliasesOf.set(d.target, [...new Set([...(aliasesOf.get(d.target) ?? []), a])]);
    }
  }
  const defined = new Map<string, Decision>();
  const termFieldDecisions = new Map<string, string[]>();
  for (const d of decisions.filter((x) => x.action === "assert" && x.target.startsWith("term."))) {
    if (!isObj(d.value)) continue;
    if (typeof d.value.definition === "string") defined.set(d.target, d);
    if (Array.isArray(d.value.fields)) termFieldDecisions.set(d.target, d.value.fields.map(String));
  }
  const columnDecisions = new Map<string, string>(); // column → term
  for (const d of decisions.filter((x) => x.action === "assert")) {
    if (!isObj(d.value) || typeof d.value.glossaryTerm !== "string") continue;
    if (byId.get(d.target)?.kind === "Column") columnDecisions.set(d.target, d.value.glossaryTerm);
  }

  const idOfKey = (key: string) => aliasTo.get(key) ?? termId(key);
  const keyOfAlias = (key: string) => {
    const id = aliasTo.get(key);
    return id ? id.slice("term.".length).replace(/-/g, " ") : key;
  };

  // ---- wiki and code
  const defs = new Map<string, WikiDefinition[]>();
  for (const d of wikiDefinitions(input.pages)) {
    const id = idOfKey(d.key);
    defs.set(id, [...(defs.get(id) ?? []), d]);
  }
  const code = new Map<string, CodeTerm>();
  for (const t of codeTerms(records, keyOfAlias).values()) code.set(idOfKey(t.key), t);
  const proposals = new Map((input.proposals ?? []).map((p) => [p.term, p]));

  // A compound name only the code uses that shortens another term (holder_nm for Holder name)
  // is not a term of its own: it gets a naming hint instead.
  const known = [...new Set([...defs.keys(), ...code.keys(), ...defined.keys()])].map((id) => ({
    id,
    term: defs.get(id)?.[0]?.term ?? id.slice("term.".length).replace(/-/g, " "),
    aliases: aliasesOf.get(id) ?? [],
  }));
  for (const [id, c] of [...code]) {
    if (defs.has(id) || defined.has(id) || !c.key.includes(" ")) continue;
    const h = namingHint(
      id,
      c.key,
      known.filter((k) => k.id !== id),
    );
    if (h?.kind === "abbreviation") code.delete(id);
  }
  const ids = new Set([...defs.keys(), ...code.keys(), ...defined.keys()]);
  const entries: TermEntry[] = [];
  const terms: GlossaryTermRecord[] = [];
  const conflicts: GlossaryConflict[] = [];
  const columnLinks: ColumnLink[] = [];

  for (const id of [...ids].sort()) {
    const ds = defs.get(id) ?? [];
    const c = code.get(id);
    const person = defined.get(id);
    const proposal = c && !ds.length && !person ? proposals.get(id) : undefined;
    const personTerm =
      person && isObj(person.value) && typeof person.value.term === "string"
        ? person.value.term
        : undefined;
    const term =
      ds[0]?.term ?? personTerm ?? displayTerm(id.slice("term.".length).replace(/-/g, " "));
    const linkedColumns = [...columnDecisions].filter(([, t]) => t === id).map(([col]) => col);
    const linked = [...new Set([...linkedColumns, ...(termFieldDecisions.get(id) ?? [])])].sort();
    const sources: TermEntry["sources"] = [];
    if (ds.length) sources.push("wiki");
    if (c) sources.push("code");
    if (person) sources.push("person");
    if (proposal) sources.push("ai");
    entries.push({
      id,
      term,
      sources,
      definitions: ds,
      ...(c ? { code: c } : {}),
      aliases: (aliasesOf.get(id) ?? []).sort(),
      linked,
    });

    const flags: string[] = [];
    const distinct = [...new Map(ds.map((d) => [definitionKey(d.definition), d])).values()];
    if (distinct.length > 1) {
      if (!person) flags.push("conflict:definition");
      conflicts.push({
        term: id,
        kind: "definition",
        message: `${term} has ${distinct.length} definitions: ${distinct
          .map((d) => `"${d.definition}" (${d.path}:${d.line})`)
          .join(" and ")}.`,
        evidence: distinct.map((d) => ({ source: "document", path: d.path, line: d.line })),
        resolved: !!person,
      });
    }

    const definition =
      person && isObj(person.value) && typeof person.value.definition === "string"
        ? person.value.definition
        : (ds[0]?.definition ??
          proposal?.definition ??
          `Not defined yet. Found in code: ${(c?.uses ?? [])
            .slice(0, 5)
            .map((u) => u.record)
            .join(", ")}.`);
    if (!ds.length && !person) flags.push(proposal ? "ai-proposed" : "undefined");

    // How the code uses it: field types of different sorts, or not what the definition says.
    const fields = [...new Set([...(c?.fields ?? []), ...linkedColumns])].sort();
    const types: Record<string, string> = { ...(c?.types ?? {}) };
    for (const col of linkedColumns) {
      const r = byId.get(col);
      if (r?.kind === "Column") types[col] = r.type;
    }
    const sorts = new Map<string, string[]>();
    for (const [f, t] of Object.entries(types))
      sorts.set(typeSort(t), [...(sorts.get(typeSort(t)) ?? []), f]);
    const expected = ds.length || person || proposal ? definitionSort(definition) : undefined;
    const off = expected ? Object.entries(types).filter(([, t]) => typeSort(t) !== expected) : [];
    if (sorts.size > 1 || off.length) {
      flags.push("conflict:code-usage");
      const parts: string[] = [];
      if (expected && off.length)
        parts.push(
          `the definition says it is ${expected === "number" ? "an amount or count" : "a date or time"}, but ${off
            .map(([f, t]) => `${f} is ${t}`)
            .join(", ")}`,
        );
      if (sorts.size > 1)
        parts.push(
          `its fields have different types: ${Object.entries(types)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([f, t]) => `${f} ${t}`)
            .join(", ")}`,
        );
      conflicts.push({
        term: id,
        kind: "code-usage",
        message: `${term} is used differently in code: ${parts.join("; ")}.`,
        evidence: Object.keys(types)
          .sort()
          .map((f) => {
            const r = byId.get(f.split("#")[0]!);
            const e = r?.evidence[0];
            return e ?? ({ source: "code" } as EvidenceT);
          }),
        resolved: false,
      });
    }

    const evidence: EvidenceT[] = [
      ...ds.map((d) => ({ source: "document" as const, path: d.path, line: d.line })),
      ...(c?.uses ?? []).slice(0, 5).map((u) => u.evidence),
    ];
    if (!evidence.length && person) evidence.push({ source: "manual", by: person.by });
    if (!evidence.length) evidence.push({ source: "manual" });
    const allFields = [...new Set([...fields, ...(termFieldDecisions.get(id) ?? [])])].sort();
    const owner = ds.find((d) => d.owner)?.owner;
    const p = parseRecord({
      schemaVersion: 2,
      kind: "GlossaryTerm",
      id,
      status: "current",
      confidence: "inferred",
      term,
      definition,
      fields: allFields,
      ...(owner ? { owner } : {}),
      evidence,
      ...(flags.length ? { flags: [...new Set(flags)].sort() } : {}),
    });
    if (!p.ok) {
      problems.push(`${id}: ${p.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
      continue;
    }
    terms.push(p.record as GlossaryTermRecord);

    for (const f of c?.fields ?? []) {
      if (byId.get(f)?.kind !== "Column") continue;
      const r = byId.get(f) as RecordOf<"Column">;
      const whole = compoundOf(r.name) ?? singleOf(r.name) ?? "";
      columnLinks.push({ column: f, term: id, how: aliasTo.has(whole) ? "alias" : "name" });
    }
    for (const col of linkedColumns) columnLinks.push({ column: col, term: id, how: "decision" });
  }

  // A column linked by a person keeps that link only; other matches give way.
  const decided = new Set(columnLinks.filter((l) => l.how === "decision").map((l) => l.column));
  const links = columnLinks
    .filter((l) => l.how === "decision" || !decided.has(l.column))
    .sort((a, b) => a.column.localeCompare(b.column) || a.term.localeCompare(b.term));

  // ---- naming hints for fields no term covers
  const covered = new Set([...terms.flatMap((t) => t.fields), ...links.map((l) => l.column)]);
  const names = entries.map((e) => ({ id: e.id, term: e.term, aliases: e.aliases }));
  const hints = fieldNames(records)
    .filter((f) => !covered.has(f.record))
    .map((f) => namingHint(f.record, f.name, names))
    .filter((h): h is NamingHint => !!h);

  return {
    terms,
    entries,
    columnLinks: links,
    conflicts: conflicts.sort(
      (a, b) => a.term.localeCompare(b.term) || a.kind.localeCompare(b.kind),
    ),
    hints,
    problems,
  };
}

/**
 * The catalog with the glossary in it: the terms added, and `Column.glossaryTerm` set on
 * columns a term matches by name when the column has none. Curated decisions apply after.
 */
export function applyGlossary(
  records: readonly CatalogRecord[],
  build: GlossaryBuild,
): CatalogRecord[] {
  const link = new Map<string, string>();
  for (const l of build.columnLinks) if (!link.has(l.column)) link.set(l.column, l.term);
  const out: CatalogRecord[] = [];
  for (const r of records) {
    if (r.kind === "GlossaryTerm") continue;
    if (r.kind === "Column" && !r.glossaryTerm && link.has(r.id))
      out.push({ ...r, glossaryTerm: link.get(r.id)! });
    else out.push(r);
  }
  return [...out, ...build.terms];
}
