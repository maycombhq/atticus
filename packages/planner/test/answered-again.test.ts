import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import {
  HandoffRuntime,
  HeadlessClaudeCodeRuntime,
  MockRuntime,
  type AiRuntime,
} from "@maycombhq/ai";
import {
  answerQuestion,
  listQuestions,
  parseRecord,
  recordPath,
  serializeRecord,
} from "@maycombhq/core";
import { readRound } from "@maycombhq/naysayer";
import { featureStage } from "../src/index.js";

/**
 * A person's answer, read for the rest of the change (ADR 0115 and 0117 addenda, 2026-10-24),
 * from a live run retold on the Forge estate: the change "pin an order note". A person answers
 * which notes can be pinned. The next draft must not ask it again in other words, and the
 * critic's business lens must not block the draft for following the answer. In each mode the
 * code path differs: hand-off (the drafter's own reading, or a hand-back to the drafter), and a
 * runtime that calls a model directly (model, headless Claude Code: the answered-by judge).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "../../../fixtures/stages");
const PIN = join(FIX, "pin-note");
const NOW = new Date("2026-10-24T09:00:00Z");
const CHANGE = "pin-order-note";

interface Scenario {
  asked: { question: string; evidence: string[] };
  answer: { text: string; by: string };
  reasked: { question: string; evidence: string[]; quote: string };
  lensFinding: { summary: string; quote: string };
}
const S = parse(readFileSync(join(PIN, "scenario.yaml"), "utf8")) as Scenario;

const NO_EXPANSION = `schemaVersion: 1
assistants: { allowed: [copilot], default: copilot }
retrieval: { expansion: false }
`;

async function estateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-answered-again-"));
  await mkdir(join(root, "org-pack/checklists"), { recursive: true });
  await writeFile(join(root, "org-pack/runtime.yaml"), NO_EXPANSION);
  await cp(
    join(PIN, "checklists/pin-review.yaml"),
    join(root, "org-pack/checklists/pin-review.yaml"),
  );
  const rows = [
    ...(parse(readFileSync(join(FIX, "../specs/catalog.yaml"), "utf8")) as unknown[]),
    ...(parse(readFileSync(join(FIX, "catalog-extra.yaml"), "utf8")) as unknown[]),
  ];
  for (const r of rows) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(`bad fixture record: ${JSON.stringify(p.issues)}`);
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(join(FIX, "specs"), join(root, "specs"), { recursive: true });
  await cp(join(PIN, CHANGE), join(root, "openspec/changes", CHANGE), { recursive: true });
  return root;
}

const placement = (
  questions: string,
) => `summary: A shopper pins one note to the top of an order's notes, and can unpin it.
features:
  - id: cap-ordering
    why: An order's notes belong to ordering.
flows:
  - id: forge-orders.place-order
    how: read
    why: A note is pinned on an order that was placed.
newFlows:
  - name: pin an order note
    repo: forge-orders
    why: Nothing pins a note today.
gaps:
  - what: Orders keep no notes today.
    why: A pinned note needs notes on the order.
${questions}`;

const q = (d: { question: string; evidence: string[] }, sameAs = "") =>
  `  - question: ${JSON.stringify(d.question)}\n    evidence: [${d.evidence.join(", ")}]\n${sameAs}`;
const FIRST = placement(`questions:\n${q(S.asked)}`);
const REASKED = placement(`questions:\n${q(S.reasked)}`);
const REASKED_SAME_AS = (id: string) =>
  placement(
    `questions:\n${q(S.reasked, `    sameAs: { id: ${id}, verdict: answered, quote: ${JSON.stringify(S.reasked.quote)} }\n`)}`,
  );
const SETTLED = placement("questions: []\n");

/** The business lens: once it was given the answer, it reports the narrowing linked to it. */
const lensAnswer = (prompt: string, id: string | undefined) =>
  id && prompt.includes(S.answer.text)
    ? `findings:
  - rule: brief-scope-delivered
    artifact: brief.md
    locator: { line: 13 }
    summary: ${JSON.stringify(S.lensFinding.summary)}
    why: The brief says a shopper pins one note.
    fix: Let any note be pinned.
    evidence:
      - { path: brief.md, line: 13, quote: "In scope: pinning one note per order" }
    answered: { id: ${id}, quote: ${JSON.stringify(S.lensFinding.quote)} }
`
    : "findings: []\n";

const judgeYes = `judgments:
  - item: 1
    verdict: yes
    quotes: [{ of: answer, text: ${JSON.stringify(S.reasked.quote)} }]
    why: The answer already says which notes can be pinned.
`;

/** Every AI step of the scenario, by its prompt: the drafter, the critic's lens, the judge. */
function respond(prompt: string, drafts: string[], id: () => string | undefined): string {
  if (prompt.includes("# Feature placer")) return drafts.shift() ?? SETTLED;
  if (prompt.includes("Critic: business lens")) return lensAnswer(prompt, id());
  if (prompt.includes("A person already answered the existing question")) return judgeYes;
  return "findings: []\n";
}

async function answerFirst(root: string): Promise<string> {
  const [asked] = (await listQuestions(root, { state: "open" })).questions;
  expect(asked?.question).toBe(S.asked.question);
  await answerQuestion(root, asked!.id, {
    text: S.answer.text,
    by: S.answer.by,
    at: NOW.toISOString(),
  });
  return asked!.id;
}

