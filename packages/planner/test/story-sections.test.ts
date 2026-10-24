import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import {
  architectureStage,
  checkStories,
  EXPAND_AGENT,
  featureStage,
  FlowDelta,
  knownFieldNames,
  loadEstate,
  storiesFromDeltas,
  storiesStage,
  StoriesAnswerSchema,
  writeStories,
  type StageIssue,
} from "../src/index.js";

/**
 * A story complete enough to build without asking (ADR 0124 addendum B-stories, Part 3 of the
 * design): its sections, and the completeness check the stage runs before the critic. The
 * fixtures are the Forge fraud check: fixtures/stages/stories/.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "../../../fixtures/stages");
const STORIES_FIX = join(FIX, "stories");
const SPECS_CATALOG = join(HERE, "../../../fixtures/specs/catalog.yaml");
const NOW = new Date("2026-10-21T09:00:00Z");
const CHANGE = "add-fraud-check";

const fixture = (f: string) => readFileSync(join(STORIES_FIX, f), "utf8");
const ANSWER = fixture("answer.yaml");
const DELTAS = fixture("deltas.yaml");
const PLACED = fixture("placed.yaml");

async function estateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-story-sections-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  const rows = [
    ...(parse(readFileSync(SPECS_CATALOG, "utf8")) as unknown[]),
    ...(parse(readFileSync(join(FIX, "catalog-extra.yaml"), "utf8")) as unknown[]),
  ];
  for (const r of rows) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(`bad fixture record: ${JSON.stringify(p.issues)}`);
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  for (const r of parse(readFileSync(join(FIX, "knowledge.yaml"), "utf8")) as unknown[]) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(`bad knowledge record: ${JSON.stringify(p.issues)}`);
    const f = join(root, "knowledge/items", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(join(FIX, "specs"), join(root, "specs"), { recursive: true });
  await cp(join(FIX, "changes"), join(root, "openspec/changes"), { recursive: true });
  return root;
}

const records = () =>
  [
    ...(parse(readFileSync(SPECS_CATALOG, "utf8")) as unknown[]),
    ...(parse(readFileSync(join(FIX, "catalog-extra.yaml"), "utf8")) as unknown[]),
  ].map((r) => {
    const p = parseRecord(r);
    if (!p.ok) throw new Error("bad record");
    return p.record;
  });

/** The deltas, stories and known names of the fraud check, without running a stage. */
async function planned(deltasYaml = DELTAS) {
  const root = await estateRoot();
  const estate = await loadEstate(root, records());
  const deltas = (parse(deltasYaml) as { flows: unknown[] }).flows.map((d) =>
    FlowDelta.parse({ schemaVersion: 2, ...(d as object) }),
  );
  return { estate, deltas, stories: storiesFromDeltas(deltas, estate) };
}

/** The answer with a change made to its one story (a section left out, a field renamed). */
function edited(change: (s: Record<string, unknown>) => void, text = ANSWER) {
  const a = parse(text) as { stories: Record<string, unknown>[] };
  change(a.stories[0]!);
  return StoriesAnswerSchema.parse(a);
}

/** The fixtures' processes and requests, which the answer's requests cite. */
const processes = () =>
  (parse(readFileSync(join(FIX, "knowledge.yaml"), "utf8")) as unknown[]).flatMap((r) => {
    const p = parseRecord(r);
    return p.ok && p.record.kind === "ProcessDefinition" ? [p.record] : [];
  });

async function check(a = StoriesAnswerSchema.parse(parse(ANSWER)), deltasYaml = DELTAS) {
  const p = await planned(deltasYaml);
  return checkStories(a, p.stories, p.deltas, processes(), {
    sections: true,
    known: knownFieldNames(p.estate, p.deltas),
  });
}

const rules = (issues: StageIssue[]) => issues.map((i) => `${i.rule}${i.blocking ? "!" : ""}`);
const blocking = (issues: StageIssue[]) => issues.filter((i) => i.blocking);

