import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { HandoffRuntime, MockRuntime, type AiRequest } from "@maycombhq/ai";
import { listQuestions, parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import {
  architectureStage,
  FlowDelta,
  interfaceChanges,
  loadEstate,
  featureStage,
  readFigma,
  storiesStage,
  type StageResult,
} from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "../../../fixtures/stages");
const SPECS_CATALOG = join(HERE, "../../../fixtures/specs/catalog.yaml");
const NOW = new Date("2026-10-21T09:00:00Z");
const CHANGE = "add-fraud-check";

/** A metarepo of the small two-repo estate: catalog, specs, knowledge items and two changes. */
async function estateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-stages-"));
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

const dir = (root: string) => join(root, "openspec/changes", CHANGE);

/** A mock assistant: the stage's drafter answers from `drafts` in turn; critic lenses find nothing. */
function assistant(drafts: string[], seen: string[] = []) {
  let n = 0;
  return new MockRuntime(
    (req: AiRequest) => {
      if (req.agent.id.endsWith("-critic")) return "findings: []";
      seen.push(req.pack.prompt);
      return drafts[Math.min(n++, drafts.length - 1)]!;
    },
    { now: () => NOW },
  );
}

const PLACED = `summary: Every new order is screened by Northwind Pay before stock is reserved; a rejected order is refused.
features:
  - id: cap-ordering
    why: Placing an order is the feature that gains the screen.
flows:
  - id: forge-orders.place-order
    how: changed
    why: The screen runs between receiving the order and reserving stock.
  - id: forge-stock.reserve-stock
    how: read
    why: Reserving stock happens only after the screen passes.
gaps:
  - what: No call to Northwind Pay exists yet.
    why: The estate never talks to the fraud screen today.
`;

const DELTAS = `flows:
  - flow: forge-orders.place-order
    repo: forge-orders
    change: modify
    why: The order is screened before stock is reserved.
    steps:
      - op: add
        after: 1
        kind: call-out
        what: Northwind Pay screens the order for fraud
        to: { component: northwind-pay, entry: "POST /v1/screenings", new: true }
        fields: { sends: [sku, quantity, cardToken], returns: [verdict] }
      - op: add
        after: 1
        kind: branch
        what: A rejected order is refused with 422 and nothing is reserved
        fields: { reads: [verdict] }
      - op: change
        step: 4
        kind: write
        what: The order is inserted with the screen's verdict
        store: { table: forge-orders-db.orders, columns: [sku, quantity, fraud_verdict], types: { fraud_verdict: varchar(20) }, classification: { fraud_verdict: internal }, migration: V4__add_fraud_verdict.sql }
`;

const STORIES = `stories:
  - id: s1-place-order
    title: Screen each order for fraud
    asA: shop owner
    iWant: every new order screened by Northwind Pay
    soThat: stolen cards don't empty the stock
    tasks:
      - id: "1.1"
        criteria:
          - "Given a new order, when it is placed, then sku, quantity and cardToken are sent to Northwind Pay and the verdict is read"
      - id: "1.2"
        criteria:
          - "Given a rejected verdict, when the order is placed, then it is refused with 422 and no stock is reserved"
      - id: "1.3"
        criteria:
          - "Given an accepted order, when it is saved, then the orders row holds sku, quantity and fraud_verdict"
`;

