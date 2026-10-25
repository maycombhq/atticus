import type { AiRuntime, SourceInput } from "@maycombhq/ai";
import { answerJudge, questionJudge } from "@maycombhq/ai";
import {
  answerText,
  fileJudgments,
  listQuestions,
  type QuestionJudge,
  type RaiseOptions,
} from "@maycombhq/core";

/**
 * The questions already on file, in the step's own prompt (ADR 0117): the step's model reads
 * them beside what it drafts and says, for a question it would raise, which one it is the same
 * as or narrower than (`sameAs`, with the words of that question that say so). That is the
 * same-question judgment batched into the prompt the step sends anyway, so a hand-off pays no
 * extra round. Atticus checks the id was listed, the words are in it and the veto (different
 * ids or fields named) before it follows the reading.
 */

/** At most this many questions are listed, the newest first. */
const LISTED = 30;

export const SAME_AS_RULE = `Questions already on file for this change are listed in questions-on-file. Before you raise a question, look there. If one of them asks the same thing, in any words, give it with the question as
  sameAs: { id: <its id>, verdict: same, quote: "<words of that question, copied exactly, that ask what yours asks>" }
and if yours asks part of what one of them asks, give verdict: narrower. Two questions about different fields, columns or ids are never the same. When none of them asks it, leave sameAs out.

A question marked answered is decided: its answer, given under it, is part of the brief, as binding as the brief's own words. Follow it. Never ask an answered question again, in any words, and never ask what its answer already says (which things it covers, what a word in it means, whether it really meant it). If you think the answer still leaves something open, ask only that, and give
  sameAs: { id: <the answered question's id>, verdict: narrower, quote: "<words of that question, copied exactly>" }
If you raise a question anyway that an answer already decides, give
  sameAs: { id: <its id>, verdict: answered, quote: "<the words of its answer, copied exactly, that decide yours>" }
and Atticus reads that answer instead of asking the person again.`;

export async function questionsOnFile(root: string, repo: string): Promise<SourceInput[]> {
  const all = (await listQuestions(root, { repo }).catch(() => ({ questions: [] }))).questions
    .filter((q) => q.state !== "retired")
    .slice(-LISTED)
    .reverse();
  if (!all.length) return [];
  return [
    {
      id: "same-as-rule",
      kind: "instruction",
      origin: "atticus (ADR 0117)",
      text: SAME_AS_RULE,
      classification: "public",
      trusted: true,
    },
    {
      id: "questions-on-file",
      kind: "document",
      origin: "questions/",
      text: all
        .map((q) =>
          [
            `- ${q.id} (${q.state}): ${q.question.trim()} [${q.evidence.join(", ")}]`,
            ...(q.state === "answered"
              ? // B-run2-fixes 8: the option's meaning, or the person's own words, not the label alone.
                [`  Answer (${q.answer?.by ?? "a person"}): ${answerText(q) ?? ""}`]
              : []),
          ].join("\n"),
        )
        .join("\n"),
      classification: "internal",
      priority: 90,
    },
  ];
}

/**
 * The judge a step's raiseQuestions uses for the pairs its own reading leaves open: the
 * runtime's model, or none with the hand-off runtime (the step's prompt carried the questions
 * on file; a further round would cost the person another prompt) and the mock one.
 */
export function stepQuestionJudge(
  root: string,
  runtime: AiRuntime,
  change: string,
  now: Date,
): QuestionJudge | undefined {
  if (runtime.kind === "hand-off" || runtime.kind === "mock") return undefined;
  return questionJudge({ runtime, store: fileJudgments(root), change, now });
}

/**
 * The judges a step's raiseQuestions uses for what its own reading leaves open (ADR 0117 and its
 * 2026-10-24 addendum): the same-question judge, and the answered-by judge, which reads a
 * person's answer and says whether it already decides a new question. Both only where the
 * runtime calls a model directly (model, headless Claude Code, replay); none with the hand-off
 * runtime or the mock one.
 */
export function stepJudges(
  root: string,
  runtime: AiRuntime,
  change: string,
  now: Date,
): Pick<RaiseOptions, "judge" | "answerJudge"> {
  if (runtime.kind === "hand-off" || runtime.kind === "mock") return {};
  const o = { runtime, store: fileJudgments(root), change, now };
  return { judge: questionJudge(o), answerJudge: answerJudge(o) };
}
