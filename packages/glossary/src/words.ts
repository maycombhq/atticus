import { identifierWords } from "@maycombhq/core";

/**
 * Words in names and terms. Deterministic and deliberately small: the glossary reads
 * identifiers (paths, topics, tables, columns, schema fields) and short term names, not prose.
 */

/** Tokens that carry no business meaning in an identifier. */
export const STOP_TOKENS = new Set([
  "a",
  "an",
  "and",
  "api",
  "at",
  "by",
  "create",
  "created",
  "delete",
  "for",
  "get",
  "id",
  "ids",
  "in",
  "is",
  "list",
  "of",
  "on",
  "or",
  "patch",
  "post",
  "put",
  "the",
  "to",
  "ts",
  "update",
  "updated",
  "uuid",
]);

/** Leading qualifiers dropped from a compound name: old_limit and new_limit are both "limit". */
export const QUALIFIERS = new Set([
  "cur",
  "curr",
  "current",
  "has",
  "max",
  "min",
  "new",
  "old",
  "prev",
  "previous",
]);

/** Split an identifier into lower-case words: camelCase, snake_case, kebab-case, dots and slashes. */
export const splitWords = (s: string): string[] => identifierWords(s);

/** A plural noun's singular, by plain English rules (accounts, entries, statuses, addresses). */
export function singular(w: string): string {
  if (w.length <= 3) return w;
  if (/ies$/.test(w)) return `${w.slice(0, -3)}y`;
  if (/(ss|us|is)$/.test(w)) return w;
  if (/(sses|shes|ches|xes|zes)$/.test(w)) return w.slice(0, -2);
  if (/ses$/.test(w)) return w.slice(0, -1);
  if (/s$/.test(w)) return w.slice(0, -1);
  return w;
}

const isNoise = (w: string) => STOP_TOKENS.has(w) || /^v\d+$/.test(w) || /^\d+$/.test(w);

/** The business words of an identifier: split, without stop tokens, version or number segments, singular. */
export function businessWords(s: string): string[] {
  return splitWords(s)
    .filter((w) => !isNoise(w))
    .map(singular);
}

/**
 * The compound term a column or field name stands for, or undefined: two or more business
 * words in a row once leading qualifiers and leading or trailing stop tokens are dropped
 * (account_number, holder_name, daily_limit). A stop token in the middle (changed_by_email)
 * means the name is a sentence, not a term.
 */
export function compoundOf(name: string): string | undefined {
  const w = splitWords(name).filter((x) => !/^\d+$/.test(x));
  while (w.length && (isNoise(w[0]!) || QUALIFIERS.has(w[0]!))) w.shift();
  while (w.length && isNoise(w.at(-1)!)) w.pop();
  if (w.length < 2 || w.some(isNoise)) return undefined;
  return [...w.slice(0, -1), singular(w.at(-1)!)].join(" ");
}

/** The single business word a name stands for (account_id → account), or undefined. */
export function singleOf(name: string): string | undefined {
  const w = businessWords(name).filter((x) => !QUALIFIERS.has(x));
  return w.length === 1 ? w[0] : undefined;
}

/** The comparison key of a term: lower case, words only, last word singular. */
export function termKey(term: string): string {
  const w = term
    .toLowerCase()
    .replace(/[`*_"'’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (!w.length) return "";
  return [...w.slice(0, -1), singular(w.at(-1)!)].join(" ");
}

/** The record id of a term: term.<slug of its key>. */
export function termId(term: string): string {
  return `term.${termKey(term).replace(/\s+/g, "-")}`.slice(0, 120);
}

/** A term as people write it: the first letter upper case, the rest as written. */
export function displayTerm(term: string): string {
  const t = term.trim().replace(/\s+/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Normalised definition text for comparing two definitions. */
export function definitionKey(d: string): string {
  return d
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