describe("the feature stage", () => {
  it("places a brief on the estate by meaning, checks every id, finds the conflict and is done", async () => {
    const root = await estateRoot();
    const prompts: string[] = [];
    // The first draft names a flow that doesn't exist; the check sends it back.
    const bad = PLACED.replace("forge-stock.reserve-stock", "forge-stock.hold-stock");
    const r = await featureStage(root, CHANGE, {
      runtime: assistant([bad, PLACED], prompts),
      now: NOW,
    });
    expect(r.state).toBe("done");
    expect(r.drafts).toBe(2);
    // The estate went in as a compact index of flows and features; the brief as data.
    expect(prompts[0]).toContain("flow forge-orders.place-order (repo forge-orders");
    expect(prompts[0]).toContain("feature cap-ordering");
    expect(prompts[0]).toContain("Stolen cards are used");
    expect(prompts[1]).toContain("Flow forge-stock.hold-stock isn't in any repo's spec");
    const placed = parse(await readFile(join(dir(root), "feature.yaml"), "utf8"));
    expect(placed.flows.map((f: { id: string }) => f.id)).toEqual([
      "forge-orders.place-order",
      "forge-stock.reserve-stock",
    ]);
    // Another change in flight changes the same flow: found from the files, without AI.
    expect(placed.conflicts).toEqual([
      expect.objectContaining({ change: "bulk-orders", flows: ["forge-orders.place-order"] }),
    ]);
    expect(await readFile(join(dir(root), "feature.md"), "utf8")).toContain(
      "bulk-orders (design) also changes forge-orders.place-order",
    );
    expect(r.pr).toBe("atticus change handoff add-fraud-check --approve");
    // The critic ran in every iteration.
    const loop = parse(await readFile(join(dir(root), "stage/feature.yaml"), "utf8"));
    expect(loop.critic.length).toBe(2);
    expect(loop.state).toBe("done");
  });

  it("turns a finding that comes back unchanged twice into a question, and stops", async () => {
    const root = await estateRoot();
    const bad = PLACED.replace("cap-ordering", "cap-checkout");
    const r = await featureStage(root, CHANGE, { runtime: assistant([bad]), now: NOW });
    expect(r.state).toBe("questions");
    expect(r.drafts).toBe(3);
    const q = (await listQuestions(root, { state: "open" })).questions;
    expect(q).toHaveLength(1);
    expect(q[0]!.question).toContain("Feature cap-checkout isn't in the catalog");
    expect(q[0]!.rerun).toBe("atticus change feature add-fraud-check");
    // A rerun with the question still open doesn't call the model.
    const again = await featureStage(root, CHANGE, { runtime: assistant([PLACED]), now: NOW });
    expect(again.state).toBe("questions");
    expect(again.drafts).toBe(0);
  });

  it("turns a finding that flips back into a question", async () => {
    const root = await estateRoot();
    const bad = PLACED.replace("cap-ordering", "cap-checkout");
    const half = PLACED.replace(
      "  - id: forge-orders.place-order",
      "  - id: forge-orders.place-orders",
    );
    const r = await featureStage(root, CHANGE, { runtime: assistant([bad, half, bad]), now: NOW });
    expect(r.state).toBe("questions");
    const q = (await listQuestions(root, { state: "open" })).questions;
    expect(q.map((x) => x.question).join("\n")).toContain("came back after a draft had fixed it");
  });

  it("starts from a Figma design: fields mapped, every element accounted for, no backing is a gap", async () => {
    const root = await estateRoot();
    const design = `${PLACED}design:
  screens:
    - figmaId: "5:1"
      name: Place an order
      fields:
        - { figmaId: "5:3", label: Quantity, backing: existing, mapsTo: "NewOrder.quantity (orders.quantity)", refs: [forge-orders-db.orders.quantity] }
        - { figmaId: "5:4", label: Gift note, backing: new }
      actions:
        - { figmaId: "5:5", label: Place order, endpoint: "POST /orders" }
  ignored:
    - { figmaId: "5:2", why: A static title }
`;
    const fixed = design.replace(
      "label: Gift note, backing: new }",
      "label: Gift note, backing: new, gap: A gift_note column and NewOrder.giftNote }",
    );
    const prompts: string[] = [];
    const r = await featureStage(root, CHANGE, {
      runtime: assistant([design, fixed], prompts),
      now: NOW,
      fromFigma: join(FIX, "order-form.figma.json"),
    });
    expect(r.state).toBe("done");
    expect(prompts[0]).toContain('field 5:4 "Gift note" (text)');
    expect(prompts[1]).toContain('Field "Gift note" (5:4) is new but names no gap');
    const placed = parse(await readFile(join(dir(root), "feature.yaml"), "utf8"));
    expect(placed.entry).toBe("figma");
    expect(placed.design.file).toBe("design/order-form.figma.json");
    expect(placed.gaps).toContainEqual(
      expect.objectContaining({ from: "5:4", what: "A gift_note column and NewOrder.giftNote" }),
    );
  });
});

