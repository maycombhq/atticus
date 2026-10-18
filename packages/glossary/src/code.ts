import type { CatalogRecord, EvidenceT, RecordOf } from "@maycombhq/core";
import { businessWords, compoundOf, singleOf } from "./words.js";

/**
 * Domain words the code uses: frequent nouns in endpoint paths, topics, tables, columns and
 * schema fields. Deterministic:
 *
 * - a single word is a term when two or more records use it, or when it names a table;
 * - a compound table, column or field name (account_number, holder_name) is a term on its own,
 *   and the words inside it don't count as single words;
 * - stop tokens (id, api, get, at, v2, ...) and leading qualifiers (old_, new_, max_) carry no
 *   meaning; words are made singular, so /accounts and account are one term.
 *
 * Interfaces count only when no endpoint record stands for them (a call to a service the
 * catalog can't read). Retired records don't count.
 */

export interface CodeUse {
  /** The record id; a schema field is `<schema id>#<field>`. */
  record: string;
  kind: string;
  name: string;
  evidence: EvidenceT;
}

export interface CodeTerm {
  key: string;
  /** Records that use the word, sorted by id. */
  uses: CodeUse[];
  /** Columns and schema fields whose whole name is this term (account_id is the account). */
  fields: string[];
  /** Column and field types seen for those fields, by field id. */
  types: Record<string, string>;
}

interface Named {
  record: string;
  kind: string;
  name: string;
  words: string[];
  compound?: string;
  single?: string;
  type?: string;
  isField: boolean;
  evidence: EvidenceT;
}

const firstEvidence = (r: CatalogRecord): EvidenceT => r.evidence[0]!;

function named(records: readonly CatalogRecord[]): Named[] {
  const out: Named[] = [];
  const endpointIds = new Set(records.filter((r) => r.kind === "Endpoint").map((r) => r.id));
  for (const r of records) {
    if (r.status === "retired") continue;
    if (r.kind === "Endpoint") {
      const e = r as RecordOf<"Endpoint">;
      out.push({
        record: e.id,
        kind: e.kind,
        name: e.pathOrTopic,
        words: businessWords(e.pathOrTopic),
        isField: false,
        evidence: firstEvidence(e),
      });
    } else if (r.kind === "Interface") {
      const i = r as RecordOf<"Interface">;
      if (i.endpoint && endpointIds.has(i.endpoint)) continue;
      out.push({
        record: i.id,
        kind: i.kind,
        name: i.normalizedPath,
        words: businessWords(i.normalizedPath),
        isField: false,
        evidence: firstEvidence(i),
      });
    } else if (r.kind === "Table") {
      const t = r as RecordOf<"Table">;
      const compound = compoundOf(t.name);
      const single = compound ? undefined : singleOf(t.name);
      out.push({
        record: t.id,
        kind: t.kind,
        name: t.name,
        words: businessWords(t.name),
        ...(compound ? { compound } : {}),
        ...(single ? { single } : {}),
        isField: false,
        evidence: firstEvidence(t),
      });
    } else if (r.kind === "Column") {
      const c = r as RecordOf<"Column">;
      const compound = compoundOf(c.name);
      const single = compound ? undefined : singleOf(c.name);
      out.push({
        record: c.id,
        kind: c.kind,
        name: c.name,
        words: businessWords(c.name),
        ...(compound ? { compound } : {}),
        ...(single ? { single } : {}),
        type: c.type,
        isField: true,
        evidence: firstEvidence(c),
      });
    } else if (r.kind === "Schema") {
      const s = r as RecordOf<"Schema">;
      for (const f of s.fields) {
        const compound = compoundOf(f.name);
        const single = compound ? undefined : singleOf(f.name);
        out.push({
          record: `${s.id}#${f.name}`,
          kind: "SchemaField",
          name: f.name,
          words: businessWords(f.name),
          ...(compound ? { compound } : {}),
          ...(single ? { single } : {}),
          ...(f.type ? { type: f.type } : {}),
          isField: true,
          evidence: firstEvidence(s),
        });
      }
    }
  }
  return out.sort((a, b) => (a.record < b.record ? -1 : a.record > b.record ? 1 : 0));
}

/** The terms the code uses, by term key. `aliasOf` maps another name's key to a term's key. */
export function codeTerms(
  records: readonly CatalogRecord[],
  aliasOf: (key: string) => string = (k) => k,
): Map<string, CodeTerm> {
  const items = named(records);
  // A word inside a compound name (holder in holder_name) belongs to that compound term, so
  // it doesn't count towards a single-word term.
  const byWord = new Map<string, Set<string>>();
  for (const n of items)
    if (!n.compound)
      for (const w of new Set(n.words)) byWord.set(w, (byWord.get(w) ?? new Set()).add(n.record));
  const tableWords = new Set(
    items.filter((n) => n.kind === "Table" && n.single).map((n) => n.single!),
  );
  const keys = new Set<string>();
  for (const [w, recs] of byWord) if (recs.size >= 2 || tableWords.has(w)) keys.add(w);
  for (const n of items) if (n.compound) keys.add(n.compound);

  const out = new Map<string, CodeTerm>();
  const get = (key: string) => {
    const k = aliasOf(key);
    let t = out.get(k);
    if (!t) {
      t = { key: k, uses: [], fields: [], types: {} };
      out.set(k, t);
    }
    return t;
  };
  for (const key of [...keys].sort()) {
    for (const n of items) {
      const usesWord = !key.includes(" ") && !n.compound && n.words.includes(key);
      const isWhole = n.compound === key || (!n.compound && n.single === key);
      if (!usesWord && !isWhole) continue;
      const t = get(key);
      if (!t.uses.some((u) => u.record === n.record))
        t.uses.push({ record: n.record, kind: n.kind, name: n.name, evidence: n.evidence });
      if (n.isField && isWhole && !t.fields.includes(n.record)) {
        t.fields.push(n.record);
        if (n.type) t.types[n.record] = n.type;
      }
    }
  }
  // A name that is another name of a term (an alias decision) counts for that term too.
  for (const n of items) {
    const whole = n.compound ?? n.single;
    if (!n.isField || !whole) continue;
    const k = aliasOf(whole);
    if (k === whole) continue;
    const t = get(whole);
    if (!t.fields.includes(n.record)) {
      t.fields.push(n.record);
      if (n.type) t.types[n.record] = n.type;
    }
    if (!t.uses.some((u) => u.record === n.record))
      t.uses.push({ record: n.record, kind: n.kind, name: n.name, evidence: n.evidence });
  }
  for (const t of out.values()) {
    t.uses.sort((a, b) => (a.record < b.record ? -1 : a.record > b.record ? 1 : 0));
    t.fields.sort();
  }
  return out;
}

/** Every column and schema field, for naming hints. */
export function fieldNames(records: readonly CatalogRecord[]): { record: string; name: string }[] {
  return named(records)
    .filter((n) => n.isField)
    .map((n) => ({ record: n.record, name: n.name }));
}
