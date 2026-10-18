import { RECORD_KINDS } from "@maycombhq/core";

/**
 * The catalog query language. A query is a list of terms, all of which must match:
 *
 *   field:value          the field equals the value (any item, for a list); case-insensitive
 *   field:a,b            either value
 *   field:pre*           * matches any run of characters
 *   a.b:value            a nested field, e.g. pattern.code:S.GW.SOR
 *   has:field            the field is set (a list: not empty)
 *   missing:field        the field is not set
 *   refs:id              the record refers to id (any reference field)
 *   refby:id             the record is referred to by id
 *   word, "two words"    id or name contains the text
 *   -term                any term, negated
 *
 * `kind` matches record kinds by name, any case (kind:interface). `system` matches the
 * system a record belongs to, worked out by the index (a component's, an interface's caller's).
 */
export type Term =
  | { neg: boolean; type: "field"; field: string; values: string[] }
  | { neg: boolean; type: "has" | "missing"; field: string }
  | { neg: boolean; type: "refs" | "refby"; values: string[] }
  | { neg: boolean; type: "text"; values: string[] };

export class QueryError extends Error {
  constructor(
    message: string,
    readonly at: number,
  ) {
    super(message);
    this.name = "QueryError";
  }
}

const FIELD = /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$/;
const KINDS = new Map(RECORD_KINDS.map((k) => [k.toLowerCase(), k]));

/** The record kind a `kind:` value names, or undefined. */
export function kindNamed(value: string): string | undefined {
  return KINDS.get(value.toLowerCase());
}

/** Split into tokens on spaces outside quotes; each keeps where it started. */
function tokens(text: string): { text: string; at: number }[] {
  const out: { text: string; at: number }[] = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (i >= text.length) break;
    const at = i;
    let quoted = false;
    let t = "";
    while (i < text.length && (quoted || !/\s/.test(text[i]!))) {
      if (text[i] === '"') quoted = !quoted;
      t += text[i];
      i++;
    }
    if (quoted)
      throw new QueryError(`A quoted value starting at ${at + 1} has no closing quote`, at);
    out.push({ text: t, at });
  }
  return out;
}

/** Split a value list on commas outside quotes and drop the quotes. */
function values(raw: string): string[] {
  const out: string[] = [];
  let quoted = false;
  let cur = "";
  for (const c of raw) {
    if (c === '"') quoted = !quoted;
    else if (c === "," && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.filter((v) => v !== "");
}

export function parseQuery(text: string): Term[] {
  const terms: Term[] = [];
  for (const tok of tokens(text)) {
    let t = tok.text;
    const neg = t.startsWith("-");
    if (neg) t = t.slice(1);
    if (t === "") throw new QueryError(`There is nothing after "-" at ${tok.at + 1}`, tok.at);
    const colon = t.startsWith('"') ? -1 : t.indexOf(":");
    if (colon < 0) {
      terms.push({ neg, type: "text", values: values(t) });
      continue;
    }
    const name = t.slice(0, colon);
    const rest = t.slice(colon + 1);
    if (name === "has" || name === "missing") {
      if (rest === "") throw new QueryError(`"${name}:" needs a field, e.g. ${name}:owner`, tok.at);
      if (!FIELD.test(rest))
        throw new QueryError(
          `"${rest}" is not a field: field names are letters and digits, with "." for nested fields`,
          tok.at,
        );
      terms.push({ neg, type: name, field: rest });
      continue;
    }
    const vs = values(rest);
    if (vs.length === 0)
      throw new QueryError(`"${name}:" needs a value, e.g. ${name}:something`, tok.at);
    if (name === "refs" || name === "refby") {
      terms.push({ neg, type: name, values: vs });
      continue;
    }
    if (!FIELD.test(name))
      throw new QueryError(
        `"${name}" is not a field: field names are letters and digits, with "." for nested fields`,
        tok.at,
      );
    if (name === "kind")
      for (const v of vs)
        if (!v.includes("*") && !kindNamed(v))
          throw new QueryError(`Unknown kind "${v}". Kinds: ${RECORD_KINDS.join(", ")}`, tok.at);
    terms.push({ neg, type: "field", field: name, values: vs });
  }
  return terms;
}

/** A GLOB pattern (case already lowered) where only * is special. */
function glob(v: string): string {
  return v.toLowerCase().replace(/[[?]/g, (c) => `[${c}]`);
}

const VALUE = `lower(CASE je.type WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' ELSE CAST(je.value AS TEXT) END)`;

/** Turn parsed terms into a WHERE clause over `records r` with its parameters. */
export function compileQuery(terms: Term[]): { where: string; params: (string | number)[] } {
  const parts: string[] = [];
  const params: (string | number)[] = [];
  for (const t of terms) {
    let sql: string;
    if (t.type === "field" && t.field === "kind") {
      const ors = t.values.map((v) => {
        params.push(glob(v));
        return "lower(r.kind) GLOB ?";
      });
      sql = `(${ors.join(" OR ")})`;
    } else if (t.type === "field" && t.field === "system") {
      const ors = t.values.map((v) => {
        params.push(glob(v));
        return "lower(coalesce(r.system, '')) GLOB ?";
      });
      sql = `(${ors.join(" OR ")})`;
    } else if (t.type === "field") {
      params.push(`$.${t.field}`);
      const ors = t.values.map((v) => {
        params.push(glob(v));
        return `${VALUE} GLOB ?`;
      });
      sql = `EXISTS (SELECT 1 FROM json_each(r.json, ?) je WHERE ${ors.join(" OR ")})`;
    } else if (t.type === "has" || t.type === "missing") {
      params.push(`$.${t.field}`);
      sql = `EXISTS (SELECT 1 FROM json_each(r.json, ?) je WHERE je.type <> 'null')`;
      if (t.type === "missing") sql = `NOT ${sql}`;
    } else if (t.type === "refs") {
      sql = `EXISTS (SELECT 1 FROM refs x WHERE x.from_kind = r.kind AND x.from_id = r.id AND x.to_id IN (${t.values.map(() => "?").join(", ")}))`;
      params.push(...t.values);
    } else if (t.type === "refby") {
      sql = `EXISTS (SELECT 1 FROM refs x WHERE x.to_id = r.id AND x.from_id IN (${t.values.map(() => "?").join(", ")}))`;
      params.push(...t.values);
    } else {
      const ors = (t as Extract<Term, { type: "text" }>).values.map((v) => {
        params.push(`%${v.toLowerCase()}%`, `%${v.toLowerCase()}%`);
        return "(lower(r.id) LIKE ? OR lower(r.name) LIKE ?)";
      });
      sql = `(${ors.join(" OR ")})`;
    }
    parts.push(t.neg ? `NOT ${sql}` : sql);
  }
  return { where: parts.length > 0 ? parts.join(" AND ") : "1", params };
}