describe("the loop in hand-off mode", () => {
  it("hands each draft to the assistant, and a draft with findings hands off again with them", async () => {
    const root = await estateRoot();
    const rt = () => new HandoffRuntime({ root, validate: async () => [], now: () => NOW });
    const first = await featureStage(root, CHANGE, { runtime: rt(), now: NOW });
    expect(first.state).toBe("waiting");
    const run1 = first.waiting!.runId;
    const out = (run: string) => join(root, ".runs", CHANGE, run, "feature-answer.yaml");
    await writeFile(out(run1), PLACED.replace("cap-ordering", "cap-checkout"));
    await rt().done(run1);
    const second = await featureStage(root, CHANGE, { runtime: rt(), now: NOW, resume: run1 });
    // The draft had a finding: a new hand-off asks for the fix.
    expect(second.state).toBe("waiting");
    expect(second.drafts).toBe(1);
    const run2 = second.waiting!.runId;
    expect(run2).not.toBe(run1);
    expect(await readFile(join(root, ".runs", CHANGE, run2, "prompt.md"), "utf8")).toContain(
      "Feature cap-checkout isn't in the catalog",
    );
    await writeFile(out(run2), PLACED);
    await rt().done(run2);
    const third = await featureStage(root, CHANGE, { runtime: rt(), now: NOW, resume: run2 });
    expect(third.state).toBe("done");
    // In hand-off mode the critic ran its rules; its AI lenses run with /atticus-critic.
    expect(third.notes.join("\n")).toContain(
      "its AI lenses run with /atticus-critic add-fraud-check",
    );
  });
});

async function featured(root: string): Promise<void> {
  const r = await featureStage(root, CHANGE, { runtime: assistant([PLACED]), now: NOW });
  expect(r.state).toBe("done");
}

describe("the architecture stage", () => {
  it("writes the target flows as flow deltas, with interface and data changes read off them", async () => {
    const root = await estateRoot();
    await featured(root);
    const prompts: string[] = [];
    // The first draft writes to a table the catalog doesn't have without saying it is new.
    const bad = DELTAS.replace("table: forge-orders-db.orders", "table: forge-orders-db.purchases");
    const r: StageResult<unknown> = await architectureStage(root, CHANGE, {
      runtime: assistant([bad, DELTAS], prompts),
      now: NOW,
    });
    expect(r.state).toBe("done");
    expect(r.drafts).toBe(2);
    expect(prompts[0]).toContain("kind: Flow");
    expect(prompts[0]).toContain("forge-orders.place-order");
    expect(prompts[1]).toContain(
      "uses table forge-orders-db.purchases, which the catalog doesn't have",
    );
    const delta = parse(
      await readFile(join(dir(root), "target-flows/forge-orders.place-order.yaml"), "utf8"),
    );
    expect(delta.schemaVersion).toBe(1);
    expect(delta.steps).toHaveLength(3);
    const design = await readFile(join(dir(root), "design.md"), "utf8");
    expect(design).toContain(
      "| forge-orders | northwind-pay | POST /v1/screenings | planned-new | sku, quantity, cardToken, verdict | forge-orders.place-order |",
    );
    expect(design).toContain(
      "- forge-orders-db.orders: new columns fraud_verdict (forge-orders.place-order)",
    );
    // data.md in the shape the critic reads, so its data rules pass on what the deltas say.
    const data = await readFile(join(dir(root), "data.md"), "utf8");
    expect(data).toContain(
      "| forge-orders-db | orders | add column fraud_verdict varchar(20) | V4__add_fraud_verdict.sql |",
    );
    expect(data).toContain("- fraud_verdict in orders is internal.");
    expect(r.notes[0]).toContain("feature PR of add-fraud-check isn't merged yet");
  });

  it("reads an entry point's new fields off a changed entry step as an interface change", async () => {
    const root = await estateRoot();
    const { loadChangeContext } = await import("@maycombhq/changes");
    const e = await loadEstate(root, (await loadChangeContext(root)).records);
    const delta = FlowDelta.parse({
      schemaVersion: 1,
      flow: "forge-orders.place-order",
      repo: "forge-orders",
      change: "modify",
      why: "The order carries a card token.",
      steps: [{ op: "change", step: 1, fields: { reads: ["sku", "quantity", "cardToken"] } }],
    });
    expect(interfaceChanges([delta], e)).toEqual([
      {
        flow: "forge-orders.place-order",
        caller: "its callers",
        callee: "forge-orders",
        operation: "POST /orders",
        status: "planned-modify",
        fields: ["cardToken"],
      },
    ]);
  });

  it("refuses to start before the feature is placed", async () => {
    const root = await estateRoot();
    await expect(
      architectureStage(root, CHANGE, { runtime: assistant([DELTAS]), now: NOW }),
    ).rejects.toThrow("has no feature yet: run atticus change feature add-fraud-check first");
  });
});

