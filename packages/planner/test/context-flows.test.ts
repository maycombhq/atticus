import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import { listQuestions, parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import {
  architectureStage,
  criticFindingKind,
  criticRuleChecks,
  EXPAND_AGENT,
  featureStage,
  PlannerError,
  stageRuleKind,
  storiesStage,
} from "../src/index.js";

/**
 * The live dogfood of the stage loops (ADR 0087) showed a change touching five flows, of which
 * one changes, written as five "modify" deltas with no step, then five stories with no
 * Given/When/Then and five machine questions. These tests take the same shape on the Forge
 * estate: no empty delta is written, no empty story either, and a drafting finding that keeps
 * coming back stops the loop with a plain message instead of a question.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const STAGES = join(HERE, "../../../fixtures/stages");
const FIX = join(HERE, "fixtures/context-flows");
const SPECS_CATALOG = join(HERE, "../../../fixtures/specs/catalog.yaml");
const NOW = new Date("2026-10-21T09:00:00Z");
const CHANGE = "add-fraud-check";
const REL = `openspec/changes/${CHANGE}`;
const fixture = (f: string) => readFileSync(join(FIX, f), "utf8");

async function estateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-context-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  const rows = [
    ...(parse(readFileSync(SPECS_CATALOG, "utf8")) as unknown[]),
    ...(parse(readFileSync(join(STAGES, "catalog-extra.yaml"), "utf8")) as unknown[]),
  ];
  for (const r of rows) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(`bad fixture record: ${JSON.stringify(p.issues)}`);
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  for (const r of parse(readFileSync(join(STAGES, "knowledge.yaml"), "utf8")) as unknown[]) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(`bad knowledge record: ${JSON.stringify(p.issues)}`);
    const f = join(root, "knowledge/items", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(join(STAGES, "specs"), join(root, "specs"), { recursive: true });
  await cp(join(FIX, "specs"), join(root, "specs"), { recursive: true });
  await cp(join(STAGES, "changes"), join(root, "openspec/changes"), { recursive: true });
  return root;
}

const dir = (root: string) => join(root, "openspec/changes", CHANGE);

/** A mock assistant: the context expander (on by default) adds nothing; drafts in turn. */
function assistant(drafts: string[], seen: string[] = []) {
  let n = 0;
  return new MockRuntime(
    (req: AiRequest) => {
      if (req.agent.id.endsWith("-critic")) return "findings: []";
      if (req.agent.id === EXPAND_AGENT) return "terms: []\nnames: []\n";
      seen.push(req.pack.prompt);
      return drafts[Math.min(n++, drafts.length - 1)]!;
    },
    { now: () => NOW },
  );
}

async function featured(root: string): Promise<void> {
  const r = await featureStage(root, CHANGE, {
    runtime: assistant([fixture("feature-answer.yaml")]),
    now: NOW,
  });
  expect(r.state).toBe("done");
}

const READ_ONLY = [
  "forge-stock.reserve-stock",
  "forge-orders.cancel-order",
  "forge-orders.list-orders",
  "forge-stock.release-stock",
];

async function stopOf(p: Promise<unknown>): Promise<PlannerError> {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(PlannerError);
  return e as PlannerError;
}

describe("a flow the change only reads", () => {
  it("is never written as a target flow; the check hands an empty modify delta back, and design.md lists it as read", async () => {
    const root = await estateRoot();
    await featured(root);
    const prompts: string[] = [];
    const r = await architectureStage(root, CHANGE, {
      runtime: assistant(
        [fixture("architecture-empty-deltas.yaml"), fixture("architecture-reads.yaml")],
        prompts,
      ),
      now: NOW,
    });
    expect(r.state).toBe("done");
    expect(r.drafts).toBe(2);
    // The format asks for reads; the second draft got each empty delta back.
    expect(prompts[0]).toContain("put it under reads, never under flows with no steps");
    for (const f of READ_ONLY)
      expect(prompts[1]).toContain(
        `Flow ${f} is marked modify but adds, changes and removes no step.`,
      );
    expect(await readdir(join(dir(root), "target-flows"))).toEqual([
      "forge-orders.place-order.yaml",
    ]);
    expect(r.answer!.flows.map((d) => d.flow)).toEqual(["forge-orders.place-order"]);
    expect(r.answer!.reads.map((x) => x.flow)).toEqual(READ_ONLY);
    const design = await readFile(join(dir(root), "design.md"), "utf8");
    expect(design).toContain("## Flows read, unchanged");
    expect(design).toContain(
      "- forge-orders.cancel-order (A client cancels an order): A refused order is never saved, so it can't be cancelled.",
    );
    expect(design).not.toContain("### forge-orders.cancel-order");
  });

  it("stops with a plain message, not a question, when the assistant keeps writing empty deltas; nothing empty is on disk", async () => {
    const root = await estateRoot();
    await featured(root);
    const e = await stopOf(
      architectureStage(root, CHANGE, {
        runtime: assistant([fixture("architecture-empty-deltas.yaml")]),
        now: NOW,
      }),
    );
    expect(e.code).toBe("stopped");
    expect(e.message).toContain(
      "The architecture stage stopped after 3 drafts: your assistant kept getting these wrong, and they aren't questions for a person to decide.",
    );
    expect(e.message).toContain(
      `  - Flow forge-orders.cancel-order is marked modify but adds, changes and removes no step. A flow the change only reads or relies on is context, not a target flow: list it under reads with why. If the change does change it, give the steps. (rule delta.empty; in ${REL}/target-flows/)`,
    );
    expect(e.message).toContain(
      `Fix ${REL}/target-flows/, or tell your assistant how; then run atticus change architecture ${CHANGE} again.`,
    );
    expect(e.problems).toHaveLength(5);
    expect((await listQuestions(root, { state: "open" })).questions).toEqual([]);
    expect(await readdir(join(dir(root), "target-flows"))).toEqual([
      "forge-orders.place-order.yaml",
    ]);
    const loop = parse(await readFile(join(dir(root), "stage/architecture.yaml"), "utf8"));
    expect(loop.state).toBe("stopped");
    expect(loop.findings.filter((f: { rule: string }) => f.rule === "delta.empty")).toHaveLength(4);
    // A rerun checks what is on file before drafting: the target flows there are right, so
    // the stage is done without a draft.
    const again = await architectureStage(root, CHANGE, {
      runtime: assistant([fixture("architecture-empty-deltas.yaml")]),
      now: NOW,
    });
    expect(again.state).toBe("done");
    expect(again.drafts).toBe(0);
    expect(await readFile(join(dir(root), "design.md"), "utf8")).toContain(
      "## Flows read, unchanged",
    );
  });
});

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
`;

async function architected(root: string): Promise<void> {
  await featured(root);
  const r = await architectureStage(root, CHANGE, {
    runtime: assistant([fixture("architecture-reads.yaml")]),
    now: NOW,
  });
  expect(r.state).toBe("done");
}

describe("stories from a change that reads more flows than it changes", () => {
  it("writes one story for the one flow that changes, and none for an empty delta on disk", async () => {
    const root = await estateRoot();
    await architected(root);
    // A person-written (or older) empty delta in target-flows/ gets no story either.
    await writeFile(
      join(dir(root), "target-flows/forge-orders.list-orders.yaml"),
      "schemaVersion: 1\nflow: forge-orders.list-orders\nrepo: forge-orders\nchange: modify\nwhy: No step changes.\nsteps: []\n",
    );
    const r = await storiesStage(root, CHANGE, { runtime: assistant([STORIES]), now: NOW });
    expect(r.state).toBe("done");
    expect(r.stories.map((s) => s.id)).toEqual(["s1-place-order"]);
    expect(await readdir(join(dir(root), "stories"))).toEqual(["s1-place-order.md"]);
    expect(await readFile(join(dir(root), "stories.md"), "utf8")).not.toContain("list-orders");
    expect(r.notes.join("\n")).toContain(
      "No story for target-flows/forge-orders.list-orders.yaml: it is marked modify but changes no step, so it is context, not a change.",
    );
    expect((await listQuestions(root, { state: "open" })).questions).toEqual([]);
  });

  it("stops with the finding and the file to fix when the criteria keep missing; no question is raised", async () => {
    const root = await estateRoot();
    await architected(root);
    const missing = STORIES.replace(
      `      - id: "1.3"
        criteria:
          - text: "Given an accepted order, when it is saved, then the orders row holds sku, quantity and fraud_verdict"
            checks: [sku, quantity, fraud_verdict]
`,
      `      - id: "1.3"
        criteria: []
`,
    );
    const e = await stopOf(storiesStage(root, CHANGE, { runtime: assistant([missing]), now: NOW }));
    expect(e.code).toBe("stopped");
    expect(e.message).toContain(
      "The stories stage stopped after 3 drafts: your assistant kept getting this wrong, and it isn't a question for a person to decide.",
    );
    expect(e.message).toContain(
      `  - Task 1.3 (Change the write step: The order is inserted with the screen's verdict) has no acceptance criteria. (rule stories.no-criteria; in ${REL}/stage/stories-answer.yaml)`,
    );
    expect(e.message).toContain(`then run atticus plan stories ${CHANGE} again.`);
    expect((await listQuestions(root, { state: "open" })).questions).toEqual([]);

    // A person fixes the answer file; the rerun checks it, writes the stories from it and is
    // done without drafting.
    const answer = join(dir(root), "stage/stories-answer.yaml");
    const fixed = (await readFile(answer, "utf8")).replace(
      '      - id: "1.3"\n        criteria: []',
      '      - id: "1.3"\n        criteria:\n          - text: Given an accepted order, when it is saved, then the orders row holds sku, quantity and fraud_verdict\n            checks: [sku, quantity, fraud_verdict]',
    );
    expect(fixed).not.toBe(await readFile(answer, "utf8"));
    await writeFile(answer, fixed);
    const again = await storiesStage(root, CHANGE, { runtime: assistant([missing]), now: NOW });
    expect(again.state).toBe("done");
    expect(again.drafts).toBe(0);
    expect(await readFile(join(dir(root), "stories/s1-place-order.md"), "utf8")).toContain(
      "the orders row holds sku, quantity and fraud_verdict",
    );
  });
});

