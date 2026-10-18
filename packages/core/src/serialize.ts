import { parse, stringify } from "yaml";
import { parseRecord, type CatalogRecord, type ParseResult } from "./catalog.js";

/** Keys printed first, in this order; everything else follows alphabetically. */
const LEADING_KEYS = ["schemaVersion", "kind", "id", "status", "confidence"];

function compareKeys(a: string, b: string): number {
  const ia = LEADING_KEYS.indexOf(a);
  const ib = LEADING_KEYS.indexOf(b);
  if (ia !== -1 || ib !== -1) {
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Recursively drop undefined values and order object keys canonically. Arrays keep their order. */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(compareKeys)) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonicalize(v);
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
  const text = stringify(canonicalize(record), {
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
