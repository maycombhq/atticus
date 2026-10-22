import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readYaml } from "../src/yaml-lite";

/**
 * The extension ships with no dependencies, so it reads the few YAML files it needs (the
 * knowledge scan's report, a saved search of the wikis) with a small reader of its own. These
 * are files the `yaml` library wrote: block maps and lists, folded long lines, quotes.
 */

// The command line's own writer, from the core package (the extension doesn't ship it).
const { stringify } = createRequire(join(__dirname, "../../core/package.json"))("yaml") as {
  stringify: (v: unknown) => string;
};

describe("reading the YAML the command line writes", () => {
  it("reads back what the yaml library writes, awkward strings and all", () => {
    const long =
      "The Messaging team creates topics within five working days of the request being raised: ask early, and #tag it with 'forge' \"quoted\".";
    const v = {
      schemaVersion: 1,
      phrase: "Kafka: topic",
      at: "2026-10-22T11:00:00Z",
      pages: ["forge-wiki/messaging/kafka-topics", "a: b"],
      candidates: [
        {
          id: "request-kafka-acl",
          kind: "request",
          title: "- starts with a dash",
          quote: long,
          multi: "line one\nline two\n\nline four",
          steps: [long, "yes", "123", "true", "null", "", "#hash", "a #b"],
          urls: [
            {
              url: "https://desk.northwind.example/catalogue/kafka-acl?x=1#top",
              label: "Form: ACL",
            },
          ],
          nested: [[1, 2], []],
          empty: {},
          n: 3.5,
        },
      ],
      changes: { at: "x", added: [], changed: ["a"], removed: [] },
    };
    expect(readYaml(stringify(v))).toEqual(v);
  });

  it("reads maps, lists, lists of maps and scalars", () => {
    const text = `schemaVersion: 1
scannedAt: 2026-10-22T10:00:00Z
snapshots:
  - source: forge-wiki
    date: 2026-10-22
    pages: 3
    hashes:
      intake.md: 3f2a
  - source: northwind-docs
    date: "2026-10-21"
    pages: 1
changes:
  at: 2026-10-22T10:00:00Z
  added:
    - request-kafka-topic
    - team-messaging
  changed: []
  removed:
  - pattern-outbox
conflicts: []
empty: {}
flag: true
nothing: null
`;
    expect(readYaml(text)).toEqual({
      schemaVersion: 1,
      scannedAt: "2026-10-22T10:00:00Z",
      snapshots: [
        { source: "forge-wiki", date: "2026-10-22", pages: 3, hashes: { "intake.md": "3f2a" } },
        { source: "northwind-docs", date: "2026-10-21", pages: 1 },
      ],
      changes: {
        at: "2026-10-22T10:00:00Z",
        added: ["request-kafka-topic", "team-messaging"],
        changed: [],
        removed: ["pattern-outbox"],
      },
      conflicts: [],
      empty: {},
      flag: true,
      nothing: null,
    });
  });

  it("joins folded lines, and reads quotes with their escapes", () => {
    const text = `phrase: Kafka topic
candidates:
  - id: request-kafka-topic
    title: "Ask the Messaging team for a topic: \\"forge.notes\\""
    quote: The Messaging team creates topics within five working days of the request
      being raised in the service desk.
    single: 'it''s quoted'
    folded: "a long double-quoted line that the writer
      folded onto the next line"
    steps:
      - Open the service desk
      - "Pick: Kafka topic"
    urls:
      - url: https://desk.northwind.example/catalogue/kafka-topic
        label: Kafka topic form
    block: |-
      line one
      line two
    flow: [a, "b, c", 3]
    comment: plain # not part of it
`;
    const y = readYaml(text) as {
      candidates: Record<string, unknown>[];
    };
    const c = y.candidates[0]!;
    expect(c.title).toBe('Ask the Messaging team for a topic: "forge.notes"');
    expect(c.quote).toBe(
      "The Messaging team creates topics within five working days of the request being raised in the service desk.",
    );
    expect(c.single).toBe("it's quoted");
    expect(c.folded).toBe("a long double-quoted line that the writer folded onto the next line");
    expect(c.steps).toEqual(["Open the service desk", "Pick: Kafka topic"]);
    expect(c.urls).toEqual([
      { url: "https://desk.northwind.example/catalogue/kafka-topic", label: "Kafka topic form" },
    ]);
    expect(c.block).toBe("line one\nline two");
    expect(c.flow).toEqual(["a", "b, c", 3]);
    expect(c.comment).toBe("plain");
  });

  it("gives undefined for what isn't YAML it can read, rather than throwing", () => {
    expect(readYaml("")).toBeUndefined();
    expect(readYaml("# only a comment\n")).toBeUndefined();
  });
});
