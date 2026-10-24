import type { AiRuntime, SourceInput } from "@maycombhq/ai";
import { questionJudge } from "@maycombhq/ai";
import { fileJudgments, listQuestions, type QuestionJudge } from "@maycombhq/core";

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
and if yours asks part of what one of them asks, give verdict: narrower. Two questions about different fields, columns or ids are never the same. When none of them asks it, leave sameAs out.`;

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
        .map((q) => `- ${q.id} (${q.state}): ${q.question.trim()} [${q.evidence.join(", ")}]`)
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
