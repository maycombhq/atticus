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
  /** All of the record's evidence (a join's names each repo it joins). */
  all?: EvidenceT[];
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
  all: EvidenceT[];
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
        all: e.evidence,
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
        all: i.evidence,
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
        all: t.evidence,
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
        all: c.evidence,
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
          all: s.evidence,
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
  // The records each term's uses and fields hold already (ADR 0195 point 9: a search of the
  // list for each use was quadratic in a big estate).
  const usesOf = new Map<CodeTerm, Set<string>>();
  const fieldsOf = new Map<CodeTerm, Set<string>>();
  const get = (key: string) => {
    const k = aliasOf(key);
    let t = out.get(k);
    if (!t) {
      t = { key: k, uses: [], fields: [], types: {} };
      out.set(k, t);
      usesOf.set(t, new Set());
      fieldsOf.set(t, new Set());
    }
    return t;
  };
  const addUse = (t: CodeTerm, n: Named) => {
    const seen = usesOf.get(t)!;
    if (seen.has(n.record)) return;
    seen.add(n.record);
    t.uses.push({ record: n.record, kind: n.kind, name: n.name, evidence: n.evidence, all: n.all });
  };
  const addField = (t: CodeTerm, n: Named) => {
    const seen = fieldsOf.get(t)!;
    if (seen.has(n.record)) return;
    seen.add(n.record);
    t.fields.push(n.record);
    if (n.type) t.types[n.record] = n.type;
  };
  // The items each key can match, by their place in `items`: those whose words hold it (a
  // name with no compound) and those it is the whole name of. Each key looks at those only,
  // in the order of `items`, as a pass over all of them would.
  const byWordAt = new Map<string, number[]>();
  const byWholeAt = new Map<string, number[]>();
  const at = (m: Map<string, number[]>, k: string, x: number) => {
    const l = m.get(k);
    if (l) {
      if (l[l.length - 1] !== x) l.push(x);
    } else m.set(k, [x]);
  };
  items.forEach((n, x) => {
    if (!n.compound) for (const w of n.words) at(byWordAt, w, x);
    if (n.compound) at(byWholeAt, n.compound, x);
    else if (n.single !== undefined) at(byWholeAt, n.single, x);
  });
  for (const key of [...keys].sort()) {
    const word = key.includes(" ") ? [] : (byWordAt.get(key) ?? []);
    const whole = byWholeAt.get(key) ?? [];
    const candidates = whole.length
      ? [...new Set([...word, ...whole])].sort((a, b) => a - b)
      : word;
    for (const x of candidates) {
      const n = items[x]!;
      const isWhole = n.compound === key || (!n.compound && n.single === key);
      const t = get(key);
      addUse(t, n);
      if (n.isField && isWhole) addField(t, n);
    }
  }
  // A name that is another name of a term (an alias decision) counts for that term too.
  for (const n of items) {
    const whole = n.compound ?? n.single;
    if (!n.isField || !whole) continue;
    const k = aliasOf(whole);
    if (k === whole) continue;
    const t = get(whole);
    addField(t, n);
    addUse(t, n);
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
