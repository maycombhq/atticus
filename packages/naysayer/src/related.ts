import type { CatalogRecord, RecordKind } from "@maycombhq/core";
import type { CriticContext } from "./context.js";

/**
 * Which catalog records hold a fact about a subject. A Setting belongs to its component, an
 * Obligation to its system, a Table to its data store, and so on. A system also gathers its
 * components' facts, and a vendor (a system with no components of ours) gathers Settings that
 * target it.
 */
const OWNER_FIELDS: Partial<Record<RecordKind, string[]>> = {
  Component: ["system"],
  Endpoint: ["component"],
  Interface: ["from", "to"],
  Setting: ["component"],
  ObservabilityAsset: ["component"],
  Deployment: ["component"],
  QualityAsset: ["component"],
  Table: ["dataStore", "ownerComponent"],
  Column: ["table"],
  IndexConstraint: ["table"],
  Migration: ["dataStore"],
  DataStore: ["ownerComponent"],
  Obligation: ["system"],
  Party: ["systems"],
  OwnerQuestion: ["system"],
  FieldMapping: ["interface"],
  AccessGrant: ["subject"],
};

const TARGET_FIELDS: Partial<Record<RecordKind, string[]>> = { Setting: ["target"] };

const SYSTEM_LEVEL = new Set<RecordKind>(["System", "Obligation", "Party", "OwnerQuestion"]);

export function relatedRecords(
  ctx: CriticContext,
  kind: RecordKind,
  subject: string,
): CatalogRecord[] {
  const keys = new Set([subject]);
  const rec = ctx.byId.get(subject);
  const sys = ctx.systemOf(subject);
  const isSystem = sys === subject;
  if (isSystem)
    for (const r of ctx.records) if (r.kind === "Component" && r.system === subject) keys.add(r.id);
  if (!isSystem && sys && SYSTEM_LEVEL.has(kind)) keys.add(sys);
  if (rec?.kind === "DataStore" && rec.ownerComponent) keys.add(rec.ownerComponent);
  const fields = [...(OWNER_FIELDS[kind] ?? []), ...(isSystem ? (TARGET_FIELDS[kind] ?? []) : [])];
  return ctx.records.filter((r) => {
    if (r.kind !== kind) return false;
    const o = r as unknown as Record<string, unknown>;
    return fields.some((f) => {
      const v = o[f];
      return typeof v === "string"
        ? keys.has(v)
        : Array.isArray(v) && v.some((x) => typeof x === "string" && keys.has(x));
    });
  });
}

/** Whether a record has a value for a field (non-empty string, array or object). */
export function hasField(r: CatalogRecord, field: string): boolean {
  const v = (r as unknown as Record<string, unknown>)[field];
  if (v === undefined || v === null || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/** Records matching every key/value in `where` (string comparison). */
export function matchesWhere(r: CatalogRecord, where: Record<string, string>): boolean {
  const o = r as unknown as Record<string, unknown>;
  return Object.entries(where).every(([k, v]) => String(o[k] ?? "") === v);
}
