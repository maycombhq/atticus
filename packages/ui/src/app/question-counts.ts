/**
 * Beta.27: one count of the questions to answer, the same wherever it shows (the activity bar's
 * badge, the status bar, the Explorer's Questions, Home's tile, the Questions page's line at the
 * top). A question to answer is either kind the Questions page answers:
 *
 * - **from the steps**: a question a step asked (questions/<id>.yaml) still open, as
 *   GET /api/questions?state=open lists them (its `counts.open` when the server says it);
 * - **owner questions**: a knowledge gap's question to a system's owner not answered yet,
 *   GET /api/owner-questions's `open`.
 *
 * Home's "Needs a person" counts something else (everything waiting on a person: these
 * questions, what to sort out, open needs, manual steps, blocking findings), and its count says
 * so ("14 waiting"); the Questions page's Open, Answered, Retired and All count the questions
 * from the steps only, and say so.
 */

/** The two reads the count is made of. */
export const STEP_QUESTIONS_PATH = "/api/questions?state=open";
export const OWNER_QUESTIONS_PATH = "/api/owner-questions";

/** GET /api/questions (any filter), as far as the count reads it. */
export interface StepQuestionsAnswer {
  questions?: readonly { state?: string }[];
  counts?: { open?: number };
}

/** GET /api/owner-questions, as far as the count reads it. */
export interface OwnerQuestionsAnswer {
  open?: number;
}

export interface QuestionsToAnswer {
  /** Both kinds together: the number every count of questions to answer shows. */
  total: number;
  steps: number;
  owner: number;
}

/** The open questions from the steps in an answer of GET /api/questions; undefined if none. */
export function openStepQuestions(a: StepQuestionsAnswer | undefined): number | undefined {
  if (!a) return undefined;
  if (typeof a.counts?.open === "number") return a.counts.open;
  if (!Array.isArray(a.questions)) return undefined;
  return a.questions.filter((q) => q.state === undefined || q.state === "open").length;
}

/** The owner questions not answered yet; undefined until known. */
export function openOwnerQuestions(a: OwnerQuestionsAnswer | undefined): number | undefined {
  return typeof a?.open === "number" ? a.open : undefined;
}

/**
 * The questions to answer, once both kinds are known. Undefined while either isn't: a count of
 * one kind alone would read as the whole and disagree with the other places.
 */
export function questionsToAnswer(
  steps: number | undefined,
  owner: number | undefined,
): QuestionsToAnswer | undefined {
  if (steps === undefined || owner === undefined) return undefined;
  return { total: steps + owner, steps, owner };
}

/** The same, from the two answers as the server gave them. */
export function questionsToAnswerOf(
  steps: StepQuestionsAnswer | undefined,
  owner: OwnerQuestionsAnswer | undefined,
): QuestionsToAnswer | undefined {
  return questionsToAnswer(openStepQuestions(steps), openOwnerQuestions(owner));
}
