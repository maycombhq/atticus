import { isMap, parseDocument } from "yaml";
import { CHANGE_TYPES_SCHEMA_VERSION } from "./schema/orgpack.js";

/**
 * change-types.yaml version 1 → 2 (ADR 0113). Version 2 adds a type's size, whether a brief may
 * say it is small, and the fast path's gate; a type that sets none of them is standard, as every
 * type was in version 1. So the migration only writes the new version and keeps the file's
 * comments and order: no type changes path until a person marks it small.
 */
export function migrateChangeTypesText(text: string): { text: string; changed: boolean } {
  const doc = parseDocument(text);
  if (!isMap(doc.contents) || doc.get("schemaVersion") !== 1) return { text, changed: false };
  doc.set("schemaVersion", CHANGE_TYPES_SCHEMA_VERSION);
  return { text: doc.toString(), changed: true };
}