describe("a story with every section (B-stories)", () => {
  it("reads the sections and passes the completeness check", async () => {
    const a = StoriesAnswerSchema.parse(parse(ANSWER));
    const s = a.stories[0]!;
    expect(s.scope?.out).toHaveLength(2);
    expect(Array.isArray(s.interfaces) && s.interfaces[0]!.fields[0]).toMatchObject({
      name: "cardToken",
      side: "request",
      required: true,
      change: "added",
    });
    expect(s.tasks[0]!.criteria[1]).toMatchObject({ outcome: "error", rule: "required" });
    const issues = await check(a);
    expect(blocking(issues)).toEqual([]);
    expect(rules(issues)).not.toContain("stories.section-missing");
  });

  it("works out, from the target flows, the story that must land first and today's flow before and after", async () => {
    // forge-orders calls a new entry the forge-stock story adds.
    const two = `${DELTAS}
  - flow: forge-stock.hold-stock
    repo: forge-stock
    change: new
    name: Hold stock for an order
    trigger: { kind: endpoint, what: The orders service asks for a hold, entry: "POST /stock/holds" }
    why: Stock is held while the order is screened.
    steps:
      - op: add
        kind: entry
        what: StockController.hold receives the hold
        fields: { reads: [sku, quantity] }
`.replace(
      "      - op: add\n        after: 1\n        kind: branch",
      '      - op: add\n        after: 1\n        kind: call-out\n        what: The stock service holds the quantity\n        to: { component: forge-stock, entry: "POST /stock/holds", new: true }\n        fields: { sends: [sku, quantity] }\n      - op: add\n        after: 1\n        kind: branch',
    );
    const p = await planned(two);
    expect(p.stories.map((s) => [s.id, s.dependsOn ?? []])).toEqual([
      ["s1-place-order", ["s2-hold-stock"]],
      ["s2-hold-stock", []],
    ]);
    const s1 = p.stories[0]!;
    expect(s1.entry).toBe("POST /orders");
    expect(s1.before).toEqual([
      "1. entry: OrderController.place receives the new order (forge-orders:src/main/java/forge/orders/OrderController.java:4, forge-orders:src/main/java/forge/orders/OrderController.java:9)",
      "2. call-out: The stock service reserves the quantity (forge-orders:src/main/java/forge/orders/StockClient.java:7)",
      "3. transform: The request becomes an Order entity (forge-orders:src/main/java/forge/orders/OrderController.java:12)",
      "4. write: The order is inserted (forge-orders:src/main/java/forge/orders/OrderController.java:13)",
      "5. respond: 201 Created with the saved order (forge-orders:src/main/java/forge/orders/OrderController.java:14)",
    ]);
    expect(s1.after?.[1]).toBe(
      "2. call-out, added by task 1.1: Northwind Pay screens the order for fraud",
    );
    expect(s1.errors).toEqual([
      "The body fails validation: 400 with the errors (forge-orders:src/main/java/forge/orders/OrderController.java:10)",
    ]);
    expect(p.stories[1]!.entry).toBe("POST /stock/holds");
  });

  it("knows the deltas' fields and the estate's columns, schema fields and flow data", async () => {
    const p = await planned();
    const known = knownFieldNames(p.estate, p.deltas);
    for (const n of ["cardToken", "verdict", "fraud_verdict", "sku", "created_at", "id"])
      expect(known.has(n.toLowerCase().replace(/[_-]/g, "")), n).toBe(true);
    expect(known.has("colour")).toBe(false);
  });
});

