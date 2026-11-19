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

  /** An index of a repo's components and a topic's consumers' Endpoints, as the field has them. */
  const fieldIndex = (o: {
    components?: Record<string, string[]>;
    topics?: Record<string, string[]>;
  }) => ({
    find: () => [],
    query: (q: string) => {
      const repo = /^kind:component repo:(\S+)$/.exec(q)?.[1];
      if (repo)
        return { rows: (o.components?.[repo] ?? []).map((id) => ({ id, kind: "Component" })) };
      const topic = /^kind:endpoint endpointType:event-topic pathOrTopic:(\S+)$/.exec(q)?.[1];
      if (topic) return { rows: (o.topics?.[topic] ?? []).map((id) => ({ id, kind: "Endpoint" })) };
      return { rows: [] };
    },
  });

  it("reads a repo's id as its one component: an id with dots, an id that isn't the component's (beta.30)", () => {
    const look = askLookup(
      fieldIndex({
        components: {
          "forge.instruments.svc": ["forge-instruments-svc"],
          "forge-ledger": ["ledger-api"],
        },
      }),
    );
    expect(look("forge.instruments.svc")).toEqual({
      id: "forge-instruments-svc",
      kind: "Component",
    });
    expect(translate("who calls forge.instruments.svc?", look).query).toBe(
      "kind:interface to:forge-instruments-svc",
    );
    expect(look("forge-ledger")).toEqual({ id: "ledger-api", kind: "Component" });
    expect(translate("who calls forge-ledger?", look).query).toBe("kind:interface to:ledger-api");
  });

  it("asks of every component of a repo of two for its calls, and walks or owns neither", () => {
    const look = askLookup(
      fieldIndex({ components: { "forge-portal": ["portal-web", "portal-bff"] } }),
    );
    expect(look("forge-portal")).toEqual({
      id: "portal-bff",
      kind: "Component",
      ids: ["portal-bff", "portal-web"],
    });
    expect(translate("who calls forge-portal?", look)).toMatchObject({
      action: "query",
      query: "kind:interface to:portal-bff,portal-web",
    });
    expect(translate("what does forge-portal call?", look).query).toBe(
      "kind:interface from:portal-bff,portal-web",
    );
    expect(translate("what breaks if forge-portal changes", look).action).not.toBe("impact");
    expect(translate("who owns forge-portal", look).action).not.toBe("owner");
  });

  it("a repo id that is also a topic's name: the topic for who receives or publishes, the repo otherwise", () => {
    const look = askLookup(
      fieldIndex({
        components: { "forge.events": ["forge-events"] },
        topics: { "forge.events": ["forge-audit.on-forge-events"] },
      }),
    );
    expect(translate("who consumes the topic forge.events?", look)).toMatchObject({
      action: "impact",
      id: "forge-audit.on-forge-events",
      receivers: true,
    });
    expect(translate("who publishes to forge.events?", look)).toMatchObject({
      action: "query",
      query: "kind:interface endpoint:forge-audit.on-forge-events",
    });
    expect(translate("who calls forge.events?", look).query).toBe("kind:interface to:forge-events");
    // "What does X …" asks what the repo does.
    expect(translate("what does forge.events consume?", look).query).toBe(
      "kind:interface to:forge-events",
    );
    expect(translate("what does forge.events send?", look).query).toBe(
      "kind:interface from:forge-events",
    );
  });

  it("a topic with consumers in two repos is received by both: every Endpoint of its name (beta.30)", () => {
    const look = askLookup(
      fieldIndex({
        topics: {
          "forge.items.settled": ["svc-03.on-forge-items-settled", "svc-00.on-forge-items-settled"],
        },
      }),
    );
    expect(look("forge.items.settled")).toEqual({
      id: "svc-00.on-forge-items-settled",
      kind: "Endpoint",
      byName: true,
      also: ["svc-03.on-forge-items-settled"],
    });
    expect(translate("who consumes the topic forge.items.settled?", look)).toEqual({
      action: "impact",
      id: "svc-00.on-forge-items-settled",
      also: ["svc-03.on-forge-items-settled"],
      named: "forge.items.settled",
      // A query that runs (atticus impact walks one record): the first, the other named.
      query: "impact svc-00.on-forge-items-settled",
      explanation:
        "Read as: who receives forge.items.settled, at each of its 2 consumers (svc-00.on-forge-items-settled, svc-03.on-forge-items-settled): the receivers first, then what a change reaches past them. The query walks the first; impact svc-03.on-forge-items-settled walks the other.",
      receivers: true,
    });
    // Who publishes to it: the interfaces on any of its Endpoints.
    expect(translate("who publishes to the topic forge.items.settled?", look).query).toBe(
      "kind:interface endpoint:svc-00.on-forge-items-settled,svc-03.on-forge-items-settled",
    );
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
      // A plain word is a word search, as it was: only a name shaped like an id or a topic (a dot,
      // a dash or an underscore in it) is said to be missing (the review of b30/proof-fixes).
      ["who sends notifications?", "sends notifications"],
      ["what produces invoices", "produces invoices"],
      ["what does billing use", "billing use"],
      ["what does billing call?", "billing call"],
      ["who receives payments?", "receives payments"],
      ["who listens to alerts", "listens alerts"],
      ["who publishes reports?", "publishes reports"],
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
