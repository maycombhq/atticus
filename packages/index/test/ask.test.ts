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
    [
      "interfaces seen at one end",
      {
        action: "query",
        query: "kind:interface confidence:inferred -flags:joined-by-person",
      },
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

  it("reads who consumes a topic as the impact walk: an event Interface's `to` is the subscriber (ADR 0201)", () => {
    const withTopic = (w: string) =>
      w === "topic.transfers-completed" ? { id: w, kind: "Endpoint" } : lookup(w);
    for (const q of [
      "who consumes topic.transfers-completed?",
      "Who subscribes to topic.transfers-completed",
      "who receives topic.transfers-completed?",
      "who listens to topic.transfers-completed",
      "who is listening to the topic topic.transfers-completed?",
    ])
      expect(translate(q, withTopic), q).toEqual({
        action: "impact",
        id: "topic.transfers-completed",
        query: "impact topic.transfers-completed",
        explanation:
          "Read as: who receives topic.transfers-completed: the receivers first, then what a change reaches past them.",
        // The answer is the receivers, apart from what the walk reaches past them (b30 proof run).
        receivers: true,
      });
    // A component's consumers are still its callers.
    expect(translate("who consumes ledger-api", withTopic).query).toBe(
      "kind:interface to:ledger-api",
    );
  });

  it("finds a topic by its name, marked so: only the consumers question uses it", () => {
    const look = askLookup({
      find: () => [],
      query: (q: string) =>
        q === "kind:endpoint endpointType:event-topic pathOrTopic:transfers.completed"
          ? { rows: [{ id: "topic.transfers-completed", kind: "Endpoint" }] }
          : { rows: [] },
    });
    expect(look("transfers.completed")).toEqual({
      id: "topic.transfers-completed",
      kind: "Endpoint",
      byName: true,
    });
    expect(look("transfers.started")).toBeUndefined();
    // By name it answers who receives the topic, and changes no other reading.
    expect(translate("who consumes the topic transfers.completed?", look)).toMatchObject({
      action: "impact",
      id: "topic.transfers-completed",
    });
    expect(translate("what breaks if transfers.completed changes", look)).toMatchObject({
      action: "query",
      query: "breaks transfers.completed changes",
    });
    expect(translate("list interfaces for transfers.completed", look).query).toBe("kind:interface");
  });

  it("never lists every interface for who calls a name the map lacks (ADR 0201)", () => {
    for (const [q, name] of [
      ["who calls forge-portal?", "forge-portal"],
      ["what calls the quillfeather service", "quillfeather"],
    ] as const) {
      const t = translate(q, lookup);
      expect(t, q).toMatchObject({ action: "query", query: `kind:interface to:${name}` });
      expect(t.explanation).toBe(
        `Read as: the interfaces whose callee is ${name}. ${name} is not in the map: planned or not read.`,
      );
    }
  });

  it("says the map's fault, never \"planned or not read\", where the map couldn't be read (review)", () => {
    const fault = "The map holds no records in this metarepo yet.";
    const t = translate("who calls forge-portal?", lookup, () => fault);
    expect(t).toEqual({
      action: "query",
      query: "kind:interface to:forge-portal",
      explanation: `Read as: the interfaces whose callee is forge-portal. ${fault}`,
      fault,
    });
    // A map that was read whole has no fault: the name is planned or not read.
    const ok = translate("who calls forge-portal?", lookup, () => undefined);
    expect(ok.explanation).toMatch(/forge-portal is not in the map: planned or not read\.$/);
    expect(ok).not.toHaveProperty("fault");
    // The fault is asked for only when a name is missing.
    let asked = 0;
    translate("who calls ledger-api?", lookup, () => (asked++, fault));
    expect(asked).toBe(0);
  });

  it("keeps every older reading: a way, a kind or a tag is never taken for a missing name", () => {
    for (const [q, query] of [
      ["what calls the gateway", "kind:interface via:gateway"],
      ["which interfaces use the gateway", "kind:interface via:gateway"],
      ["which interfaces use the event bus", "kind:interface via:event-bus"],
      ["who uses pii", "kind:column classification:personal*"],
      ["what calls are inferred?", "kind:interface confidence:inferred"],
      ["which calls go through the gateway", "kind:interface via:gateway"],
      ["which interfaces use quillfeather", "kind:interface"],
      ["who uses forge-portal", "uses forge-portal"],
    ] as const)
      expect(translate(q, lookup).query, q).toBe(query);
    // One reading did change (b30 proof run): a topic the map lacks is said to be missing, where
    // it was a word search that found nothing.
    expect(translate("who consumes the topic forge.orders.shipped?", lookup)).toMatchObject({
      query: "kind:endpoint pathOrTopic:forge.orders.shipped",
      explanation:
        "Read as: who receives forge.orders.shipped. forge.orders.shipped is not in the map: planned or not read.",
    });
  });

  it("says what it couldn't place when a question names nothing in the catalog", () => {
    const t = translate("what breaks if the moon changes", lookup);
    expect(t.action).toBe("query");
    expect(t.explanation).toMatch(/no record/i);
  });
});