describe("an answer without the sections (an old recording)", () => {
  const OLD = StoriesAnswerSchema.parse(
    (() => {
      const a = parse(ANSWER) as { stories: Record<string, unknown>[] };
      for (const k of ["context", "scope", "interfaces", "data", "nonFunctional", "tests"])
        delete a.stories[0]![k];
      delete a.stories[0]!.dependencies;
      return a;
    })(),
  );

  it("is told each missing section, as a risk, so recorded replays keep passing", async () => {
    const issues = await check(OLD);
    const missing = issues.find((i) => i.rule === "stories.section-missing");
    expect(missing).toMatchObject({ blocking: false, target: "s1-place-order" });
    for (const s of [
      "scope (out)",
      "interface changes",
      "data changes",
      "auth",
      "audit",
      "timeouts and retries",
      "performance",
      "test notes",
      "dependencies",
    ])
      expect(missing!.message, s).toContain(s);
    // The added column's nullable and retention come only from the story: also a risk here.
    expect(issues.find((i) => i.rule === "stories.data-incomplete")).toMatchObject({
      blocking: false,
      target: "1.3:fraud_verdict",
    });
    expect(blocking(issues)).toEqual([]);
  });

  it("isn't asked for sections at all without the sections option (the fast path)", async () => {
    const p = await planned();
    expect(rules(checkStories(OLD, p.stories, p.deltas, []))).not.toContain(
      "stories.section-missing",
    );
  });
});

describe("the completeness check holds a section to what the target flows say", () => {
  it("refuses an interface field no step of the target flow carries (an invented field)", async () => {
    const issues = await check(
      edited((s) => {
        const i = (s.interfaces as { fields: { name: string }[] }[])[0]!;
        i.fields[0]!.name = "cardHolder";
      }),
    );
    expect(blocking(issues).map((i) => [i.rule, i.target])).toContainEqual([
      "stories.invented-field",
      "s1-place-order:POST /orders:cardHolder",
    ]);
    // A name written another way, case and underscores aside, is the same field.
    const snake = await check(
      edited((s) => {
        const i = (s.interfaces as { fields: { name: string }[] }[])[0]!;
        i.fields[0]!.name = "card_token";
      }),
    );
    expect(blocking(snake)).toEqual([]);
  });

  it("asks each new request field of an entry the repo serves for its validation and an error criterion", async () => {
    const noValidation = await check(
      edited((s) => {
        const f = (s.interfaces as { fields: Record<string, unknown>[] }[])[0]!.fields[0]!;
        delete f.validation;
      }),
    );
    expect(blocking(noValidation).map((i) => [i.rule, i.target])).toEqual([
      ["stories.field-no-validation", "s1-place-order:POST /orders:cardToken"],
    ]);
    const noError = await check(
      edited((s) => {
        const t = (s.tasks as { criteria: unknown[] }[])[0]!;
        t.criteria.splice(1, 1);
      }),
    );
    expect(blocking(noError).map((i) => [i.rule, i.target])).toEqual([
      ["stories.field-no-error-case", "s1-place-order:POST /orders:cardToken"],
    ]);
    expect(blocking(noError)[0]!.message).toContain("outcome: error");
    // The vendor's request fields are the vendor's to validate: not asked of this story.
    expect(blocking(noValidation).some((i) => i.target.includes("POST /v1/screenings"))).toBe(
      false,
    );
  });

  it("asks for every entry the target flows add, and refuses none when they add one", async () => {
    const dropped = await check(
      edited((s) => {
        (s.interfaces as unknown[]).splice(1, 1);
      }),
    );
    expect(blocking(dropped).map((i) => [i.rule, i.target])).toEqual([
      ["stories.interface-missing", "s1-place-order:POST /v1/screenings"],
    ]);
    const none = await check(
      edited((s) => {
        s.interfaces = { none: "nothing changes" };
      }),
    );
    expect(blocking(none).map((i) => i.rule)).toEqual(["stories.interface-missing"]);
    const unknown = await check(
      edited((s) => {
        (s.interfaces as { entry: string }[])[0]!.entry = "POST /purchases";
      }),
    );
    expect(blocking(unknown).map((i) => i.rule)).toContain("stories.unknown-entry");
  });

  it("holds the data changes to the columns the steps add, with what the target flow says of them", async () => {
    const column = await check(
      edited((s) => {
        (s.data as Record<string, unknown>[])[0]!.column = "risk_score";
      }),
    );
    expect(blocking(column).map((i) => [i.rule, i.target])).toContainEqual([
      "stories.unknown-column",
      "s1-place-order:forge-orders-db.orders.risk_score",
    ]);
    const type = await check(
      edited((s) => {
        (s.data as Record<string, unknown>[])[0]!.type = "text";
      }),
    );
    expect(blocking(type).map((i) => [i.rule, i.target])).toEqual([
      ["stories.data-differs", "1.3:fraud_verdict"],
    ]);
    expect(blocking(type)[0]!.message).toContain("varchar(20)");
    const retention = await check(
      edited((s) => {
        delete (s.data as Record<string, unknown>[])[0]!.retention;
      }),
    );
    expect(blocking(retention).map((i) => [i.rule, i.target])).toEqual([
      ["stories.data-incomplete", "1.3:fraud_verdict"],
    ]);
    const none = await check(
      edited((s) => {
        s.data = { none: "nothing is stored differently" };
      }),
    );
    expect(blocking(none).map((i) => [i.rule, i.target])).toEqual([
      ["stories.data-missing", "1.3:fraud_verdict"],
    ]);
  });

  it("asks every store write that adds a column for its migration", async () => {
    const noMigration = DELTAS.replace(", migration: V4__add_fraud_verdict.sql", "");
    const issues = await check(
      edited((s) => {
        delete (s.data as Record<string, unknown>[])[0]!.migration;
      }),
      noMigration,
    );
    expect(blocking(issues).map((i) => [i.rule, i.target])).toEqual([
      ["stories.write-no-migration", "1.3"],
    ]);
    // The story may name it where the target flow didn't.
    expect(blocking(await check(undefined, noMigration))).toEqual([]);
  });

  it("refuses a dependency on a story or repo the change doesn't have", async () => {
    const issues = await check(
      edited((s) => {
        s.dependencies = { stories: ["s9-ship-order"], repos: ["forge-billing"] };
      }),
    );
    expect(blocking(issues).map((i) => [i.rule, i.target])).toEqual([
      ["stories.unknown-dependency", "s1-place-order:s9-ship-order"],
      ["stories.unknown-dependency", "s1-place-order:forge-billing"],
    ]);
  });

  it("names a field-like word in a criterion that nothing knows, as a risk", async () => {
    const issues = await check(
      edited((s) => {
        const t = (s.tasks as { criteria: { text: string }[] }[])[2]!;
        t.criteria[0]!.text =
          "Given an accepted order, when it is saved, then the orders row holds sku, quantity, fraud_verdict and riskScore";
      }),
    );
    expect(issues.find((i) => i.rule === "stories.unknown-name")).toMatchObject({
      blocking: false,
      target: "1.3:riskScore",
    });
  });
});

