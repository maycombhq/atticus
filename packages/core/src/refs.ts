import type { z } from "zod";
import type { CatalogRecord } from "./catalog.js";
import { Ref } from "./schema/common.js";
import { RECORD_SCHEMAS, type RecordKind } from "./schema/kinds.js";

/**
 * Where each record kind refers to other records, read from contract C1 itself: every field
 * typed `Ref` (alone, optional, in a list or inside a nested object). Paths use "." for nested
 * objects and "[]" for list items, e.g. `readers[]`, `references.table`, `links.systems[]`.
 */
function refPaths(schema: z.ZodType, path: string, out: string[]): void {
  if (schema === (Ref as z.ZodType)) {
    if (path !== "id") out.push(path);
    return;
  }
  const def = (schema as unknown as { _zod: { def: Record<string, unknown> } })._zod.def;
  switch (def.type) {
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "readonly":
      refPaths(def.innerType as z.ZodType, path, out);
      return;
    case "array":
      refPaths(def.element as z.ZodType, `${path}[]`, out);
      return;
    case "object":
      for (const [k, v] of Object.entries(def.shape as Record<string, z.ZodType>)) {
        if (path === "" && k === "evidence") continue;
        refPaths(v, path ? `${path}.${k}` : k, out);
      }
      return;
    default:
      return;
  }
}

const PATHS = new Map<RecordKind, string[]>(
  (Object.entries(RECORD_SCHEMAS) as [RecordKind, z.ZodType][]).map(([kind, s]) => {
    const out: string[] = [];
    refPaths(s, "", out);
    return [kind, out];
  }),
);

/** The reference fields of a record kind, e.g. Interface → from, to, endpoint, route. */
export function referenceFields(kind: RecordKind): string[] {
  return [...(PATHS.get(kind) ?? [])];
}

/** Every reference a record makes: the field path and the id it points at. */
export function recordReferences(record: CatalogRecord): { field: string; id: string }[] {
  const out: { field: string; id: string }[] = [];
  const visit = (value: unknown, parts: string[], field: string) => {
    if (value === undefined || value === null) return;
    if (parts.length === 0) {
      if (typeof value === "string") out.push({ field, id: value });
      return;
    }
    const [head, ...rest] = parts as [string, ...string[]];
    if (head.endsWith("[]")) {
      const v = (value as Record<string, unknown>)[head.slice(0, -2)];
      if (Array.isArray(v)) for (const item of v) visit(item, rest, field);
    } else visit((value as Record<string, unknown>)[head], rest, field);
  };
  for (const field of PATHS.get(record.kind) ?? []) {
    visit(record, field.split("."), field);
  }
  return out;
}
