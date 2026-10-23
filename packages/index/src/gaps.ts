/**
 * What neither the wikis nor the repos say (ADR 0107 point 5): a name a change uses that the
 * index has nothing for is a gap. A gap a step's answer relies on becomes a question to a
 * person, never a guess, asked by this step id so every step that meets the same gap in the
 * same change waits on one question. Answered, it is indexed (an answered question is
 * asserted knowledge, with who and when) and the name it is about is known from then on.
 */

/** The step id gap questions are asked under. */
export const GAP_STEP = "context-gap";

/** The question a gap becomes. The name is quoted, so the index can read it back. */
export function gapQuestion(name: string): string {
  return `The change names "${name}", and nothing Atticus has read says what it is: no catalog record, knowledge item, flow, wiki section or answered question. What is ${name}, who owns it, and where is it described?`;
}

/** The name a gap question is about, or undefined when it isn't one. */
export function gapNameOf(q: { askedBy: { step: string }; question: string }): string | undefined {
  if (q.askedBy.step !== GAP_STEP) return undefined;
  return /^The change names "([^"]+)"/.exec(q.question)?.[1];
}