describe("the stories stage", () => {
  it("derives stories per repo and a task per changed step, with fields, evidence and a prompt; requests from knowledge with citations", async () => {
    const root = await estateRoot();
    await featured(root);
    expect(
      (await architectureStage(root, CHANGE, { runtime: assistant([DELTAS]), now: NOW })).state,
    ).toBe("done");
    // The first wording forgets the fields in task 1.3's criteria.
    const bad = STORIES.replace(
      "then the orders row holds sku, quantity and fraud_verdict",
      "then the order is saved",
    );
    const prompts: string[] = [];
    const r = await storiesStage(root, CHANGE, {
      runtime: assistant([bad, STORIES], prompts),
      now: NOW,
    });
    expect(r.state).toBe("done");
    expect(prompts[1]).toContain(
      "Task 1.3's criteria name none of the fields it touches (sku, quantity, fraud_verdict)",
    );
    expect(r.stories.map((s) => [s.id, s.repo, s.tasks.map((t) => t.id)])).toEqual([
      ["s1-place-order", "forge-orders", ["1.1", "1.2", "1.3"]],
    ]);
    const t3 = r.stories[0]!.tasks[2]!;
    expect(t3.fields).toEqual(["sku", "quantity", "fraud_verdict"]);
    expect(t3.evidence).toEqual([
      "forge-orders:src/main/java/forge/orders/OrderController.java:13",
    ]);
    const story = await readFile(join(dir(root), "stories/s1-place-order.md"), "utf8");
    expect(story).toContain("Prompt for Copilot or Claude Code:");
    expect(story).toContain(
      "Implement task 1.1 of the change add-fraud-check in the repo forge-orders.",
    );
    expect(story).toContain("It goes to northwind-pay POST /v1/screenings (new).");
    const tasks = await readFile(join(dir(root), "tasks.md"), "utf8");
    expect(tasks).toContain(
      "- [ ] 1.1 Add the call-out step: Northwind Pay screens the order for fraud (story s1-place-order)",
    );
    expect(tasks).toContain(
      "  - Waits for: R1 Network firewall rule (10 working days); R2 Vendor onboarding (20 working days)",
    );
    // The new call to a vendor suggests the firewall rule and vendor onboarding, each citing its item and the step.
    expect(await readFile(join(dir(root), "requests.md"), "utf8")).toBe(
      readFileSync(join(FIX, "expected/requests.md"), "utf8"),
    );
    expect(r.requests.map((x) => [x.item, x.flow, x.step])).toEqual([
      ["firewall-rule-request", "forge-orders.place-order", 1],
      ["vendor-onboarding", "forge-orders.place-order", 1],
    ]);
  });
});

describe("readFigma", () => {
  it("reads screens, fields and actions from the bench's export", () => {
    const d = readFigma(
      readFileSync(join(HERE, "../../../bench/design/vaccinations.figma.json"), "utf8"),
    );
    expect(d.screens.map((s) => s.figmaId)).toEqual(["10:1", "20:1", "30:1", "40:1", "50:1"]);
    const add = d.screens[2]!;
    expect(add.fields.map((f) => [f.figmaId, f.control])).toContainEqual(["30:5", "select"]);
    expect(add.fields.map((f) => [f.figmaId, f.control])).toContainEqual(["30:6", "date"]);
    expect(add.fields.map((f) => [f.figmaId, f.control])).toContainEqual(["30:11", "toggle"]);
    expect(add.actions.map((a) => a.label)).toEqual(["Save vaccination", "Cancel"]);
    const pets = d.screens[1]!;
    expect(pets.fields.map((f) => f.figmaId)).toContain("I20:7;3:6");
    expect(pets.fields.find((f) => f.figmaId === "I20:6;2:1")?.control).toBe("tab");
    expect(d.ids.has("40:6")).toBe(true);
    expect(d.unread).toEqual([]);
  });
});
