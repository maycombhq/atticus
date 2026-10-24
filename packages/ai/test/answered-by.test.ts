import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  ANSWERED_BY,
  answeredByInputs,
  judgmentKey,
  memoryJudgments,
  QuestionDraft,
  type AnsweredPair,
  type Question,
} from "@maycombhq/core";
import { ANSWERED_BY_SPEC, answerJudge, judgeInstructions, MockRuntime } from "../src/index.js";

/**
 * ADR 0117 addendum (2026-10-24): the answered-by judge reads the new question, the answered one
 * and the person's answer, and must quote the answer. The veto settles a question about something
 * the answer doesn't name before any model is asked.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
interface Case {
  id: string;
  new: { question: string; evidence: string[] };
  existing: { question: string; evidence: string[]; answer: string };
  truth: "yes" | "no";
  recorded?: { verdict: string; quotes: { of: string; text: string }[]; why?: string };
}
const fixture = async () =>
  parse(await readFile(join(HERE, "../../../fixtures/judgments/answered-by.yaml"), "utf8")) as {
    repo: string;
    cases: Case[];
  };

const NOW = new Date("2026-10-24T10:00:00Z");

function pairOf(repo: string, c: Case, n: number): AnsweredPair {
  const answered = {
    schemaVersion: 2,
    id: `q-${String(n).padStart(12, "0")}`,
    askedBy: { step: "change-feature", command: "atticus change feature x", at: NOW.toISOString() },
    repo,
    question: c.existing.question,
    options: [],
    evidence: c.existing.evidence,
    scope: { level: "repo", id: repo },
    state: "answered",
    rerun: "atticus change feature x",
    answer: {
      text: c.existing.answer,
      by: "priya.nair",
      at: NOW.toISOString(),
      scope: { level: "repo", id: repo },
    },
  } as Question;
  const draft = QuestionDraft.parse({ ...c.new, options: [], scope: "repo" });
  const inputs = answeredByInputs(repo, draft, answered);
  return {
    key: judgmentKey(ANSWERED_BY, inputs),
    inputs,
    repo,
    draft,
    answered,
    answer: c.existing.answer,
  };
}

describe("the answered-by judge (ADR 0117 addendum)", () => {
  it("tells the judge to quote the answer", () => {
    expect(judgeInstructions(ANSWERED_BY_SPEC)).toContain("quote the words of answer");
  });

  it("gets every case right on the recorded verdicts, and vetoes the one naming more", async () => {
    const { repo, cases } = await fixture();
    const pairs = cases.map((c, i) => pairOf(repo, c, i + 1));
    const prompts: string[] = [];
    const rt = new MockRuntime((r) => {
      prompts.push(r.pack.prompt);
      const sent = cases.filter((c) => c.recorded && r.pack.prompt.includes(c.new.question));
      return stringify({
        judgments: sent.map((c, i) => ({ item: i + 1, ...c.recorded })),
      });
    });
    const verdicts = await answerJudge({
      runtime: rt,
      store: memoryJudgments(),
      change: repo,
      now: NOW,
    })(pairs);
    expect(prompts).toHaveLength(1);
    // The answer is in the prompt, as data.
    expect(prompts[0]).toContain(cases[0]!.existing.answer);
    // The vetoed case never reaches the model.
    expect(prompts[0]).not.toContain("500 characters");
    expect(cases.map((c, i) => [c.id, verdicts.get(pairs[i]!.key)])).toEqual(
      cases.map((c) => [c.id, c.truth]),
    );
  });

  it("refuses a yes that quotes the question instead of the answer, and counts it as unsure", async () => {
    const { repo, cases } = await fixture();
    const pair = pairOf(repo, cases[0]!, 1);
    const rt = new MockRuntime(() =>
      stringify({
        judgments: [
          {
            item: 1,
            verdict: "yes",
            quotes: [{ of: "existing", text: "Which order notes can be pinned?" }],
          },
        ],
      }),
    );
    const v = await answerJudge({ runtime: rt, store: memoryJudgments(), change: repo, now: NOW })([
      pair,
    ]);
    expect(v.get(pair.key)).toBe("unsure");
  });
});
