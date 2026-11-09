import { isMap, parseDocument } from "yaml";
import { ROLES_SCHEMA_VERSION } from "./schema/orgpack.js";

/**
 * roles.yaml version 1 → 2 (ADR 0140) → 3 (ADR 0191). Version 2 adds `teams`, version 3 who
 * takes each role (`defaults`, a team's `roles`); a file without them names none, as before, so
 * the step writes the new number only and keeps the file's comments, order and line layout
 * (`atticus upgrade`'s roles-v2, which writes the current version).
 */
export function migrateRolesText(text: string): { text: string; changed: boolean } {
  const doc = parseDocument(text);
  const v = isMap(doc.contents) ? doc.get("schemaVersion") : undefined;
  if (v !== 1 && v !== 2) return { text, changed: false };
  const line = /^schemaVersion:[ \t]*[12][ \t]*(#.*)?$/m;
  if (line.test(text))
    return {
      text: text.replace(
        line,
        (_m, c?: string) => `schemaVersion: ${ROLES_SCHEMA_VERSION}${c ? ` ${c}` : ""}`,
      ),
      changed: true,
    };
  doc.set("schemaVersion", ROLES_SCHEMA_VERSION);
  return { text: doc.toString({ lineWidth: 0 }), changed: true };
}