describe("a critic finding about drafting quality", () => {
  it("stops the loop with the story file and the answer file to fix, not a question", async () => {
    const root = await estateRoot();
    await architected(root);
    // Criteria that name the fields but aren't Given/When/Then: the stage's check passes, the
    // critic's story rule (a drafting check) doesn't, three drafts in a row. (The critic reviews
    // only a draft that passes the stage's checks, so task 1.2's criterion still names verdict.)
    const plain = STORIES.replace(/"Given [^,]+, when [^,]+, then /g, '"').replace(
      '"it is refused with 422',
      '"an order with a rejected verdict is refused with 422',
    );
    const e = await stopOf(storiesStage(root, CHANGE, { runtime: assistant([plain]), now: NOW }));
    expect(e.code).toBe("stopped");
    // The finding says what to fix (ADR 0115 addendum, 2026-10-25), as the drafter was told.
    expect(e.message).toMatch(
      new RegExp(
        `  - The critic \\(constitution\\.story-acceptance-criteria\\): Story s1-place-order has an acceptance criteria heading but no Given/When/Then criteria\\. What to fix: [^\\n]+\\. \\(rule constitution\\.story-acceptance-criteria; in ${REL.replace(/[.]/g, "\\.")}/stories/s1-place-order\\.md:`,
      ),
    );
    expect(e.message).toContain(
      `Fix ${REL}/stage/stories-answer.yaml (the stage writes the files above from it), or tell your assistant how; then run atticus plan stories ${CHANGE} again.`,
    );
    expect((await listQuestions(root, { state: "open" })).questions).toEqual([]);
  });
});