async function afterwards(root: string, id: string) {
  // Nobody is asked again: one question on file, answered.
  const qs = (await listQuestions(root)).questions;
  expect(qs.map((x) => [x.id, x.state])).toEqual([[id, "answered"]]);
  // The lens's finding about the narrowing is linked to the answer and doesn't block.
  const rounds = await readRound(root, CHANGE, "define", 2);
  const f = rounds.findings.find((x) => x.finding.rule === "brief-scope-delivered")?.finding;
  expect(f?.severity).toBe("risk");
  expect(f?.answered).toEqual({ question: id, quote: S.lensFinding.quote });
}

/** A runtime that calls a model directly. */
class Model extends MockRuntime {
  override readonly kind = "model" as const;
}

describe("a person's answer, read for the rest of the change", () => {
  for (const mode of ["model", "headless"] as const)
    it(`isn't asked again, and the lens doesn't block the draft that follows it (${mode})`, async () => {
      const root = await estateRoot();
      const answered: string[] = [];
      const drafts = [FIRST, REASKED];
      const prompts: string[] = [];
      const answerFor = (p: string) => {
        prompts.push(p);
        return respond(p, drafts, () => answered[0]);
      };
      const rt: AiRuntime =
        mode === "model"
          ? new Model((r) => answerFor(r.pack.prompt), { now: () => NOW })
          : new HeadlessClaudeCodeRuntime({
              root,
              now: () => NOW,
              runner: async (i) => {
                const file = /Write the result to (\S+?\.yaml)\./.exec(i.prompt)![1]!;
                await writeFile(join(i.cwd, ...file.split("/")), answerFor(i.prompt));
                return {
                  exitCode: 0,
                  stdout: JSON.stringify({ result: "Wrote it", is_error: false }),
                  stderr: "",
                };
              },
              invocation: () => ({ cwd: root }),
            });
      const first = await featureStage(root, CHANGE, { runtime: rt, now: NOW });
      expect(first.state).toBe("questions");
      const id = await answerFirst(root);
      answered.push(id);
      const second = await featureStage(root, CHANGE, { runtime: rt, now: NOW });
      // The draft's prompt said the answer is part of the brief and is never asked again.
      const draft2 = prompts.filter((p) => p.includes("# Feature placer"))[1]!;
      expect(draft2).toContain(S.answer.text);
      expect(draft2).toContain("Never ask an answered question again");
      // The answered-by judge read the answer, and said it decides the new question.
      expect(
        prompts.some((p) => p.includes("A person already answered") && p.includes(S.answer.text)),
      ).toBe(true);
      expect(second.state).toBe("done");
      expect(second.notes.join("\n")).toContain(`Your assistant asked again what ${id} answered`);
      await afterwards(root, id);
    });

  describe("in hand-off mode", () => {
    function handoff(root: string) {
      let t = NOW.getTime();
      const tick = () => new Date((t += 5000));
      const rt = () => new HandoffRuntime({ root, validate: async () => [], now: tick });
      const step = (resume?: string) =>
        featureStage(root, CHANGE, { runtime: rt(), now: tick(), ...(resume ? { resume } : {}) });
      const prompt = (run: string) =>
        readFile(join(root, ".runs", CHANGE, run, "prompt.md"), "utf8");
      return { step, done: (run: string) => rt().done(run), prompt, root };
    }

    /** Draft, then the business lens, until the stage stops waiting. */
    async function drive(h: ReturnType<typeof handoff>, drafts: string[], id: string | undefined) {
      const root = h.root;
      let r = await h.step();
      const prompts: string[] = [];
      while (r.state === "waiting") {
        const run = r.waiting!.runId;
        const p = await h.prompt(run);
        prompts.push(p);
        const file = /Write the result to (\S+?\.yaml)\./.exec(p)![1]!;
        await writeFile(
          join(root, ...file.split("/")),
          respond(p, drafts, () => id),
        );
        await h.done(run);
        r = await h.step(run);
      }
      return { r, prompts };
    }

    it("reads the answer when the drafter says the answer decides its question", async () => {
      const root = await estateRoot();
      const h = handoff(root);
      expect((await drive(h, [FIRST], undefined)).r.state).toBe("questions");
      const id = await answerFirst(root);
      const { r, prompts } = await drive(h, [REASKED_SAME_AS(id)], id);
      expect(prompts[0]).toContain(`${id} (answered): ${S.asked.question}`);
      expect(prompts[0]).toContain(`Answer (${S.answer.by}): ${S.answer.text}`);
      expect(r.state).toBe("done");
      await afterwards(root, id);
    });

    it("hands a question asked again back to the drafter with the answer, rather than ask the person", async () => {
      const root = await estateRoot();
      const h = handoff(root);
      await drive(h, [FIRST], undefined);
      const id = await answerFirst(root);
      // The drafter asks again without saying so; then, given the answer, leaves it out.
      const { r, prompts } = await drive(h, [REASKED, SETTLED], id);
      const back = prompts.filter((p) => p.includes("# Feature placer"))[1]!;
      expect(back).toContain("may ask again what a person already answered");
      expect(back).toContain(S.answer.text);
      expect(r.state).toBe("done");
      const qs = (await listQuestions(root)).questions;
      expect(qs.map((x) => x.id)).toEqual([id]);
    });
  });
});