/** The context expander, the drafter's answers in turn, and critic lenses that find nothing. */
function assistant(drafts: string[], seen: string[] = []) {
  let n = 0;
  return new MockRuntime(
    (req: AiRequest) => {
      if (req.agent.id.endsWith("-critic")) return "findings: []";
      if (req.agent.id === EXPAND_AGENT)
        return "terms: [fraud screen, place order]\nnames:\n  - { name: Northwind Pay, id: northwind-pay, quote: screened by Northwind Pay }\n";
      seen.push(req.pack.prompt);
      return drafts[Math.min(n++, drafts.length - 1)]!;
    },
    { now: () => NOW },
  );
}

describe("the Interface changes show the catalog's required when the story doesn't say (ADR 0125)", () => {
  /** The fraud check's answer, POST /orders also changing sku and quantity, with no required. */
  const answer = (sku: Record<string, unknown> = {}) =>
    edited((s) => {
      const i = (s.interfaces as { entry: string; fields: Record<string, unknown>[] }[])[0]!;
      i.fields.push(
        { name: "sku", side: "request", type: "string", change: "changed", ...sku },
        { name: "quantity", side: "request", type: "integer", change: "changed" },
      );
    });

  async function written(a: ReturnType<typeof answer>) {
    const root = await estateRoot();
    const rows = parse(readFileSync(join(STORIES_FIX, "catalog-required.yaml"), "utf8"));
    const extra = (rows as unknown[]).map((r) => {
      const p = parseRecord(r);
      if (!p.ok) throw new Error(`bad fixture record: ${JSON.stringify(p.issues)}`);
      return p.record;
    });
    const estate = await loadEstate(root, [...records(), ...extra]);
    const deltas = (parse(DELTAS) as { flows: unknown[] }).flows.map((d) =>
      FlowDelta.parse({ schemaVersion: 2, ...(d as object) }),
    );
    const stories = storiesFromDeltas(deltas, estate);
    await writeStories(root, CHANGE, stories, a, [], NOW, [], { estate });
    return readFile(join(root, "openspec/changes", CHANGE, "stories/s1-place-order.md"), "utf8");
  }

  it("reads a field's required from the story, else the catalog's, else says it isn't said", async () => {
    const a = answer();
    const f = Array.isArray(a.stories[0]!.interfaces) ? a.stories[0]!.interfaces[0]!.fields : [];
    expect(f.map((x) => [x.name, x.required])).toEqual([
      ["cardToken", true],
      ["sku", undefined],
      ["quantity", undefined],
    ]);
    const story = await written(a);
    expect(story).toContain(
      "| cardToken | request | string | yes | none | added | required; 1 to 64 characters |",
    );
    // the catalog's request Schema of POST /orders says sku must be sent; nothing says of quantity
    expect(story).toContain(
      "| sku | request | string | yes (catalog) | none | changed | none given |",
    );
    expect(story).toContain(
      "| quantity | request | integer | not said | none | changed | none given |",
    );
    // the task's prompt says the same
    expect(story).toContain(
      "POST /orders changes the request field sku (string, required, from the catalog)",
    );
    expect(story).toContain(
      "POST /orders changes the request field quantity (integer, required not said)",
    );
  });

  it("a required the story gives wins over the catalog's", async () => {
    const story = await written(answer({ required: false }));
    expect(story).toContain("| sku | request | string | no | none | changed | none given |");
    expect(story).toContain("POST /orders changes the request field sku (string, optional)");
  });
});

