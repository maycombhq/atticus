import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { HandoffRuntime, MockRuntime, type AiRequest } from "@maycombhq/ai";
import {
  listQuestions,
  memoryJudgments,
  parseRecord,
  recordPath,
  serializeRecord,
} from "@maycombhq/core";
import {
  architectureStage,
  checkDeltas,
  stageRuleKind,
  flowBase,
  mergeDelta,
  FlowDelta,
  interfaceChanges,
  loadEstate,
  featureStage,
  readFigma,
  storiesStage,
  coverageIssues,
  EXPAND_AGENT,
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

/**
 * Turn the expansion off for a hand-off test about something else (the lenses, a lost draft),
 * where its extra round is noise; "the loop in hand-off mode" keeps the real default.
 */
async function noExpansion(root: string): Promise<string> {
  await writeFile(
    join(root, "org-pack/runtime.yaml"),
    "schemaVersion: 1\nassistants: { allowed: [copilot], default: copilot }\nretrieval: { expansion: false }\n",
  );
  return root;
}

/**
 * The context expander's answer for the brief (ADR 0116, on by default since its addendum): what
 * the brief is about in the estate's words, and the one name it uses, mapped to its id.
 */
const EXPANSION = `terms: [fraud screen, place order, reserve stock]
names:
  - { name: Northwind Pay, id: northwind-pay, quote: screened by Northwind Pay }
`;

/**
 * A mock assistant: the context expander reads the brief, the stage's drafter answers from
 * `drafts` in turn, and critic lenses find nothing.
 */
function assistant(drafts: string[], seen: string[] = []) {
  let n = 0;
  return new MockRuntime(
    (req: AiRequest) => {
      if (req.agent.id.endsWith("-critic")) return "findings: []";
      if (req.agent.id === EXPAND_AGENT) return EXPANSION;
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
          - text: "Given a new order, when it is placed, then sku, quantity and cardToken are sent to Northwind Pay and the verdict is read"
            checks: [sku, quantity, cardToken, verdict]
      - id: "1.2"
        criteria:
          - text: "Given a rejected verdict, when the order is placed, then the verdict refuses it with 422 and no stock is reserved"
            checks: [verdict]
      - id: "1.3"
        criteria:
          - text: "Given an accepted order, when it is saved, then the orders row holds sku, quantity and fraud_verdict"
            checks: [sku, quantity, fraud_verdict]
requests:
  - item: firewall-rule-request
    flow: forge-orders.place-order
    step: 1
    why: The new call reaches the Northwind Pay host.
    quote: "including every new vendor host"
  - item: vendor-onboarding
    flow: forge-orders.place-order
    step: 1
    why: The order's details go to Northwind Pay for the first time.
    quote: "Before a service sends any data to a vendor for the first time."
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
    // The critic ran on the draft that passed the stage's checks; the first went back first.
    const loop = parse(await readFile(join(dir(root), "stage/feature.yaml"), "utf8"));
    expect(loop.critic.length).toBe(1);
    expect(loop.state).toBe("done");
  });

  // P1: a person's edit of a stage's file is that stage's draft, in every stage.
  it("checks a person's edit of feature.yaml as their draft and stops on what fails, never drafting over it", async () => {
    const root = await estateRoot();
    expect(
      (await featureStage(root, CHANGE, { runtime: assistant([PLACED]), now: NOW })).state,
    ).toBe("done");
    const f = join(dir(root), "feature.yaml");
    const theirs = (await readFile(f, "utf8")).replace(
      "forge-stock.reserve-stock",
      "forge-stock.hold-stock",
    );
    await writeFile(f, theirs);
    const prompts: string[] = [];
    const e = await featureStage(root, CHANGE, {
      runtime: assistant([PLACED], prompts),
      now: NOW,
    }).then(
      () => undefined,
      (x: Error) => x,
    );
    expect(prompts).toEqual([]);
    expect(e?.message).toContain(
      `The feature stage checked your edit of openspec/changes/${CHANGE}/feature.yaml as its draft`,
    );
    expect(e?.message).toContain("forge-stock.hold-stock");
    expect(await readFile(f, "utf8")).toBe(theirs);
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
  it("hands the expansion off first, then each draft, and a draft with findings hands off again with them", async () => {
    // The real default (ADR 0116 addendum): the expansion is on, a round of its own.
    const root = await estateRoot();
    const rt = () => new HandoffRuntime({ root, validate: async () => [], now: () => NOW });
    const rounds: string[] = [];
    const requestOf = async (run: string) =>
      (
        JSON.parse(await readFile(join(root, ".runs", CHANGE, run, "run.json"), "utf8")) as {
          request: {
            agent: { id: string };
            outputPath: string;
            retrieval?: { expansion?: { run?: string; cached: boolean } };
          };
        }
      ).request;
    const expansion = await featureStage(root, CHANGE, { runtime: rt(), now: NOW });
    expect(expansion.state).toBe("waiting");
    const run0 = expansion.waiting!.runId;
    rounds.push((await requestOf(run0)).agent.id);
    expect(rounds).toEqual([EXPAND_AGENT]);
    // The expansion's prompt stays small for the GPT-4o mini floor (a 6,000-token budget).
    const prompt0 = await readFile(join(root, ".runs", CHANGE, run0, "prompt.md"), "utf8");
    expect(prompt0.length).toBeLessThan(6000 * 4);
    await writeFile(
      join(root, ".runs", CHANGE, run0, (await requestOf(run0)).outputPath),
      EXPANSION,
    );
    await rt().done(run0);
    const first = await featureStage(root, CHANGE, { runtime: rt(), now: NOW, resume: run0 });
    expect(first.state).toBe("waiting");
    const run1 = first.waiting!.runId;
    rounds.push((await requestOf(run1)).agent.id);
    expect((await requestOf(run1)).retrieval?.expansion).toMatchObject({ run: run0 });
    const out = (run: string) => join(root, ".runs", CHANGE, run, "feature-answer.yaml");
    await writeFile(out(run1), PLACED.replace("cap-ordering", "cap-checkout"));
    await rt().done(run1);
    const second = await featureStage(root, CHANGE, { runtime: rt(), now: NOW, resume: run1 });
    // The draft had a finding: a new hand-off asks for the fix.
    expect(second.state).toBe("waiting");
    expect(second.drafts).toBe(1);
    const run2 = second.waiting!.runId;
    expect(run2).not.toBe(run1);
    rounds.push((await requestOf(run2)).agent.id);
    expect(await readFile(join(root, ".runs", CHANGE, run2, "prompt.md"), "utf8")).toContain(
      "Feature cap-checkout isn't in the catalog",
    );
    await writeFile(out(run2), PLACED);
    await rt().done(run2);
    const third = await featureStage(root, CHANGE, { runtime: rt(), now: NOW, resume: run2 });
    expect(third.state).toBe("done");
    // One expansion round, kept in the judgments store: the next draft doesn't ask it again.
    expect(rounds).toEqual([EXPAND_AGENT, "feature-placer", "feature-placer"]);
    expect((await requestOf(run2)).retrieval?.expansion).toMatchObject({ cached: true });
    // The org pack has no AI rule at the define gate, so no lens had anything to review.
    expect(third.notes.join("\n")).not.toContain("/atticus-critic");
  });

  it("an expansion answer that fails its check: the step goes on by words and names, with a note, not stuck", async () => {
    const root = await estateRoot();
    const rt = () => new HandoffRuntime({ root, validate: async () => [], now: () => NOW });
    const first = await featureStage(root, CHANGE, { runtime: rt(), now: NOW });
    const run0 = first.waiting!.runId;
    const req = JSON.parse(await readFile(join(root, ".runs", CHANGE, run0, "run.json"), "utf8"))
      .request as { agent: { id: string }; outputPath: string };
    expect(req.agent.id).toBe(EXPAND_AGENT);
    await writeFile(join(root, ".runs", CHANGE, run0, req.outputPath), "not: [yaml");
    await rt().done(run0);
    const second = await featureStage(root, CHANGE, { runtime: rt(), now: NOW, resume: run0 });
    // The step's own draft is handed off: the expansion was left out and said so.
    expect(second.state).toBe("waiting");
    const main = JSON.parse(
      await readFile(join(root, ".runs", CHANGE, second.waiting!.runId, "run.json"), "utf8"),
    ) as { request: { agent: { id: string }; retrieval?: unknown } };
    expect(main.request.agent.id).toBe("feature-placer");
    expect(main.request.retrieval).toBeUndefined();
    expect(second.context?.note).toMatch(
      /the model's expansion was left out: the expansion isn't YAML with terms and names/,
    );
  });

  it("run again without --resume, it waits on the same expansion prompt, then reads its answer in", async () => {
    const root = await estateRoot();
    const rt = () => new HandoffRuntime({ root, validate: async () => [], now: () => NOW });
    const first = await featureStage(root, CHANGE, { runtime: rt(), now: NOW });
    const run0 = first.waiting!.runId;
    const again = await featureStage(root, CHANGE, { runtime: rt(), now: NOW });
    expect(again).toMatchObject({ state: "waiting", waiting: { runId: run0 } });
    const req = JSON.parse(await readFile(join(root, ".runs", CHANGE, run0, "run.json"), "utf8"))
      .request as { outputPath: string };
    await writeFile(join(root, ".runs", CHANGE, run0, req.outputPath), EXPANSION);
    await rt().done(run0);
    // The runner lost its place: no --resume, and the answer is still read in, not asked again.
    const third = await featureStage(root, CHANGE, { runtime: rt(), now: NOW });
    expect(third.state).toBe("waiting");
    const main = JSON.parse(
      await readFile(join(root, ".runs", CHANGE, third.waiting!.runId, "run.json"), "utf8"),
    ) as { request: { agent: { id: string }; retrieval?: { expansion?: { run?: string } } } };
    expect(main.request.agent.id).toBe("feature-placer");
    expect(main.request.retrieval?.expansion?.run).toBe(run0);
  });
});

describe("the critic's AI lenses in hand-off mode (ADR 0115)", () => {
  /** The estate, with the define gate's two AI rules (a business lens and an architecture lens). */
  async function withLenses(): Promise<string> {
    const root = await noExpansion(await estateRoot());
    await cp(join(FIX, "lenses/checklists"), join(root, "org-pack/checklists"), {
      recursive: true,
    });
    return root;
  }
  const runJson = async (root: string, run: string) =>
    JSON.parse(await readFile(join(root, ".runs", CHANGE, run, "run.json"), "utf8")) as {
      request: { outputPath: string; outputIn?: string };
    };
  const roundMeta = async (root: string, round: number) =>
    parse(
      await readFile(join(dir(root), "review/define", String(round), "meta/round.yaml"), "utf8"),
    ) as { lenses: { lens: string; state: string; artifacts: string[]; runId?: string }[] };

  it("hands each lens off after a draft passes the rules, hands a lens finding back, and is done when none blocks", async () => {
    const root = await withLenses();
    const rt = () => new HandoffRuntime({ root, validate: async () => [], now: () => NOW });
    const out = (run: string, file: string) => join(root, ".runs", CHANGE, run, file);
    const step = (resume?: string) =>
      featureStage(root, CHANGE, { runtime: rt(), now: NOW, ...(resume ? { resume } : {}) });

    // The draft.
    const first = await step();
    expect(first.state).toBe("waiting");
    const draft1 = first.waiting!.runId;
    await writeFile(out(draft1, "feature-answer.yaml"), PLACED);
    await rt().done(draft1);

    // It passes the rules, so the first question's lens is handed off: the draft and the estate
    // with it. The fixture's rules are written for the old architecture and business lenses; they
    // ask whether the draft is true to the code and whether it is complete (ADR 0124 addendum,
    // Part 4), and the lenses go out in the questions' order.
    const second = await step(draft1);
    expect(second.state).toBe("waiting");
    expect(second.waiting).toMatchObject({ lens: "true" });
    const truth = second.waiting!.runId;
    expect((await runJson(root, truth)).request).toMatchObject({
      outputPath: "findings-true.yaml",
      outputIn: "run",
    });
    const prompt = await readFile(join(root, ".runs", CHANGE, truth, "prompt.md"), "utf8");
    expect(prompt).toContain(
      "Review the draft against the estate and the brief, including what the draft left out",
    );
    expect(prompt).toContain("Flow forge-stock.reserve-stock (read)");
    expect(prompt).toContain("flow forge-orders.place-order (repo forge-orders");
    // The round waits for both lenses; the rules ran.
    expect((await roundMeta(root, 1)).lenses.map((l) => [l.lens, l.state])).toEqual([
      ["true", "waiting"],
      ["complete", "waiting"],
    ]);

    // The true lens finds what no rule can: the screen changes how stock is reserved.
    await writeFile(
      out(truth, "findings-true.yaml"),
      `findings:
  - rule: flow-use-matches-estate
    artifact: feature.md
    summary: Reserving stock now waits for the screen's verdict, so its steps change; the placement says it is only read.
    why: A flow marked read gets no target flow, so the architecture stage would leave its new step out.
    fix: Mark forge-stock.reserve-stock as changed.
    evidence:
      - { path: feature.md, quote: "Flow forge-stock.reserve-stock (read)" }
`,
    );
    await rt().done(truth);
    // The complete lens is next; its finding waits until every lens is in.
    const third = await step(truth);
    expect(third.state).toBe("waiting");
    expect(third.waiting).toMatchObject({ lens: "complete" });
    const complete = third.waiting!.runId;
    expect(third.drafts).toBe(0);
    await writeFile(out(complete, "findings-complete.yaml"), "findings: []\n");
    await rt().done(complete);
    const fourth = await step(complete);
    // The finding goes back to the next draft, as a rule's finding does.
    expect(fourth.state).toBe("waiting");
    expect(fourth.waiting!.lens).toBeUndefined();
    const draft2 = fourth.waiting!.runId;
    expect((await runJson(root, draft2)).request.outputPath).toBe("feature-answer.yaml");
    expect(await readFile(join(root, ".runs", CHANGE, draft2, "prompt.md"), "utf8")).toContain(
      "The critic (flow-use-matches-estate): Reserving stock now waits for the screen's verdict",
    );
    // The round records both lenses as run, and the finding.
    expect((await roundMeta(root, 1)).lenses.map((l) => [l.lens, l.state])).toEqual([
      ["true", "ran"],
      ["complete", "ran"],
    ]);
    expect((await roundMeta(root, 1)).lenses[0]!.artifacts).toContain("feature.md");

    // The fixed draft; both lenses find nothing, and the stage is done.
    await writeFile(
      out(draft2, "feature-answer.yaml"),
      PLACED.replace("    how: read\n", "    how: changed\n"),
    );
    await rt().done(draft2);
    let r = await step(draft2);
    const lenses: string[] = [];
    while (r.state === "waiting" && r.waiting!.lens) {
      lenses.push(r.waiting!.lens);
      const id = r.waiting!.runId;
      await writeFile(out(id, `findings-${r.waiting!.lens}.yaml`), "findings: []\n");
      await rt().done(id);
      r = await step(id);
    }
    expect(lenses).toEqual(["true", "complete"]);
    expect(r.state).toBe("done");
    expect(r.iteration).toBe(2);
    expect((await roundMeta(root, 2)).lenses.every((l) => l.state === "ran")).toBe(true);
    const loop = parse(await readFile(join(dir(root), "stage/feature.yaml"), "utf8"));
    expect(loop.state).toBe("done");
    expect(loop.critic).toEqual([
      { gate: "define", round: 1 },
      { gate: "define", round: 2 },
    ]);
    expect(loop.review).toBeUndefined();
  });

  it("a rerun before a lens is answered says the lens is still waiting", async () => {
    const root = await withLenses();
    const rt = () => new HandoffRuntime({ root, validate: async () => [], now: () => NOW });
    const first = await featureStage(root, CHANGE, { runtime: rt(), now: NOW });
    await writeFile(
      join(root, ".runs", CHANGE, first.waiting!.runId, "feature-answer.yaml"),
      PLACED,
    );
    await rt().done(first.waiting!.runId);
    const second = await featureStage(root, CHANGE, {
      runtime: rt(),
      now: NOW,
      resume: first.waiting!.runId,
    });
    const lens = second.waiting!.runId;
    // Resumed before handoff done: the same lens again.
    const again = await featureStage(root, CHANGE, { runtime: rt(), now: NOW, resume: lens });
    expect(again.state).toBe("waiting");
    expect(again.waiting).toEqual({ runId: lens, lens: "true" });
    // Run without --resume: still waiting on it.
    const plain = await featureStage(root, CHANGE, { runtime: rt(), now: NOW });
    expect(plain.waiting).toEqual({ runId: lens, lens: "true" });
  });

  it("a draft that fails the stage's checks isn't sent to the lenses", async () => {
    const root = await withLenses();
    const rt = () => new HandoffRuntime({ root, validate: async () => [], now: () => NOW });
    const first = await featureStage(root, CHANGE, { runtime: rt(), now: NOW });
    const run1 = first.waiting!.runId;
    await writeFile(
      join(root, ".runs", CHANGE, run1, "feature-answer.yaml"),
      PLACED.replace("cap-ordering", "cap-checkout"),
    );
    await rt().done(run1);
    const second = await featureStage(root, CHANGE, { runtime: rt(), now: NOW, resume: run1 });
    expect(second.state).toBe("waiting");
    expect(second.waiting!.lens).toBeUndefined();
    // Nor does it use a critic round (H3: a gate's round limit counts reviews of drafts).
    await expect(roundMeta(root, 1)).rejects.toThrow();
  });
});

describe("a stage whose hand-off was lost", () => {
  it("reads in an answer that was checked but never read in, rather than drafting again", async () => {
    const root = await noExpansion(await estateRoot());
    const rt = () => new HandoffRuntime({ root, validate: async () => [], now: () => NOW });
    const first = await featureStage(root, CHANGE, { runtime: rt(), now: NOW });
    const run1 = first.waiting!.runId;
    await writeFile(join(root, ".runs", CHANGE, run1, "feature-answer.yaml"), PLACED);
    await rt().done(run1);
    // The step run again without --resume, as a runner that lost its place would.
    const again = await featureStage(root, CHANGE, { runtime: rt(), now: NOW });
    expect(again.state).toBe("done");
    expect(again.notes.join("\n")).toContain(`Run ${run1} was checked; reading its answer in.`);
  });

  it("says the draft is still with the assistant while its run waits, and drafts again once the run is gone", async () => {
    const root = await noExpansion(await estateRoot());
    const rt = () => new HandoffRuntime({ root, validate: async () => [], now: () => NOW });
    const first = await featureStage(root, CHANGE, { runtime: rt(), now: NOW });
    const run1 = first.waiting!.runId;
    const again = await featureStage(root, CHANGE, { runtime: rt(), now: NOW });
    expect(again).toMatchObject({ state: "waiting", waiting: { runId: run1 } });
    // The run's folder is deleted (a cleaned .runs/, another machine): hand off a new draft.
    await rm(join(root, ".runs", CHANGE, run1), { recursive: true, force: true });
    const fresh = await featureStage(root, CHANGE, { runtime: rt(), now: NOW });
    expect(fresh.state).toBe("waiting");
    // A new run: its prompt is there again (the test's clock is fixed, so its id may repeat).
    expect(
      await readFile(join(root, ".runs", CHANGE, fresh.waiting!.runId, "prompt.md"), "utf8"),
    ).toContain("Feature");
    expect(fresh.notes.join("\n")).toContain(`Run ${run1} is no longer there`);
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
    expect(delta.schemaVersion).toBe(2);
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

  // ADR 0111: each entry, table and column a delta names is resolved against the catalog.
  it("resolves a call's entry, a new table and the columns read against the catalog", async () => {
    const root = await estateRoot();
    const { loadChangeContext } = await import("@maycombhq/changes");
    const e = await loadEstate(root, (await loadChangeContext(root)).records);
    const call = (entry: string, isNew: boolean, component = "forge-stock") => ({
      op: "add" as const,
      after: 1,
      kind: "call-out" as const,
      what: "A call",
      to: { component, entry, new: isNew },
      fields: { sends: ["sku"] },
    });
    const d = FlowDelta.parse({
      schemaVersion: 2,
      flow: "forge-orders.place-order",
      repo: "forge-orders",
      change: "modify",
      why: "x",
      steps: [
        call("POST /stock/reserve", false),
        call("POST /stock/reservations", true),
        call("POST /stock/reservations", false),
        call("POST /v1/screenings", true, "northwind-pay"),
        {
          op: "add",
          after: 1,
          kind: "write",
          what: "A table",
          store: {
            table: "forge-orders-db.orders",
            columns: ["sku"],
            new: true,
            retention: "7 years",
          },
        },
        {
          op: "add",
          after: 1,
          kind: "read",
          what: "Read back",
          store: { table: "forge-orders-db.orders", columns: ["sku", "colour", "fraud_verdict"] },
        },
        {
          op: "change",
          step: 4,
          kind: "write",
          what: "Insert",
          store: {
            table: "forge-orders-db.orders",
            columns: ["sku", "fraud_verdict"],
            types: { fraud_verdict: "varchar(20)" },
            classification: { fraud_verdict: "internal" },
            migration: "V4__add_fraud_verdict.sql",
          },
        },
      ],
    });
    const p = { flows: [], newFlows: [], change: CHANGE } as unknown as Parameters<
      typeof checkDeltas
    >[2];
    const got = checkDeltas([d], e, p).map((i) => [i.rule, i.target]);
    expect(got).toEqual([
      ["delta.unknown-entry", "forge-orders.place-order#1"],
      ["delta.entry-exists", "forge-orders.place-order#2"],
      ["delta.table-exists", "forge-orders.place-order#5"],
      ["delta.unknown-column", "forge-orders.place-order#6:colour"],
    ]);
    const msg = checkDeltas([d], e, p).find((i) => i.rule === "delta.unknown-entry")!.message;
    expect(msg).toBe(
      "Change 1 to forge-orders.place-order calls POST /stock/reserve on forge-stock, which the catalog doesn't have; it has POST /stock/reservations. Use one of them, or new: true for an entry this change adds.",
    );
  });

  // ADR 0111: a target flow is pinned to the version of today's flow it was written against.
  it("pins each target flow to today's flow, and says when today's flow changed since", async () => {
    const root = await estateRoot();
    await featured(root);
    const r = await architectureStage(root, CHANGE, { runtime: assistant([DELTAS]), now: NOW });
    expect(r.state).toBe("done");
    const file = join(dir(root), "target-flows/forge-orders.place-order.yaml");
    const written = FlowDelta.parse(parse(await readFile(file, "utf8")));
    const { loadChangeContext } = await import("@maycombhq/changes");
    const e = await loadEstate(root, (await loadChangeContext(root)).records);
    const today = e.flowById.get("forge-orders.place-order")!.flow;
    expect(written.schemaVersion).toBe(2);
    expect(written.base).toEqual({ steps: flowBase(today) });
    expect(mergeDelta(written, today).problems).toEqual([]);
    // The spec is drafted again with a step put in front: the target's step numbers are stale.
    const redrafted = {
      ...today,
      steps: [{ ...today.steps[0]!, what: "The request is logged" }, ...today.steps],
    };
    expect(mergeDelta(written, redrafted).problems).toEqual([
      "Today's flow forge-orders.place-order changed since this target was written, so its step numbers may point at other steps now. Check them, then run atticus change architecture again.",
    ]);
    expect(
      checkDeltas(
        [written],
        {
          ...e,
          flowById: new Map([
            ["forge-orders.place-order", { repo: "forge-orders", flow: redrafted }],
          ]),
        },
        { flows: [], newFlows: [] } as never,
      ).map((i) => i.rule),
    ).toContain("delta.stale");
    // A file from before the pin still reads, and says it isn't pinned.
    const { base: _b, ...old } = written;
    const v1 = FlowDelta.parse({ ...old, schemaVersion: 1 });
    expect(mergeDelta(v1, today).problems).toEqual([
      "This target of forge-orders.place-order was written before target flows were pinned to today's flow, so a change to today's flow can't be seen. Check its step numbers, then run atticus change architecture again to pin it.",
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
    // The first wording checks only some of task 1.3's fields.
    const bad = STORIES.replace("checks: [sku, quantity, fraud_verdict]", "checks: [sku]");
    const prompts: string[] = [];
    const r = await storiesStage(root, CHANGE, {
      runtime: assistant([bad, STORIES], prompts),
      now: NOW,
    });
    expect(r.state).toBe("done");
    expect(prompts[1]).toContain("Task 1.3's criteria check no value of quantity, fraud_verdict");
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

// Found on a real metarepo: a criterion that checks a field without naming it ("then
// unreadCount is 4, counting messages after joinedAt" checks lastReadAt) was refused three
// drafts running in hand-off mode, and the stage stopped. Whether a criterion checks a field is
// meaning (ADR 0117): a judge reads it where a model is called directly; with a hand-off it is
// left unjudged, a note for the story lens and the reviewer, never a hard stop.
describe("a criterion that checks a field without naming it", () => {
  const UNNAMED = STORIES.replace(
    "then the orders row holds sku, quantity and fraud_verdict",
    "then the orders row holds sku, quantity and what the screen decided",
  );
  const CLAIM = {
    task: "1.3",
    repo: "forge-orders",
    field: "fraud_verdict",
    criterion:
      "Given an accepted order, when it is saved, then the orders row holds sku, quantity and what the screen decided",
  };
  /** A runtime that calls a model directly, answering the judge with one verdict. */
  class Judge extends MockRuntime {
    override readonly kind = "model" as const;
    constructor(verdict: string, quote = "what the screen decided") {
      super(
        () =>
          `judgments:\n  - item: 1\n    verdict: ${verdict}\n    quotes: [{ of: criterion, text: "${quote}" }]\n`,
        { now: () => NOW },
      );
    }
  }

  it("in hand-off mode is a note for the story lens and the reviewer, and the stage is done", async () => {
    const root = await estateRoot();
    await featured(root);
    await architectureStage(root, CHANGE, { runtime: assistant([DELTAS]), now: NOW });
    const r = await storiesStage(root, CHANGE, { runtime: assistant([UNNAMED]), now: NOW });
    expect(r.state).toBe("done");
    expect(r.drafts).toBe(1);
    const note = r.findings.find((f) => f.rule === "stories.check-unjudged");
    expect(note).toMatchObject({ blocking: false, target: "1.3:fraud_verdict" });
    expect(r.findings.some((f) => f.rule === "stories.check-not-in-criterion")).toBe(false);
    // The story file says so, where the story lens and the PR's reviewer read it.
    const story = await readFile(join(dir(root), "stories/s1-place-order.md"), "utf8");
    expect(story).toContain(
      "  - Not judged yet: this criterion says it checks fraud_verdict without naming it. The story lens and the reviewer confirm it does (judgments/covers-field/ keeps a verdict).",
    );
  });

  it("with a direct model, asks the judge: yes passes, no goes back, unsure is a note", async () => {
    const store = memoryJudgments();
    const at = { store, change: CHANGE, now: NOW };
    expect(await coverageIssues([CLAIM], { ...at, runtime: new Judge("yes") })).toEqual([]);
    const no = await coverageIssues([CLAIM], {
      store: memoryJudgments(),
      change: CHANGE,
      now: NOW,
      runtime: new Judge("no", "the orders row holds sku, quantity"),
    });
    expect(no).toMatchObject([
      { rule: "stories.check-not-in-criterion", blocking: true, kind: "decision" },
    ]);
    expect(no[0]!.message).toContain("says its outcome doesn't depend on that field's value");
    const unsure = await coverageIssues([CLAIM], {
      store: memoryJudgments(),
      change: CHANGE,
      now: NOW,
      runtime: new Judge("unsure"),
    });
    expect(unsure).toMatchObject([{ rule: "stories.check-unjudged", blocking: false }]);
    // With no direct model nothing is asked, and nothing is guessed.
    const handoff = await coverageIssues([CLAIM], {
      store: memoryJudgments(),
      change: CHANGE,
      now: NOW,
    });
    expect(handoff).toMatchObject([{ rule: "stories.check-unjudged", blocking: false }]);
    // The verdict the judge gave is kept: the same claim asks no model again.
    expect(await coverageIssues([CLAIM], { ...at })).toEqual([]);
  });

  it("keeps the fact checks: a field under no criterion's checks, and a check that isn't a field", async () => {
    const root = await estateRoot();
    await featured(root);
    await architectureStage(root, CHANGE, { runtime: assistant([DELTAS]), now: NOW });
    const bad = STORIES.replace(
      "checks: [sku, quantity, fraud_verdict]",
      "checks: [sku, quantity, colour]",
    );
    const prompts: string[] = [];
    const r = await storiesStage(root, CHANGE, {
      runtime: assistant([bad, STORIES], prompts),
      now: NOW,
    });
    expect(r.state).toBe("done");
    expect(prompts[1]).toContain(
      "a criterion says it checks colour, which isn't one of the task's fields",
    );
    expect(prompts[1]).toContain("Task 1.3's criteria check no value of fraud_verdict");
  });
});

describe("the starter review at each stage (ADR 0120)", () => {
  it("the lenses review each draft with the starter rules, and the brief rides with every lens", async () => {
    const root = await estateRoot();
    await cp(
      join(HERE, "../../naysayer/starter/review.yaml"),
      join(root, "org-pack/checklists/review.yaml"),
    );
    let lenses: { lens: string; prompt: string }[] = [];
    const rt = (drafts: string[]) => {
      let n = 0;
      return new MockRuntime(
        (req: AiRequest) => {
          if (req.agent.id.endsWith("-critic")) {
            lenses.push({ lens: req.agent.id.replace(/-critic$/, ""), prompt: req.pack.prompt });
            return "findings: []";
          }
          return drafts[Math.min(n++, drafts.length - 1)]!;
        },
        { now: () => NOW },
      );
    };
    const brief = /id="brief\.md"/;

    expect((await featureStage(root, CHANGE, { runtime: rt([PLACED]), now: NOW })).state).toBe(
      "done",
    );
    // One lens per question the starter rules ask (ADR 0124 addendum, Part 4), in order.
    expect(lenses.map((l) => l.lens)).toEqual(["true", "complete"]);
    expect(lenses[0]!.prompt).toContain("review.assumed-capability-named");
    expect(lenses[1]!.prompt).toContain("review.brief-outcomes-placed");
    for (const l of lenses) expect(l.prompt, l.lens).toMatch(brief);

    lenses = [];
    const arch = await architectureStage(root, CHANGE, { runtime: rt([DELTAS]), now: NOW });
    expect(arch.state).toBe("done");
    // The starter rules' risk on the call to Northwind Pay (no timeout stated) gets one more
    // draft, handed back with its fix (ADR 0115 addendum, 2026-10-25); the same draft again
    // leaves it a risk, and the stage is done: two rounds of the same three lenses.
    expect(arch.drafts).toBe(2);
    expect(arch.notes.join("\n")).toContain("back to your assistant for one more draft");
    expect(lenses.map((l) => l.lens)).toEqual([
      "true",
      "complete",
      "safe",
      "true",
      "complete",
      "safe",
    ]);
    expect(lenses[0]!.prompt).toContain("review.shown-data-has-a-source");
    expect(lenses[1]!.prompt).toContain("review.outcome-has-target-steps");
    expect(lenses[2]!.prompt).toContain("review.new-column-complete");

    lenses = [];
    const stories = await storiesStage(root, CHANGE, { runtime: rt([STORIES]), now: NOW });
    expect(stories.state).toBe("done");
    // A starter rule's risk gets its one more draft here too.
    expect(stories.drafts).toBe(2);
    const four = ["true", "complete", "safe", "ship"];
    expect(lenses.map((l) => l.lens)).toEqual([...four, ...four]);
    const complete = lenses.find((l) => l.lens === "complete")!.prompt;
    expect(complete).toContain("review.outcome-has-story");
    // The story rules read the stories only; the lens judges them against the brief all the same.
    expect(complete).toMatch(brief);
    expect(lenses.find((l) => l.lens === "ship")!.prompt).toMatch(/id="needs\.yaml"/);
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

// What a small model got wrong on a real estate, said so it can fix it (and never asked of a person).
describe("hand-backs a small model can act on", () => {
  const p = { flows: [], newFlows: [], change: CHANGE } as unknown as Parameters<
    typeof checkDeltas
  >[2];
  const estate = async () => {
    const root = await estateRoot();
    const { loadChangeContext } = await import("@maycombhq/changes");
    return loadEstate(root, (await loadChangeContext(root)).records);
  };
  const delta = (steps: unknown[]) =>
    FlowDelta.parse({
      schemaVersion: 1,
      flow: "forge-orders.place-order",
      repo: "forge-orders",
      change: "modify",
      why: "The order is screened.",
      steps,
    });

  it("names the flow an endpoint starts when an endpoint is named as a flow it reads", async () => {
    const e = await estate();
    const issues = checkDeltas([], e, p, [
      { flow: "forge-orders.post-orders", why: "It reads it." },
    ]);
    const read = issues.find((i) => i.rule === "delta.unknown-read")!;
    expect(read.message).toBe(
      "forge-orders.post-orders under reads is an endpoint, not a flow: the flow it starts is forge-orders.place-order. Name that flow, or leave the read out.",
    );
    expect(stageRuleKind("delta.unknown-read")).toBe("drafting");
  });

  it("says a table is a table when it is written where a component goes", async () => {
    const e = await estate();
    const issues = checkDeltas(
      [
        delta([
          {
            op: "change",
            step: 4,
            kind: "write",
            what: "Saved",
            to: { component: "forge-orders-db.orders", entry: "write" },
          },
        ]),
      ],
      e,
      p,
    );
    expect(issues.find((i) => i.rule === "delta.unknown-component")!.message).toBe(
      "Change 1 to forge-orders.place-order goes to forge-orders-db.orders, which is a table, not a component: a step that reads or writes it names it under store, as store: { table: forge-orders-db.orders, columns: [the columns] }, and has no to.",
    );
  });

  it("says to write the HTTP method itself when an entry starts with METHOD, and lists the nearest entries first", async () => {
    const e = await estate();
    const issues = checkDeltas(
      [
        delta([
          {
            op: "add",
            after: 1,
            kind: "call-out",
            what: "Stock is held",
            to: { component: "forge-stock", entry: "METHOD /stock/reservations" },
          },
        ]),
      ],
      e,
      p,
    );
    expect(issues.find((i) => i.rule === "delta.unknown-entry")!.message).toBe(
      "Change 1 to forge-orders.place-order calls METHOD /stock/reservations on forge-stock: write the HTTP method itself (GET, POST, PUT, PATCH or DELETE), not METHOD. forge-stock has POST /stock/reservations. Use one of them, or new: true for an entry this change adds.",
    );
  });

  it("treats a thing that already exists, or the wrong repo, as the draft's to fix, not a person's to decide", () => {
    for (const r of [
      "delta.exists",
      "delta.entry-exists",
      "delta.table-exists",
      "delta.wrong-repo",
      "delta.stale",
      "delta.unknown-column",
    ])
      expect(stageRuleKind(r), r).toBe("drafting");
    // Whether something is new is still a person's call when the draft keeps saying so.
    for (const r of ["delta.unknown-component", "delta.unknown-entry", "delta.unknown-flow"])
      expect(stageRuleKind(r), r).toBe("decision");
  });
});

describe("the values a write step adds, checked against the catalog and the org pack", () => {
  const p = { flows: [], newFlows: [], change: CHANGE } as unknown as Parameters<
    typeof checkDeltas
  >[2];
  const estate = async () => {
    const root = await estateRoot();
    const { loadChangeContext } = await import("@maycombhq/changes");
    const { estateOf } = await import("../src/index.js");
    const e = await loadEstate(root, (await loadChangeContext(root)).records);
    const extra = [
      {
        kind: "Column",
        schemaVersion: 2,
        id: "forge-orders-db.orders.created-at",
        status: "current",
        confidence: "verified",
        evidence: [
          { source: "code", repo: "forge-orders", path: "src/main/resources/schema.sql", line: 5 },
        ],
        table: "forge-orders-db.orders",
        name: "created_at",
        type: "TIMESTAMP",
      },
      {
        kind: "Migration",
        schemaVersion: 2,
        id: "forge-orders-db.v3",
        status: "current",
        confidence: "verified",
        evidence: [
          {
            source: "migration",
            repo: "forge-orders",
            path: "src/main/resources/db/migration/V3__add_sku.sql",
            line: 1,
          },
        ],
        dataStore: "forge-orders-db",
        file: "src/main/resources/db/migration/V3__add_sku.sql",
        operations: ["alter table orders add column sku"],
        tool: "flyway",
        version: "3",
      },
    ].map((r) => {
      const x = parseRecord(r);
      if (!x.ok) throw new Error(JSON.stringify(x.issues));
      return x.record;
    });
    return estateOf([...e.byId.values(), ...extra] as never, [...e.flowById.values()], []);
  };
  const write = (store: Record<string, unknown>) =>
    FlowDelta.parse({
      schemaVersion: 1,
      flow: "forge-orders.place-order",
      repo: "forge-orders",
      change: "modify",
      why: "The verdict is kept.",
      steps: [
        {
          op: "change",
          step: 4,
          kind: "write",
          what: "Saved",
          store: { table: "forge-orders-db.orders", ...store },
        },
      ],
    });
  const levels = ["public", "internal", "confidential", "restricted"];
  const messages = async (store: Record<string, unknown>) =>
    checkDeltas([write(store)], await estate(), p, [], { levels }).map((i) => [i.rule, i.message]);

  it("says a column added in other casing is the table's own column", async () => {
    const got = await messages({
      columns: ["sku", "createdAt"],
      types: { createdAt: "timestamp" },
      classification: { createdAt: "internal" },
      migration: "V4__created.sql",
    });
    expect(got).toContainEqual([
      "delta.column-name",
      "Change 1 to forge-orders.place-order adds column createdAt to forge-orders-db.orders, but the table has created_at: name the column as the table does.",
    ]);
  });

  it("refuses a classification that isn't one of the org pack's levels", async () => {
    const got = await messages({
      columns: ["fraud_verdict"],
      types: { fraud_verdict: "varchar(20)" },
      classification: { fraud_verdict: "nullable" },
      migration: "V4__add_fraud_verdict.sql",
    });
    expect(got).toContainEqual([
      "delta.bad-classification",
      "Change 1 to forge-orders.place-order classifies column fraud_verdict as nullable, which isn't one of the org pack's levels: public, internal, confidential or restricted. Write one of those words exactly.",
    ]);
  });

  it("asks for a migration file named as the store's migrations are, with the next number", async () => {
    const got = await messages({
      columns: ["fraud_verdict"],
      types: { fraud_verdict: "varchar(20)" },
      classification: { fraud_verdict: "internal" },
      migration: "add_fraud_verdict_to_orders",
    });
    expect(got).toContainEqual([
      "delta.bad-migration",
      "Change 1 to forge-orders.place-order names the migration add_fraud_verdict_to_orders, which isn't how forge-orders-db's migrations are named (Flyway, the newest V3): name the file V4__add_fraud_verdict_to_orders.sql, in src/main/resources/db/migration.",
    ]);
    const ok = await messages({
      columns: ["fraud_verdict"],
      types: { fraud_verdict: "varchar(20)" },
      classification: { fraud_verdict: "internal" },
      migration: "V4__add_fraud_verdict.sql",
    });
    expect(ok.map((x) => x[0])).not.toContain("delta.bad-migration");
  });
});

describe("a write that sends what it doesn't store", () => {
  it("is handed back, naming the field; one the table has, in other casing, is stored", async () => {
    const root = await estateRoot();
    const { loadChangeContext } = await import("@maycombhq/changes");
    const e = await loadEstate(root, (await loadChangeContext(root)).records);
    const d = FlowDelta.parse({
      schemaVersion: 1,
      flow: "forge-orders.place-order",
      repo: "forge-orders",
      change: "modify",
      why: "The verdict is kept.",
      steps: [
        {
          op: "change",
          step: 4,
          kind: "write",
          what: "Saved",
          store: { table: "forge-orders-db.orders", columns: ["sku"] },
          fields: { sends: ["sku", "Quantity", "fraudVerdict"] },
        },
      ],
    });
    const got = checkDeltas([d], e, { flows: [], newFlows: [] } as never).filter(
      (i) => i.rule === "delta.sent-not-stored",
    );
    expect(got.map((i) => i.target)).toEqual(["forge-orders.place-order#1:fraudVerdict"]);
  });
});

describe("a classification a person decides", () => {
  it("offers the org pack's levels as the question's choices", async () => {
    const root = await estateRoot();
    const { loadChangeContext } = await import("@maycombhq/changes");
    const e = await loadEstate(root, (await loadChangeContext(root)).records);
    const d = FlowDelta.parse({
      schemaVersion: 1,
      flow: "forge-orders.place-order",
      repo: "forge-orders",
      change: "modify",
      why: "The verdict is kept.",
      steps: [
        {
          op: "change",
          step: 4,
          kind: "write",
          what: "Saved",
          store: {
            table: "forge-orders-db.orders",
            columns: ["fraud_verdict"],
            types: { fraud_verdict: "varchar(20)" },
            migration: "V4__add_fraud_verdict.sql",
          },
        },
      ],
    });
    const levels = ["public", "internal", "confidential", "restricted"];
    const i = checkDeltas([d], e, { flows: [], newFlows: [] } as never, [], { levels }).find(
      (x) => x.rule === "delta.no-classification",
    )!;
    expect(i.options?.map((o) => o.label)).toEqual(levels);
    expect(i.options?.[1]).toEqual({
      label: "internal",
      means: "fraud_verdict is internal data",
      changes: "The plan classifies forge-orders-db.orders.fraud_verdict as internal",
    });
    expect(stageRuleKind("delta.no-classification")).toBe("decision");
    expect(stageRuleKind("delta.no-type")).toBe("drafting");
  });
});

describe("a field a changed step returns that no step gives", () => {
  const p = { flows: [], newFlows: [] } as never;
  const respond = {
    op: "change",
    step: 5,
    kind: "respond",
    what: "201 with the order and its verdict",
    fields: { returns: ["id", "sku", "quantity", "fraudVerdict"] },
  };
  const delta = (steps: unknown[]) =>
    FlowDelta.parse({
      schemaVersion: 1,
      flow: "forge-orders.place-order",
      repo: "forge-orders",
      change: "modify",
      why: "The verdict comes back.",
      steps,
    });
  const from = async (steps: unknown[]) => {
    const root = await estateRoot();
    const { loadChangeContext } = await import("@maycombhq/changes");
    const e = await loadEstate(root, (await loadChangeContext(root)).records);
    return checkDeltas([delta(steps)], e, p).filter((i) => i.rule === "delta.field-from-nowhere");
  };

  it("is handed back: the plan returns what it never stores, reads or receives", async () => {
    const got = await from([respond]);
    expect(got.map((i) => [i.target, i.message])).toEqual([
      [
        "forge-orders.place-order#1:fraudVerdict",
        "Change 1 to forge-orders.place-order returns fraudVerdict, but no step of the flow receives, reads, writes or works it out, and no table the flow uses has it: add the step that gives it (a write with the new column, its type and its migration), or leave it out.",
      ],
    ]);
    expect(stageRuleKind("delta.field-from-nowhere")).toBe("drafting");
  });

  it("is fine once a step stores it, in whatever casing", async () => {
    const got = await from([
      {
        op: "change",
        step: 4,
        kind: "write",
        what: "The order is saved with its verdict",
        store: {
          table: "forge-orders-db.orders",
          columns: ["sku", "quantity", "fraud_verdict"],
          types: { fraud_verdict: "varchar(20)" },
          classification: { fraud_verdict: "internal" },
          migration: "V4__add_fraud_verdict.sql",
        },
      },
      respond,
    ]);
    expect(got).toEqual([]);
  });
});

describe("a write step that names a component", () => {
  it("is handed back, and its own returns don't vouch for a field", async () => {
    const root = await estateRoot();
    const { loadChangeContext } = await import("@maycombhq/changes");
    const e = await loadEstate(root, (await loadChangeContext(root)).records);
    const d = FlowDelta.parse({
      schemaVersion: 1,
      flow: "forge-orders.place-order",
      repo: "forge-orders",
      change: "modify",
      why: "The verdict is kept.",
      steps: [
        {
          op: "change",
          step: 4,
          kind: "write",
          what: "Saved",
          to: { component: "forge-stock", entry: "POST /stock/reservations" },
          fields: { sends: ["sku"], returns: ["fraudVerdict"] },
        },
      ],
    });
    const rules = checkDeltas([d], e, { flows: [], newFlows: [] } as never).map((i) => i.rule);
    expect(rules).toContain("delta.to-on-store-step");
    expect(rules).toContain("delta.field-from-nowhere");
  });
});
