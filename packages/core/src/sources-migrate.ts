import { isMap, parseDocument } from "yaml";
import { SOURCES_SCHEMA_VERSION } from "./schema/orgpack.js";

/**
 * sources.yaml moved up a version, changing nothing but the number and keeping the file's
 * comments and order. Version 2 (ADR 0127) adds a wiki's `include` and `exclude`, and a wiki with
 * neither reads every page, as in version 1. Version 3 (ADR 0130) adds authority, scope and the
 * export types, and a wiki with none of them ranks as a team's and applies everywhere: what every
 * page was before. So each step is the number only. By default every older version goes to the
 * current one; `from` and `to` take one step (`atticus upgrade`'s sources-v2 and sources-v3).
 */
export function migrateSourcesText(
  text: string,
  o: { from?: number; to?: number } = {},
): { text: string; changed: boolean } {
  const to = o.to ?? SOURCES_SCHEMA_VERSION;
  const doc = parseDocument(text);
  if (!isMap(doc.contents)) return { text, changed: false };
  const v = doc.get("schemaVersion");
  if (typeof v !== "number" || v >= to || (o.from !== undefined && v !== o.from))
    return { text, changed: false };
  doc.set("schemaVersion", to);
  return { text: doc.toString(), changed: true };
}