describe("the stories stage writes every section", () => {
  it("renders the story file with its sections, the tasks with files, tests and command, and the index's dependencies", async () => {
    const root = await estateRoot();
    await mkdir(join(root, "org-pack/profiles/forge"), { recursive: true });
    await writeFile(
      join(root, "org-pack/profiles/forge/repos.manifest.yaml"),
      stringify({
        schemaVersion: 1,
        platform: "forge",
        repos: [
          {
            id: "forge-orders",
            url: "https://git.example.com/forge/forge-orders.git",
            type: "spring-boot",
            owner: "team-orders",
            build: "./gradlew test",
          },
        ],
      }),
    );
    expect(
      (await featureStage(root, CHANGE, { runtime: assistant([PLACED]), now: NOW })).state,
    ).toBe("done");
    expect(
      (await architectureStage(root, CHANGE, { runtime: assistant([DELTAS]), now: NOW })).state,
    ).toBe("done");
    const prompts: string[] = [];
    const r = await storiesStage(root, CHANGE, { runtime: assistant([ANSWER], prompts), now: NOW });
    expect(r.state).toBe("done");
    expect(r.findings.filter((f) => f.blocking)).toEqual([]);
    // The drafter is told what each section holds.
    for (const words of [
      "scope:",
      "interfaces:",
      "data:",
      "nonFunctional:",
      "dependencies:",
      "Every request field an entry of this repo gains or changes has a validation",
    ])
      expect(prompts[0], words).toContain(words);
    const dir = join(root, "openspec/changes", CHANGE);
    const story = await readFile(join(dir, "stories/s1-place-order.md"), "utf8");
    expect(story).toBe(fixture("expected/s1-place-order.md"));
    const index = await readFile(join(dir, "stories.md"), "utf8");
    // No story of the change lands first, so the index's Depends on stays empty (the critic
    // reads its cells as story ids).
    expect(index).toContain("| s1-place-order | Screen each order for fraud | forge-orders |  |");
  });
});
