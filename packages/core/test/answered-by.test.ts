import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  ANSWERED_BY,
  answeredByInputs,
  answerQuestion,
  fileJudgments,
  judgmentKey,
  listQuestions,
  namedBeyondAnswer,
  QuestionDraft,
  raiseQuestions,
  type AnswerJudge,
  type AnsweredVerdict,
  type Question,
} from "../src/index.js";

/**
 * ADR 0117 addendum (2026-10-24): a question a person already answered is not asked again in
 * other words. The answer decides it by the step's own reading (sameAs: answered, quoting the
 * answer), a stored judgment or the answered-by judge; a veto keeps an answer from being read for
 * a question about something it doesn't name; and a question nothing settled can be held back
 * for the drafter instead of going to the person.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SCENARIO = join(HERE, "../../../fixtures/stages/pin-note/scenario.yaml");
interface Scenario {
  change: string;
  asked: { question: string; evidence: string[] };
  answer: { text: string; by: string };
  reasked: { question: string; evidence: string[]; quote: string };
  open: { question: string; evidence: string[] };
}
const scenario = async () => parse(await readFile(SCENARIO, "utf8")) as Scenario;

const AT = "2026-10-24T10:00:00Z";
const by = (change: string, run = "run-20261024100000-0002") => ({
  step: "change-feature",
  repo: change,
  command: `atticus change feature ${change}`,
  rerun: `atticus change feature ${change}`,
  run,
  at: AT,
});

async function metarepo(s: Scenario): Promise<{ root: string; answered: Question }> {
  const root = await mkdtemp(join(tmpdir(), "atticus-answered-by-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  // The lines the questions cite, so they read as a change folder's brief.
  const brief = join(root, "openspec/changes", s.change, "brief.md");
  await mkdir(dirname(brief), { recursive: true });
  await writeFile(brief, Array.from({ length: 14 }, (_, i) => `line ${i + 1}`).join("\n"));
  const first = await raiseQuestions(
    root,
    [QuestionDraft.parse({ ...s.asked, options: [], scope: "repo" })],
    by(s.change, "run-20261024090000-0001"),
  );
  const asked = first.raised[0]!;
  const { question } = await answerQuestion(root, asked.id, {
    text: s.answer.text,
    by: s.answer.by,
    at: AT,
  });
  return { root, answered: question };
}

const draft = (q: { question: string; evidence: string[] }, extra: object = {}) =>
  QuestionDraft.parse({
    question: q.question,
    evidence: q.evidence,
    options: [],
    scope: "repo",
    ...extra,
  });

const judging =
  (verdict: AnsweredVerdict, calls: number[] = []): AnswerJudge =>
  async (pairs) => {
    calls.push(pairs.length);
    return new Map(pairs.map((p) => [p.key, verdict]));
  };

describe("an answered question asked again in other words (ADR 0117 addendum)", () => {
  it("reads the answer when the drafter says the answer decides it, quoting the answer", async () => {
    const s = await scenario();
    const { root, answered } = await metarepo(s);
    const r = await raiseQuestions(
      root,
      [
        draft(s.reasked, {
          sameAs: { id: answered.id, verdict: "answered", quote: s.reasked.quote },
        }),
      ],
      by(s.change),
    );
    expect(r.raised).toEqual([]);
    expect(r.of[0]?.id).toBe(answered.id);
    expect(r.of[0]?.state).toBe("answered");
    expect(r.decidedBy.get(0)?.id).toBe(answered.id);
    expect((await listQuestions(root)).questions.map((q) => q.id)).toEqual([answered.id]);
    // The reading is kept as a judgment, confirmed by the step's run.
    const key = judgmentKey(ANSWERED_BY, answeredByInputs(s.change, s.reasked, answered));
    const j = await fileJudgments(root).get(ANSWERED_BY, key);
    expect(j).toMatchObject({ verdict: "yes", confirmedBy: { by: "ai" } });
  });

  it("refuses a reading whose quote isn't the answer's words", async () => {
    const s = await scenario();
    const { root, answered } = await metarepo(s);
    const r = await raiseQuestions(
      root,
      [
        draft(s.reasked, {
          sameAs: { id: answered.id, verdict: "answered", quote: "any note at all" },
        }),
      ],
      by(s.change),
    );
    expect(r.raised).toHaveLength(1);
    expect(r.decidedBy.size).toBe(0);
  });

  it("asks the answered-by judge with the answer when the drafter said nothing (model, headless)", async () => {
    const s = await scenario();
    const { root, answered } = await metarepo(s);
    const seen: string[] = [];
    const judge: AnswerJudge = async (pairs) => {
      for (const p of pairs) seen.push(p.answer);
      return new Map(pairs.map((p) => [p.key, "yes" as const]));
    };
    const r = await raiseQuestions(root, [draft(s.reasked)], by(s.change), { answerJudge: judge });
    expect(seen).toEqual([s.answer.text]);
    expect(r.raised).toEqual([]);
    expect(r.of[0]?.id).toBe(answered.id);
    expect(r.reused[0]?.alsoAskedBy).toBeUndefined(); // the same step asked it first
  });

  it("raises a question the answer leaves open, as the judge says", async () => {
    const s = await scenario();
    const { root } = await metarepo(s);
    const r = await raiseQuestions(root, [draft(s.open)], by(s.change), {
      answerJudge: judging("no"),
    });
    expect(r.raised).toHaveLength(1);
    expect(r.raised[0]!.question).toBe(s.open.question);
  });

  it("never reads an answer for a question about something neither it nor its answer names", async () => {
    const s = await scenario();
    const { root, answered } = await metarepo(s);
    const about = {
      question: "Can a note of over 500 characters be pinned?",
      evidence: s.open.evidence,
    };
    expect(
      namedBeyondAnswer(about, { question: answered.question, answer: s.answer.text }, s.change),
    ).toEqual(["500"]);
    const calls: number[] = [];
    const r = await raiseQuestions(root, [draft(about)], by(s.change), {
      answerJudge: judging("yes", calls),
    });
    expect(calls).toEqual([]);
    expect(r.raised).toHaveLength(1);
  });

  it("holds back a question nothing settled, for the drafter, when the step asks (hand-off)", async () => {
    const s = await scenario();
    const { root, answered } = await metarepo(s);
    const r = await raiseQuestions(root, [draft(s.reasked)], by(s.change), {
      hold: () => true,
    });
    expect(r.raised).toEqual([]);
    expect(r.held).toHaveLength(1);
    expect(r.held[0]!.answered.map((q) => q.id)).toEqual([answered.id]);
    expect((await listQuestions(root)).questions).toHaveLength(1);
    // Without hold it is raised, as before.
    const again = await raiseQuestions(root, [draft(s.reasked)], by(s.change));
    expect(again.raised).toHaveLength(1);
  });

  // A live run (2026-10-25): a question held back was handed to the drafter as a possible repeat
  // of every question the change had answered. A repeat asks the same thing about the same
  // target: the answered questions it may repeat cite the file it cites and share its words, or
  // name an id it names; the others, though the same step asked them, are about something else.
  it("holds a question back only with the answered questions about the same target", async () => {
    const s = await scenario();
    const { root, answered } = await metarepo(s);
    const others = [
      { question: "Who may see the shop's opening hours?", evidence: s.asked.evidence },
      {
        question: "How long are archived invoices kept?",
        evidence: [`openspec/changes/${s.change}/brief.md:3`],
      },
    ];
    for (const o of others) {
      const r = await raiseQuestions(root, [draft(o)], by(s.change, "run-20261024090000-0003"));
      await answerQuestion(root, r.raised[0]!.id, { text: "Nobody.", by: "pat", at: AT });
    }
    expect((await listQuestions(root, { state: "answered" })).questions).toHaveLength(3);
    const r = await raiseQuestions(root, [draft(s.reasked)], by(s.change), { hold: () => true });
    expect(r.held).toHaveLength(1);
    expect(r.held[0]!.answered.map((q) => q.id)).toEqual([answered.id]);
  });
});
