import type { StageIssue } from "./loop.js";

type Raw = Record<string, unknown>;
const isObj = (x: unknown): x is Raw => !!x && typeof x === "object" && !Array.isArray(x);

// A path (it may hold spaces, never at its ends) and a line number.
const CITED = /^(?=\S)[^:\n]*[^\s:]:\d+$/;

/**
 * A question for a person rests on a line someone can open (ADR 0078). A question the answer
 * cites no such line for (`estate-index:line`: the block, not a file) can't be raised, and a
 * draft is not held back for it: it is left out, and said. Lines it does cite are kept, the
 * rest of its evidence dropped and said. Seen with GPT-4o mini, which asked such questions on
 * most drafts (and asked what the brief already answered).
 */
export function dropUncitedQuestions(d: Raw): StageIssue[] {
  if (!Array.isArray(d.questions)) return [];
  const out: StageIssue[] = [];
  d.questions = d.questions.filter((q: unknown, i: number) => {
    if (!isObj(q)) return true;
    const ev = Array.isArray(q.evidence) ? q.evidence : [];
    const kept = ev.filter((x) => typeof x === "string" && CITED.test(x));
    if (kept.length === ev.length && kept.length > 0) return true;
    const what = typeof q.question === "string" ? q.question : `question ${i + 1}`;
    if (!kept.length) {
      out.push({
        rule: "repair.question-without-evidence",
        target: `questions.${i}`,
        message: `The answer asked "${what}" without citing a file and line it rests on, so it isn't asked.`,
        blocking: false,
      });
      return false;
    }
    q.evidence = kept;
    out.push({
      rule: "repair.question-evidence",
      target: `questions.${i}`,
      message: `"${what}" cited ${ev.filter((x) => !kept.includes(x)).join(", ")}, which isn't a file and line; it is asked on ${kept.join(", ")}.`,
      blocking: false,
    });
    return true;
  });
  return out;
}
