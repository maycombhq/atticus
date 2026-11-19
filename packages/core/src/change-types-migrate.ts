import { keepLineEndings } from "./eol.js";
import { isMap, isSeq, parseDocument } from "yaml";
import { QUICK_CHANGE_TYPE } from "./orgpack-defaults.js";
import { CHANGE_TYPES_SCHEMA_VERSION, ChangeTypes } from "./schema/orgpack.js";

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
  return { text: keepLineEndings(text, doc.toString({ lineWidth: 0 })), changed: true };
}

/** The quick type's entry on one line, for a person to add to a list written that way. */
export const QUICK_ENTRY_ONE_LINE = `{ id: ${QUICK_CHANGE_TYPE.id}, name: ${QUICK_CHANGE_TYPE.name}, phases: [${QUICK_CHANGE_TYPE.phases.join(", ")}], artifacts: [${QUICK_CHANGE_TYPE.artifacts.join(", ")}], lenses: [${QUICK_CHANGE_TYPE.lenses.map((l) => (l === "true" ? '"true"' : l)).join(", ")}] }`;

/** The quick type's entry as it is written into a change-types.yaml, at no indent (ADR 0201). */
const QUICK_ENTRY = [
  `- id: ${QUICK_CHANGE_TYPE.id}`,
  `  name: ${QUICK_CHANGE_TYPE.name}`,
  `  description: ${JSON.stringify(QUICK_CHANGE_TYPE.description)}`,
  `  phases: [${QUICK_CHANGE_TYPE.phases.join(", ")}]`,
  `  artifacts: [${QUICK_CHANGE_TYPE.artifacts.join(", ")}]`,
  `  lenses: [${QUICK_CHANGE_TYPE.lenses.map((l) => (l === "true" ? '"true"' : l)).join(", ")}]`,
];

/**
 * Add the quick change type (ADR 0201) at the end of a change-types.yaml's `types`. The entry is
 * put into the text after the list's last line, at the list's own indent and line endings, so
 * comments and every other entry stay byte for byte. Unchanged when the file doesn't read as
 * change types or already has a type `quick`; when it keeps its types on one line, `why` says so.
 */
export function addQuickTypeText(text: string): {
  text: string;
  changed: boolean;
  /** Unchanged because the list is a flow sequence (`types: [ … ]`): a person adds the entry. */
  why?: "one-line";
} {
  const same: ReturnType<typeof addQuickTypeText> = { text, changed: false };
  const doc = parseDocument(text);
  if (doc.errors.length || !ChangeTypes.safeParse(doc.toJS()).success) return same;
  const types = doc.get("types");
  if (!isSeq(types) || !types.range) return same;
  if (types.items.some((t) => isMap(t) && t.get("id") === QUICK_CHANGE_TYPE.id)) return same;
  if (types.flow) return { ...same, why: "one-line" };
  // The list's indent: what stands before its first dash on that line.
  const lineStart = text.lastIndexOf("\n", types.range[0] - 1) + 1;
  const indent = /^[ ]*/.exec(text.slice(lineStart))![0];
  // After the line the list's last value ends on (a comment on that line stays with it).
  const at = text.indexOf("\n", types.range[1] - 1);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const entry = QUICK_ENTRY.map((l) => `${indent}${l}${eol}`).join("");
  const out =
    at < 0 ? `${text}${eol}${entry}` : `${text.slice(0, at + 1)}${entry}${text.slice(at + 1)}`;
  const ok = ChangeTypes.safeParse(parseDocument(out).toJS());
  return ok.success && ok.data.types.at(-1)?.id === QUICK_CHANGE_TYPE.id
    ? { text: out, changed: true }
    : same;
}
