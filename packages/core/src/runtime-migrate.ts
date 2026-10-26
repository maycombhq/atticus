import { isMap, parseDocument } from "yaml";
import { RUNTIME_SCHEMA_VERSION } from "./schema/orgpack.js";

/**
 * runtime.yaml version 1 → 2 (ADR 0121 addendum, per-step models). Version 2 adds a model per
 * kind of step (`models.read`, `draft`, `critic`, `knowledge`, `quick`); a file that names none
 * runs every step on the one model, as every step ran in version 1. So the migration only writes
 * the new version and keeps the file's comments and order: no step changes model until a person
 * names one. `models.recommended` stays as it is (the critic still reads `recommended.critic`).
 */
export function migrateRuntimeText(text: string): { text: string; changed: boolean } {
  const doc = parseDocument(text);
  if (!isMap(doc.contents) || doc.get("schemaVersion") !== 1) return { text, changed: false };
  // The number on its own line, so every other line stays exactly as the person wrote it (the
  // yaml library would space out flow lists); otherwise the document, written again.
  const line = /^schemaVersion:[ \t]*1[ \t]*(#.*)?$/m;
  if (line.test(text))
    return {
      text: text.replace(
        line,
        (_m, c?: string) => `schemaVersion: ${RUNTIME_SCHEMA_VERSION}${c ? ` ${c}` : ""}`,
      ),
      changed: true,
    };
  doc.set("schemaVersion", RUNTIME_SCHEMA_VERSION);
  return { text: doc.toString(), changed: true };
}
