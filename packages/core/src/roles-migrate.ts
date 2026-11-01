import { isMap, parseDocument } from "yaml";
import { ROLES_SCHEMA_VERSION } from "./schema/orgpack.js";

/**
 * roles.yaml version 1 → 2 (ADR 0140). Version 2 adds `teams`; a file without them names no
 * team, as version 1 did, so the step writes the new number only and keeps the file's comments,
 * order and line layout (`atticus upgrade`'s roles-v2).
 */
export function migrateRolesText(text: string): { text: string; changed: boolean } {
  const doc = parseDocument(text);
  if (!isMap(doc.contents) || doc.get("schemaVersion") !== 1) return { text, changed: false };
  const line = /^schemaVersion:[ \t]*1[ \t]*(#.*)?$/m;
  if (line.test(text))
    return {
      text: text.replace(
        line,
        (_m, c?: string) => `schemaVersion: ${ROLES_SCHEMA_VERSION}${c ? ` ${c}` : ""}`,
      ),
      changed: true,
    };
  doc.set("schemaVersion", ROLES_SCHEMA_VERSION);
  return { text: doc.toString(), changed: true };
}
