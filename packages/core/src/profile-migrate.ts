import { isMap, parseDocument } from "yaml";
import { PROFILE_SCHEMA_VERSION, PROFILE_TOPICS_VERSION } from "./schema/orgpack.js";

/**
 * profile.yaml moved up to the version a write needs (ADR 0162 amendment: 2 for a system's
 * `topics`; ADR 0204: 3 for the declared arrows, `links`). A file without what the new version
 * adds says what it said, so the step writes the new number only and keeps the file's comments,
 * order and line layout. Nothing is moved: which alias is a topic is a person's call. A version-1
 * or 2 profile stays valid, so `atticus upgrade` has no step for it; `addProfileSystem` applies
 * this when it writes a topic (to 2), `declareArrow` when it writes an arrow (to 3). A file at
 * `to` or above is left as it is.
 */
export function migrateProfileText(
  text: string,
  to: number = PROFILE_TOPICS_VERSION,
): { text: string; changed: boolean } {
  const doc = parseDocument(text);
  const at = isMap(doc.contents) ? doc.get("schemaVersion") : undefined;
  if (typeof at !== "number" || at >= to || to > PROFILE_SCHEMA_VERSION)
    return { text, changed: false };
  const line = new RegExp(`^schemaVersion:[ \\t]*${at}[ \\t]*(#.*)?$`, "m");
  if (line.test(text))
    return {
      text: text.replace(line, (_m, c?: string) => `schemaVersion: ${to}${c ? ` ${c}` : ""}`),
      changed: true,
    };
  doc.set("schemaVersion", to);
  return { text: doc.toString(), changed: true };
}
