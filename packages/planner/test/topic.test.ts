import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import type { CatalogRecord } from "@maycombhq/core";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  conformClaims,
  estateOf,
  FlowDelta,
  readClaims,
  renderTopics,
  topicClaims,
  topicIssues,
  topicTaskLines,
  type Estate,
} from "../src/index.js";

/**
 * ADR 0207 part 4: a publish to a new topic may say what the topic is, as a new table does: its
 * format, schema file, key, fields with types and classification, and settings. Six rules check
 * it with no model; design.md gains "Topics this change adds". Fixture: fixtures/stages/new-topic.
 */

const DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/stages/new-topic");
const FLOWS = parse(readFileSync(join(DIR, "flows.yaml"), "utf8")) as unknown[];
const LEVELS = ["public", "internal", "confidential", "restricted"];
const TOPIC = "forge.orders.shipped";

const records = (more: Record<string, unknown>[] = []) =>
  [
    { kind: "Component", id: "forge-orders", repo: "forge-orders" },
    { kind: "Component", id: "forge-ledger", repo: "forge-ledger" },
    { kind: "Component", id: "forge-hub", repo: "forge-hub" },
    ...more,
  ] as unknown as CatalogRecord[];
const estate = (more: Record<string, unknown>[] = []): Estate => estateOf(records(more), []);