describe("which findings a person can decide", () => {
  it("splits critic findings by their rule's check, and stage findings by their rule", async () => {
    const root = await estateRoot();
    const checks = await criticRuleChecks(root);
    const issue = (rule: string) => ({ rule, kind: "issue" as const });
    // Drafting quality: a person has nothing to decide.
    expect(criticFindingKind(issue("constitution.story-acceptance-criteria"), checks)).toBe(
      "drafting",
    );
    expect(criticFindingKind(issue("constitution.spec-scenarios-present"), checks)).toBe(
      "drafting",
    );
    // The design and the data: a person decides.
    expect(criticFindingKind(issue("constitution.interface-approved-pattern"), checks)).toBe(
      "decision",
    );
    expect(criticFindingKind(issue("constitution.data-retention-stated"), checks)).toBe("decision");
    // An owner question, and a rule Atticus doesn't know, go to a person.
    expect(
      criticFindingKind(
        { rule: "constitution.story-acceptance-criteria", kind: "knowledge-gap" },
        checks,
      ),
    ).toBe("decision");
    expect(criticFindingKind(issue("team.some-ai-rule"), checks)).toBe("decision");
    expect(stageRuleKind("delta.empty")).toBe("drafting");
    expect(stageRuleKind("stories.no-criteria")).toBe("drafting");
    expect(stageRuleKind("feature.unknown-feature")).toBe("decision");
    expect(stageRuleKind("delta.no-retention")).toBe("decision");
  });

  it("an org rule reusing a drafting check is drafting too", async () => {
    const root = await estateRoot();
    await mkdir(join(root, "org-pack/checklists"), { recursive: true });
    await writeFile(
      join(root, "org-pack/checklists/stories.yaml"),
      `schemaVersion: 1
name: forge-stories
version: 1.0.0
description: Forge's story rules.
rules:
  - id: forge.story-criteria
    title: Every story has acceptance criteria
    layer: org
    lens: story
    appliesTo: { artifacts: [stories] }
    severity: blocking
    check: { type: deterministic, check: story-has-acceptance-criteria }
    waivable: false
    source: Forge
    needs: []
`,
    );
    const checks = await criticRuleChecks(root);
    expect(criticFindingKind({ rule: "forge.story-criteria", kind: "issue" }, checks)).toBe(
      "drafting",
    );
  });
});
