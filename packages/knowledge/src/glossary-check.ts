import type { CatalogRecord, RecordOf } from "@maycombhq/core";
import type { CheckContext, GapDraft, KnowledgeCheck } from "./gaps.js";

/**
 * The glossary feeds the critic: a new column or schema field needs a business term, either
 * linked (`Column.glossaryTerm`, or listed in a GlossaryTerm's `fields`) or a term with the
 * same name. One question per owning component lists every such field, with naming hints
 * where a name looks like an abbreviation or another name of an existing term (acct_no for
 * Account number). "New" means what the catalog marks as planned: a planned-new column, a
 * column of a planned-new table, or the fields of a planned-new schema. Existing fields
 * without a term are glossary coverage, not a gap on every change.
 *
 * The word rules here are a small copy of @maycombhq/glossary's, which depends on this package.
 */

type Column = RecordOf<"Column">;
type Table = RecordOf<"Table">;
type Term = RecordOf<"GlossaryTerm">;

/** Common abbreviations in column and field names, to the word they stand for. */
export const NAME_ABBREVIATIONS: Readonly<Record<string, string>> = {
  acc: "account",
  acct: "account",
  addr: "address",
  amt: "amount",
  bal: "balance",
  ccy: "currency",
  cust: "customer",
  desc: "description",
  dt: "date",
  nm: "name",
  no: "number",
  nr: "number",
  num: "number",
  qty: "quantity",
  ref: "reference",
  trx: "transaction",
  txn: "transaction",
};

const STOP = new Set(["id", "ids", "at", "by", "ts", "uuid", "the", "of", "a", "an"]);

const words = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const singular = (w: string) =>
  w.length <= 3
    ? w
    : /ies$/.test(w)
      ? `${w.slice(0, -3)}y`
      : /(ss|us|is)$/.test(w)
        ? w
        : /s$/.test(w)
          ? w.slice(0, -1)
          : w;

/** A name's words without leading or trailing stop words, last one singular. */
export function nameWords(name: string): string[] {
  const w = words(name);
  while (w.length && STOP.has(w[0]!)) w.shift();
  while (w.length && STOP.has(w.at(-1)!)) w.pop();
  return w.length ? [...w.slice(0, -1), singular(w.at(-1)!)] : [];
}

const isSubsequence = (short: string, long: string) => {
  let i = 0;
  for (const ch of long) if (ch === short[i]) i++;
  return i === short.length;
};

/** True when `w` is a shortening of `full`: a known abbreviation, or its letters in order. */
export function abbreviates(w: string, full: string): boolean {
  if (w === full) return false;
  if (NAME_ABBREVIATIONS[w] === full) return true;
  return w.length >= 2 && w.length < full.length && w[0] === full[0] && isSubsequence(w, full);
}

export interface TermName {
  id: string;
  term: string;
  aliases?: readonly string[];
}

export interface NamingHint {
  /** The column or field id (schema fields as <schema>#<field>). */
  record: string;
  name: string;
  term: string;
  termName: string;
  kind: "alias" | "abbreviation";
  message: string;
}

const snake = (s: string) => nameWords(s).join("_");

/**
 * A naming hint for one column or field name, or undefined: the name is another name (an
 * alias) of a term, or shortens every word of a term's name (holder_nm for Holder name).
 */
export function namingHint(
  record: string,
  name: string,
  terms: readonly TermName[],
): NamingHint | undefined {
  const w = nameWords(name);
  if (!w.length) return undefined;
  const key = w.join(" ");
  for (const t of terms) {
    if (nameWords(t.term).join(" ") === key) return undefined;
  }
  for (const t of terms)
    for (const a of t.aliases ?? [])
      if (nameWords(a).join(" ") === key)
        return {
          record,
          name,
          term: t.id,
          termName: t.term,
          kind: "alias",
          message: `${name} uses "${a}", another name for ${t.term} (${t.id}); name it ${snake(t.term)} or keep it linked.`,
        };
  for (const t of terms) {
    const tw = nameWords(t.term);
    if (tw.length !== w.length) continue;
    if (!w.every((x, i) => x === tw[i] || abbreviates(x, tw[i]!))) continue;
    if (!w.some((x, i) => x !== tw[i])) continue;
    return {
      record,
      name,
      term: t.id,
      termName: t.term,
      kind: "abbreviation",
      message: `${name} looks like ${t.term} (${t.id}); name it ${snake(t.term)} or link it to that term.`,
    };
  }
  return undefined;
}

