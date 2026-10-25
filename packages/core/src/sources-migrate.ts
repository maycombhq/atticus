import { isMap, parseDocument } from "yaml";
import { SOURCES_SCHEMA_VERSION } from "./schema/orgpack.js";

/**
 * sources.yaml version 1 → 2. Version 2 adds a wiki's `include` and `exclude` globs; a wiki
 * that sets neither reads every page, as every wiki did in version 1. So the migration only
 * writes the new version and keeps the file's comments and order.
 */
export function migrateSourcesText(text: string): { text: string; changed: boolean } {
  const doc = parseDocument(text);
  if (!isMap(doc.contents) || doc.get("schemaVersion") !== 1) return { text, changed: false };
  doc.set("schemaVersion", SOURCES_SCHEMA_VERSION);
  return { text: doc.toString(), changed: true };
}
