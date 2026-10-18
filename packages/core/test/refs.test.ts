import { describe, expect, it } from "vitest";
import {
  RECORD_KINDS,
  recordReferences,
  referenceFields,
  type CatalogRecord,
} from "../src/index.js";
import { EXAMPLES } from "./examples.js";

describe("reference fields read from contract C1", () => {
  it("lists every Ref field, nested and in lists, but never the record's own id", () => {
    expect(referenceFields("Interface")).toEqual(["from", "to", "endpoint", "route"]);
    expect(referenceFields("Table")).toEqual([
      "dataStore",
      "ownerComponent",
      "readers[]",
      "writers[]",
    ]);
    expect(referenceFields("IndexConstraint")).toEqual(["table", "references.table"]);
    expect(referenceFields("Decision")).toEqual(["links.interfaces[]", "links.systems[]"]);
    expect(referenceFields("System")).toEqual([]);
    for (const k of RECORD_KINDS) expect(referenceFields(k)).not.toContain("id");
  });

  it("reads the references a record makes", () => {
    const refs = recordReferences(EXAMPLES.Interface as CatalogRecord);
    expect(refs).toEqual([
      { field: "from", id: "portal-bff" },
      { field: "to", id: "ledger-api" },
      { field: "route", id: "gw-ledger-v1" },
    ]);
    const t = { ...EXAMPLES.Table, readers: ["a", "b"], writers: ["a"] } as CatalogRecord;
    expect(
      recordReferences(t).filter((r) => r.field !== "dataStore" && r.field !== "ownerComponent"),
    ).toEqual([
      { field: "readers[]", id: "a" },
      { field: "readers[]", id: "b" },
      { field: "writers[]", id: "a" },
    ]);
  });
});
