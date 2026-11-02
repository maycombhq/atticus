import { isMap, parseDocument } from "yaml";
import { PROFILE_SCHEMA_VERSION } from "./schema/orgpack.js";

/**
 * profile.yaml version 1 → 2 (ADR 0162 amendment). Version 2 adds a system's `topics`; a file
 * without them names no topic, as version 1 did, so the step writes the new number only and keeps
 * the file's comments, order and line layout. Nothing is moved from `aliases` to `topics`: which
 * alias is a topic is a person's call. A version-1 profile stays valid, so `atticus upgrade` has no
 * step for it; `addProfileSystem` applies this when it writes a topic.
 */
export function migrateProfileText(text: string): { text: string; changed: boolean } {
  const doc = parseDocument(text);
  if (!isMap(doc.contents) || doc.get("schemaVersion") !== 1) return { text, changed: false };
  const line = /^schemaVersion:[ \t]*1[ \t]*(#.*)?$/m;
  if (line.test(text))
    return {
      text: text.replace(
        line,
        (_m, c?: string) => `schemaVersion: ${PROFILE_SCHEMA_VERSION}${c ? ` ${c}` : ""}`,
      ),
      changed: true,
    };
  doc.set("schemaVersion", PROFILE_SCHEMA_VERSION);
  return { text: doc.toString(), changed: true };
}