interface NewField {
  id: string;
  name: string;
  component: string;
  evidence: CatalogRecord["evidence"];
}

/** New columns and schema fields, each with the component that owns it. */
function newFields(ctx: CheckContext): NewField[] {
  const out: NewField[] = [];
  const tableOwner = (t: Table | undefined) => {
    if (!t) return undefined;
    if (t.ownerComponent) return t.ownerComponent;
    const s = ctx.byId.get(t.dataStore);
    return s?.kind === "DataStore" ? s.ownerComponent : undefined;
  };
  for (const r of ctx.records) {
    if (r.kind !== "Column") continue;
    const c = r as Column;
    const t = ctx.byId.get(c.table) as Table | undefined;
    const isNew = c.status === "planned-new" || t?.status === "planned-new";
    if (!isNew) continue;
    const component = tableOwner(t?.kind === "Table" ? t : undefined);
    if (component) out.push({ id: c.id, name: c.name, component, evidence: c.evidence });
  }
  for (const r of ctx.records) {
    if (r.kind !== "Schema" || r.status !== "planned-new") continue;
    const ep = ctx.records.find(
      (e): e is RecordOf<"Endpoint"> => e.kind === "Endpoint" && e.schemaRefs.includes(r.id),
    );
    if (!ep) continue;
    for (const f of r.fields)
      out.push({
        id: `${r.id}#${f.name}`,
        name: f.name,
        component: ep.component,
        evidence: r.evidence,
      });
  }
  return out;
}

export const glossaryTermKnown: KnowledgeCheck = {
  id: "glossary-term-known",
  description:
    "A new column or schema field needs a glossary term: linked to it, or a term with its name.",
  needs: [
    {
      kind: "GlossaryTerm",
      what: "a glossary term for each new column and schema field",
    },
    { kind: "Column", field: "glossaryTerm", what: "the term a new column is linked to" },
  ],
  run(ctx) {
    const terms = ctx.records.filter((r): r is Term => r.kind === "GlossaryTerm");
    const termIds = new Set(terms.map((t) => t.id));
    const linked = new Set(terms.flatMap((t) => t.fields));
    const keys = new Set(terms.map((t) => nameWords(t.term).join(" ")));
    const names = terms.map((t) => ({ id: t.id, term: t.term }));
    const byComponent = new Map<string, NewField[]>();
    for (const f of newFields(ctx)) {
      const col = ctx.byId.get(f.id) as Column | undefined;
      if (col?.glossaryTerm && termIds.has(col.glossaryTerm)) continue;
      if (linked.has(f.id)) continue;
      if (keys.has(nameWords(f.name).join(" "))) continue;
      byComponent.set(f.component, [...(byComponent.get(f.component) ?? []), f]);
    }
    const out: GapDraft[] = [];
    for (const [component, fields] of [...byComponent].sort(([a], [b]) => a.localeCompare(b))) {
      const system = ctx.systemOf(component);
      if (!system) continue;
      fields.sort((a, b) => a.id.localeCompare(b.id));
      const hints = fields
        .map((f) => namingHint(f.id, f.name, names))
        .filter((h): h is NamingHint => !!h);
      const dangling = fields
        .map((f) => ctx.byId.get(f.id) as Column | undefined)
        .filter((c): c is Column => !!c?.glossaryTerm && !termIds.has(c.glossaryTerm));
      const list = fields.map((f) => f.id).join(", ");
      const parts = [
        `Which business terms do the new fields of ${component} hold (${list})? Define each in the glossary or link it to a term.`,
        ...dangling.map((c) => `${c.id} links to ${c.glossaryTerm}, which isn't in the glossary.`),
        ...hints.map((h) => h.message),
      ];
      const evidence = fields.flatMap((f) => f.evidence.slice(0, 1));
      out.push({
        system,
        records: [component],
        question: parts.join(" "),
        neededFact: `GlossaryTerm for ${list}`,
        evidence: evidence.length ? evidence : [{ source: "manual" }],
      });
    }
    return out;
  },
};
