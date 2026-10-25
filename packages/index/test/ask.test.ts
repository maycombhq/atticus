import { describe, expect, it } from "vitest";
import { askLookup, OUTSIDE, translate } from "../src/ask.js";

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

  it("searches for the outside system a question names, never every interface (2026-10-25)", () => {
    const outside = (w: string) => (w === "llm" ? { id: "llm", kind: OUTSIDE } : lookup(w));
    for (const q of ["what calls the LLM?", "Who calls llm", "what breaks if the llm changes?"])
      expect(translate(q, outside)).toMatchObject({
        action: "query",
        query: "kind:interface to:llm",
      });
    // "What does X call" is still what X calls.
    expect(translate("What does portal-bff call?", outside).query).toBe(
      "kind:interface from:portal-bff",
    );
    expect(translate("what calls ledger-api", outside).query).toBe("kind:interface to:ledger-api");
  });

  it("looks a word up as a record, an outside system the calls name, or a table's name", () => {
    const ix = {
      find: (id: string) => (id === "ledger-api" ? [{ id, kind: "Component" }] : []),
      query: (q: string) => {
        if (q === "kind:interface to:llm")
          return { rows: [{ id: "if-1", kind: "Interface" }], total: 1 };
        if (q === "kind:table name:note")
          return { rows: [{ id: "studio-db.note", kind: "Table" }], total: 1 };
        return { rows: [], total: 0 };
      },
    };
    const look = askLookup(ix);
    expect(look("ledger-api")).toEqual({ id: "ledger-api", kind: "Component" });
    expect(look("llm")).toEqual({ id: "llm", kind: OUTSIDE });
    expect(look("note")).toEqual({ id: "studio-db.note", kind: "Table" });
    expect(look("the")).toBeUndefined();
    // A word the query language would read as an operator is never looked up as one.
    expect(look('a"b')).toBeUndefined();
  });

  it("says what it couldn't place when a question names nothing in the catalog", () => {
    const t = translate("what breaks if the moon changes", lookup);
    expect(t.action).toBe("query");
    expect(t.explanation).toMatch(/no record/i);
  });
});
