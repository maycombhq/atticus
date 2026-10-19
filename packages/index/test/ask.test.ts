import { describe, expect, it } from "vitest";
import { translate } from "../src/ask.js";

/** A tiny catalog: what each id is. */
const KINDS: Record<string, string> = {
  "ledger-api": "Component",
  "portal-bff": "Component",
  ledger: "System",
  "ledger-db.entry": "Table",
  "ledger-db.account": "Table",
};
const lookup = (w: string) => (KINDS[w] ? { id: w, kind: KINDS[w] } : undefined);

describe("Ask: plain questions become catalog queries, and the query is always shown", () => {
  it.each([
    ["What breaks if ledger-db.account changes?", { action: "impact", id: "ledger-db.account" }],
    ["what is affected by a change to ledger-api", { action: "impact", id: "ledger-api" }],
    ["Who calls ledger-api?", { action: "query", query: "kind:interface to:ledger-api" }],
    [
      "who reads the ledger-db.entry table",
      { action: "query", query: "refby:ledger-db.entry kind:component" },
    ],
    ["What does portal-bff call?", { action: "query", query: "kind:interface from:portal-bff" }],
    ["Who owns ledger-api", { action: "owner", id: "ledger-api" }],
    [
      "show gateway interfaces without a pattern",
      { action: "query", query: "kind:interface via:gateway missing:pattern" },
    ],
    ["list the tables in ledger", { action: "query", query: "kind:table system:ledger" }],
    [
      "personal data in ledger",
      { action: "query", query: "kind:column system:ledger classification:personal*" },
    ],
    ["daily transfer limit", { action: "query", query: "daily transfer limit" }],
  ])("%s", (q, want) => {
    const t = translate(q, lookup);
    expect(t).toMatchObject(want);
    expect(t.explanation.length).toBeGreaterThan(10);
  });

  it("says what it couldn't place when a question names nothing in the catalog", () => {
    const t = translate("what breaks if the moon changes", lookup);
    expect(t.action).toBe("query");
    expect(t.explanation).toMatch(/no record/i);
  });
});
