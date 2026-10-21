import { isMap, isSeq, parseDocument, type YAMLMap } from "yaml";
import { GATES_SCHEMA_VERSION } from "./schema/orgpack.js";

/**
 * gates.yaml version 1 → 2 (ADR 0087). Version 2 reads a gate with no maxAuthorRounds as
 * unlimited; version 1 read it as two rounds. So that nothing loosens without a person
 * choosing it, the migration writes `maxAuthorRounds: 2` on every gate that left it out, and
 * keeps the file's comments and order. Deleting that line afterwards makes the gate unlimited.
 */
export function migrateGatesText(text: string): { text: string; changed: boolean } {
  const doc = parseDocument(text);
  if (!isMap(doc.contents) || doc.get("schemaVersion") !== 1) return { text, changed: false };
  doc.set("schemaVersion", GATES_SCHEMA_VERSION);
  const gates = doc.get("gates");
  if (isSeq(gates))
    for (const g of gates.items)
      if (isMap(g) && !g.has("maxAuthorRounds"))
        (g as YAMLMap<string, unknown>).set("maxAuthorRounds", 2);
  return { text: doc.toString(), changed: true };
}
