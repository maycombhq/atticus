import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import {
  listQuestions,
  parseRecord,
  readQuestion,
  recordPath,
  serializeRecord,
} from "@maycombhq/core";
import {
  COMMENT_COMMAND,
  commentOnFinding,
  EXPAND_AGENT,
  featureStage,
  PlannerError,
  stageComments,
} from "../src/index.js";

/**
 * A person's comment on a critic finding, from a stage tab in the app (ADR 0124 addendum D-app,
 * B10): written as a question they answered, listed in the stage's loop file, and read by the
 * stage's next run as a person's answer, so the drafter gets it with the next draft.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "../../../fixtures/stages");
const SPECS_CATALOG = join(HERE, "../../../fixtures/specs/catalog.yaml");
const NOW = new Date("2026-10-24T09:00:00Z");
const CHANGE = "add-fraud-check";
const REL = `openspec/changes/${CHANGE}`;

async function estateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-stage-comments-"));
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

const EXPANSION = `terms: [fraud screen, place order, reserve stock]
names:
  - { name: Northwind Pay, id: northwind-pay, quote: screened by Northwind Pay }
`;

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

function assistant(prompts: string[] = []) {
  return new MockRuntime(
    (req: AiRequest) => {
      if (req.agent.id.endsWith("-critic")) return "findings: []";
      if (req.agent.id === EXPAND_AGENT) return EXPANSION;
      prompts.push(req.pack.prompt);
      return PLACED;
    },
    { now: () => NOW },
  );
}

/** A finding of the define gate, as the critic files it. */
const FINDING = {
  id: "f-0a1b2c3d",
  rule: "review.outcome-has-target-steps",
  summary: "The refusal path names no step that refuses the order.",
  artifact: "feature.yaml",
  line: 12,
  file: `${REL}/review/define/1/f-0a1b2c3d.yaml`,
};

const COMMENT = "Northwind Pay refuses with 402, never 422; refuse the order on 402 and say so.";

describe("a person's comment on a finding", () => {
  it("is written as a question the person answered, listed in the stage's loop file", async () => {
    const root = await estateRoot();
    expect((await featureStage(root, CHANGE, { runtime: assistant(), now: NOW })).state).toBe(
      "done",
    );
    const r = await commentOnFinding(root, {
      change: CHANGE,
      stage: "feature",
      finding: FINDING,
      text: `  ${COMMENT}  `,
      by: "Priya Nair <priya@forge.example>",
      at: "2026-10-24T10:00:00Z",
    });
    expect(r.files).toEqual([`questions/${r.question.id}.yaml`, `${REL}/stage/feature.yaml`]);
    const q = (await readQuestion(root, r.question.id))!;
    expect(q).toMatchObject({
      state: "answered",
      repo: CHANGE,
      askedBy: { step: "change-feature", command: COMMENT_COMMAND },
      evidence: [`${FINDING.file}:1`],
      rerun: "atticus change feature add-fraud-check",
      answer: { text: COMMENT, by: "Priya Nair <priya@forge.example>" },
    });
    expect(q.question).toContain("f-0a1b2c3d (review.outcome-has-target-steps) at feature.yaml:12");
    const loop = parse(await readFile(join(root, REL, "stage/feature.yaml"), "utf8"));
    expect(loop.questions).toContain(r.question.id);
    // Not an open question for anyone: the person answered it as they asked it.
    expect((await listQuestions(root, { state: "open" })).questions).toEqual([]);
    const c = await stageComments(root, CHANGE, "feature");
    expect(c.comments).toEqual([
      expect.objectContaining({ text: COMMENT, read: false, about: FINDING.file }),
    ]);
    // A second comment is a question of its own, so the next run reads it as new.
    const second = await commentOnFinding(root, {
      change: CHANGE,
      stage: "feature",
      finding: FINDING,
      text: "And log the refusal.",
      by: "Priya Nair <priya@forge.example>",
      at: "2026-10-24T10:05:00Z",
    });
    expect(second.question.id).not.toBe(r.question.id);
    expect(second.question.question).toMatch(/^Comment 2 on the critic's finding/);
  });

  it("is read by the stage's next run: the drafter gets it as a person's answer, and it is marked read", async () => {
    const root = await estateRoot();
    await featureStage(root, CHANGE, { runtime: assistant(), now: NOW });
    const { question } = await commentOnFinding(root, {
      change: CHANGE,
      stage: "feature",
      finding: FINDING,
      text: COMMENT,
      by: "Priya Nair <priya@forge.example>",
      at: "2026-10-24T10:00:00Z",
    });
    const prompts: string[] = [];
    const again = await featureStage(root, CHANGE, { runtime: assistant(prompts), now: NOW });
    expect(again.state).toBe("done");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Questions people answered:");
    expect(prompts[0]).toContain(`Answer: ${COMMENT}`);
    const loop = parse(await readFile(join(root, REL, "stage/feature.yaml"), "utf8"));
    expect(loop.read).toContain(question.id);
    expect((await stageComments(root, CHANGE, "feature")).comments[0]!.read).toBe(true);
    // Read once: a third run with nothing new doesn't draft again.
    const third: string[] = [];
    await featureStage(root, CHANGE, { runtime: assistant(third), now: NOW });
    expect(third).toEqual([]);
  });

  it("is refused before the stage has run, since nothing would read it, and when it is empty", async () => {
    const root = await estateRoot();
    const e = await commentOnFinding(root, {
      change: CHANGE,
      stage: "architecture",
      finding: FINDING,
      text: COMMENT,
      by: "pat",
      at: "2026-10-24T10:00:00Z",
    }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PlannerError);
    expect((e as Error).message).toContain("run atticus change architecture add-fraud-check first");
    await featureStage(root, CHANGE, { runtime: assistant(), now: NOW });
    const empty = await commentOnFinding(root, {
      change: CHANGE,
      stage: "feature",
      finding: FINDING,
      text: "   ",
      by: "pat",
      at: "2026-10-24T10:00:00Z",
    }).catch((x: unknown) => x);
    expect((empty as PlannerError).code).toBe("invalid");
  });
});
