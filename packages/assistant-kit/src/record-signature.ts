import type { CatalogRecord } from "@maycombhq/core";

/** What a record says, for comparing a draft with the reference: its kind and its facts. */
const KEY_FIELDS: Record<string, string[]> = {
  GatewayRoute: ["basepath", "target"],
  Endpoint: ["component", "endpointType", "method", "pathOrTopic"],
  Unresolved: ["unresolvedKind", "raw"],
  Interface: ["from", "to", "method", "normalizedPath"],
  Setting: ["component", "key", "valueOrRef"],
  Table: ["dataStore", "name"],
  Column: ["table", "name"],
};
const IGNORED = new Set(["id", "evidence", "schemaVersion", "status", "confidence"]);

export function recordSignature(r: CatalogRecord): string {
  const x = r as unknown as Record<string, unknown>;
  const fields =
    KEY_FIELDS[r.kind] ??
    Object.keys(x)
      .filter((k) => !IGNORED.has(k) && k !== "kind")
      .sort();
  return `${r.kind} ${fields.map((f) => `${f}=${JSON.stringify(x[f] ?? null)}`).join(" ")}`;
}