/** The fixture's deltas, each changed by `edit` first (a deep copy). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a test edits the raw YAML freely
type Raw = any[];
function deltas(edit: (raw: Raw) => void = () => {}): FlowDelta[] {
  const raw = structuredClone(FLOWS) as Raw;
  edit(raw);
  return raw.map((d) => FlowDelta.parse(d));
}
const rules = (ds: FlowDelta[], e = estate(), o: { onFile?: boolean } = {}) =>
  topicIssues(ds, e, { levels: LEVELS, ...o }).map((i) => [i.rule, i.blocking]);

describe("a planned topic's schema and settings (ADR 0207 part 4)", () => {
  it("reads the step's topic, and passes the fixture", () => {
    const [pub] = deltas();
    expect(pub!.steps[0]!.topic).toMatchObject({ format: "json", key: "orderId" });
    expect(topicIssues(deltas(), estate(), { levels: LEVELS })).toEqual([]);
  });

  it("delta.topic-fields: a field sent or read that the topic lacks", () => {
    const ds = deltas((r) => {
      r[0].steps[0].fields.sends.push("carrier");
      r[1].steps[0].fields.reads.push("warehouse");
    });
    const found = topicIssues(ds, estate(), { levels: LEVELS });
    expect(found.map((i) => [i.rule, i.target, i.blocking])).toEqual([
      ["delta.topic-fields", `forge-orders.ship-order#1:${TOPIC}:carrier`, true],
      ["delta.topic-fields", `forge-ledger.on-order-shipped:${TOPIC}:warehouse`, true],
    ]);
    expect(found[1]!.message).toBe(
      "forge-ledger.on-order-shipped listens to forge.orders.shipped and reads warehouse, which the topic's fields (orderId, shippedAt) don't have: add it to topic.fields, or read only what the topic carries.",
    );
  });

  it("delta.topic-exists: topic given for a topic the map has, unless on file", () => {
    const e = estate([
      {
        kind: "Endpoint",
        id: "forge-hub.orders-shipped",
        component: "forge-hub",
        pathOrTopic: TOPIC,
      },
    ]);
    expect(rules(deltas(), e)).toEqual([["delta.topic-exists", true]]);
    expect(rules(deltas(), e, { onFile: true })).toEqual([]);
  });

  it("topic on a step that isn't a publish to a new topic is a finding, never passed over", () => {
    const e = estate([
      {
        kind: "Endpoint",
        id: "forge-hub.orders-shipped",
        component: "forge-hub",
        pathOrTopic: TOPIC,
      },
    ]);
    // A publish to the topic the map has, marked not new, still giving topic.
    const existing = deltas((r) => (r[0].steps[0].to.new = false));
    expect(rules(existing, e)).toEqual([["delta.topic-exists", true]]);
    // A call-out carrying topic.
    const call = deltas((r) => {
      r[0].steps[0].kind = "call-out";
      r[0].steps[0].to = { component: "forge-ledger", entry: "POST /v1/entries" };
    });
    const found = topicIssues(call, estate(), { levels: LEVELS });
    expect(found.map((i) => [i.rule, i.blocking])).toEqual([["delta.topic-on-step", true]]);
    expect(found[0]!.message).toBe(
      "Change 1 to forge-orders.ship-order gives topic, but it is a call-out to POST /v1/entries: topic goes only on a publish to a topic this change adds (new: true). Take it off.",
    );
  });

  it("delta.topic-twice: two steps define the same topic differently", () => {
    const ds = deltas((r) => {
      const again = structuredClone(r[0]);
      again.flow = "forge-orders.reship-order";
      again.steps[0].topic.key = "shippedAt";
      r.push(again);
    });
    expect(rules(ds)).toEqual([["delta.topic-twice", true]]);
  });

  it("delta.topic-classification: a level the org pack doesn't have", () => {
    const ds = deltas((r) => (r[0].steps[0].topic.classification = { orderId: "top-secret" }));
    expect(rules(ds)).toEqual([["delta.topic-classification", true]]);
  });

  it("delta.topic-secret: a setting with a secret's shape, its value never printed", () => {
    const ds = deltas(
      (r) => (r[0].steps[0].topic.settings.broker = "amqp://forge:hunter2@broker.forge.example"),
    );
    const found = topicIssues(ds, estate(), { levels: LEVELS });
    expect(found.map((i) => [i.rule, i.blocking])).toEqual([["delta.topic-secret", true]]);
    expect(found[0]!.message).not.toContain("hunter2");
    expect(found[0]!.message).toContain("broker");
  });

  it("delta.topic-no-schema: a note, for no topic or one with neither fields nor schemaFile", () => {
    expect(rules(deltas((r) => delete r[0].steps[0].topic))).toEqual([
      ["delta.topic-no-schema", false],
    ]);
    expect(rules(deltas((r) => (r[0].steps[0].topic = { format: "avro" })))).toEqual([
      ["delta.topic-no-schema", false],
    ]);
    // A publish to a topic that isn't new says nothing.
    expect(
      rules(
        deltas((r) => {
          delete r[0].steps[0].topic;
          r[0].steps[0].to.new = false;
        }),
      ),
    ).toEqual([]);
  });

  it("design.md's Topics this change adds (golden)", () => {
    expect(renderTopics(deltas(), estate()).join("\n") + "\n").toBe(
      readFileSync(join(DIR, "design-topics.md"), "utf8"),
    );
    expect(renderTopics([], estate())).toEqual([]);
    // A listener's standing: read, not read (a manifest's repo), planned (runsOn), or outside.
    const more = deltas((r) => {
      for (const [repo, extra] of [
        ["forge-reports", {}],
        ["forge-new-svc", { runsOn: { component: "forge-new-svc" } }],
        ["northwind-desk", {}],
      ] as const)
        r.push({
          ...structuredClone(r[1]),
          flow: `${repo}.on-order-shipped`,
          repo,
          ...extra,
        });
    });
    const e = estateOf(records([{ kind: "System", id: "northwind-desk" }]), [], [], {
      repos: ["forge-reports"],
      archived: [],
      problems: [],
    });
    expect(renderTopics(more, e)[4]).toContain(
      "forge-ledger.on-order-shipped (forge-ledger, read), forge-reports.on-order-shipped (forge-reports, not read), forge-new-svc.on-order-shipped (forge-new-svc, planned), northwind-desk.on-order-shipped (northwind-desk, outside)",
    );
  });

  it("gives the publisher's task its two criteria and a listener the fields it may read", () => {
    const t = topicTaskLines(deltas());
    expect(t.criteria.get("forge-orders.ship-order#1")).toEqual([
      "Given the change is built, when forge-orders's tree is read, then schemas/forge.orders.shipped.json holds the json schema of forge.orders.shipped, keyed by orderId, with orderId (string) and shippedAt (timestamp)",
      "Given the change is deployed, when forge.orders.shipped is made, then its settings are partitions 6, retention 7d and deadLetter forge.orders.shipped.dlq",
    ]);
    expect(t.reads.get("forge-ledger.on-order-shipped")).toBe(
      "- Topic it listens to: forge.orders.shipped; the fields it may read: orderId and shippedAt (the topic as this change defines it)",
    );
    // No topic, nothing to add.
    expect(topicTaskLines(deltas((r) => delete r[0].steps[0].topic)).criteria.size).toBe(0);
  });
});

describe("after the build, the schema file is looked for in the commit's tree (ADR 0207 part 4)", () => {
  const input = (files: string[]) => ({
    change: "ship-orders",
    changesRel: "openspec/changes",
    repo: "forge-orders",
    claims: topicClaims(deltas(), new Map([["forge-orders.ship-order", 18]])),
    before: [],
    after: [],
    files,
    basis: { from: "facts" as const, unread: [] },
  });

  it("is a claim of the publisher's repo, at its line in the target flow", () => {
    expect(topicClaims(deltas(), new Map([["forge-orders.ship-order", 18]]))).toEqual([
      {
        repo: "forge-orders",
        check: "schema",
        expect: { file: "schemas/forge.orders.shipped.json" },
        words: "the schema of forge.orders.shipped",
        from: { file: "target-flows/forge-orders.ship-order.yaml", line: 18 },
      },
    ]);
  });

  it("is present when the tree has the file at that path, and missing when not", () => {
    const has = conformClaims(input(["schemas/forge.orders.shipped.json"])).claims[0]!;
    expect([has.outcome, has.what]).toEqual([
      "present",
      "forge-orders has schemas/forge.orders.shipped.json.",
    ]);
    const lacks = conformClaims(input(["old/schemas/forge.orders.shipped.json"])).claims[0]!;
    expect([lacks.outcome, lacks.what]).toEqual([
      "missing",
      "forge-orders has no schemas/forge.orders.shipped.json.",
    ]);
  });

  it("is read with the change's other claims, from its target flows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atticus-topic-claims-"));
    await mkdir(join(dir, "target-flows"), { recursive: true });
    const { stringify } = await import("yaml");
    await writeFile(join(dir, "target-flows/forge-orders.ship-order.yaml"), stringify(FLOWS[0]));
    const r = await readClaims(dir);
    expect(r.claims.map((c) => [c.check, c.repo, c.expect.file, c.from.line])).toEqual([
      ["schema", "forge-orders", "schemas/forge.orders.shipped.json", 26],
    ]);
  });
});
