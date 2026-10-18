import { parse, stringify } from "yaml";
import { parseRecord, type CatalogRecord, type ParseResult } from "./catalog.js";

/** Keys printed first, in this order; everything else follows alphabetically. */
const LEADING_KEYS = ["schemaVersion", "kind", "id", "status", "confidence"];

function keyComparator(leading: readonly string[]) {
  return (a: string, b: string): number => compareKeys(a, b, leading);
}

function compareKeys(a: string, b: string, leading: readonly string[] = LEADING_KEYS): number {
  const ia = leading.indexOf(a);
  const ib = leading.indexOf(b);
  if (ia !== -1 || ib !== -1) {
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Recursively drop undefined values and order object keys canonically. Arrays keep their order. */
export function canonicalize(value: unknown, leading: readonly string[] = LEADING_KEYS): unknown {
  if (Array.isArray(value)) return value.map((v) => canonicalize(v, leading));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(keyComparator(leading))) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonicalize(v, leading);
    }
    return out;
  }
  return value;
}

/**
 * Canonical YAML for a record: fixed key order, two-space indent, no line folding,
 * LF line endings and exactly one trailing newline. Serializing the parsed output
 * again gives byte-identical text, so diffs only ever show real changes.
 */
export function serializeRecord(record: CatalogRecord): string {
  return toCanonicalYaml(record);
}

/**
 * Canonical YAML for any Atticus file (records, repos files, org-pack files): keys in
 * `leading` first in that order, the rest alphabetical; same formatting as records.
 */
export function toCanonicalYaml(value: unknown, leading: readonly string[] = LEADING_KEYS): string {
  const text = stringify(canonicalize(value, leading), {
    indent: 2,
    lineWidth: 0,
    minContentWidth: 0,
    sortMapEntries: false,
    defaultStringType: "PLAIN",
    defaultKeyType: "PLAIN",
    aliasDuplicateObjects: false,
  });
  return text.replace(/\r\n/g, "\n").replace(/\n*$/, "\n");
}

/** Parse YAML text and validate it as a catalog record. Never throws. */
export function deserializeRecord(text: string): ParseResult {
  let data: unknown;
  try {
    data = parse(text, { prettyErrors: true });
  } catch (err) {
    return {
      ok: false,
      issues: [{ path: "", message: `invalid YAML: ${(err as Error).message}` }],
    };
  }
  return parseRecord(data);
}
