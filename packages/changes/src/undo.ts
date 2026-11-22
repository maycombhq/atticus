/**
 * An undo that says how (ADR 0203 review, shared with ADR 0206's quick cut-over rows): not empty,
 * a dash, "n/a", "none" or "tbd", more than a word, and not a sentence that only says no undo
 * applies ("Not applicable here.", "Nothing to undo.").
 */
const BACK = String.raw`(?:roll(?:ed|ing)?\s*back|rollback|revert(?:ed)?|undo(?:ne)?|back(?:ed)?\s*out|backout)`;
const NO_UNDO = new RegExp(
  [
    String.raw`^(?:(?:it|this|that)\s+)?(?:n\/?a|none(?:\s+needed)?|tbd|todo|-+|not\s+applicable|(?:does\s*n[o']t|does\s+not|doesn't)\s+apply|nothing\s+to\s+undo|no\s+undo(?:\s+is)?(?:\s+needed)?)\b(?:\s+(?:here|to\s+.+|for\s+.+|needed|is\s+needed))?$`,
    // "There is nothing to roll back.", "Nothing to back out here."
    String.raw`^(?:there\s+is\s+|there's\s+)?nothing\s+to\s+${BACK}(?:\s+(?:here|now|for\s+.+))?$`,
    // "No rollback is possible.", "No revert is needed."
    String.raw`^no\s+${BACK}(?:\s+(?:is|was))?(?:\s+(?:possible|needed|required|applies))?(?:\s+(?:here|now|for\s+.+))?$`,
    // "It can't be rolled back.", "This cannot be undone."
    String.raw`^(?:(?:it|this|that)\s+)?(?:can(?:no|')t|cannot|can\s+not)\s+be\s+${BACK}(?:\s+(?:here|now))?$`,
  ].join("|"),
  "i",
);

/** A sentence without its trailing full stops and spaces. */
export const bareUndo = (s: string): string => s.trim().replace(/[.\s]+$/, "");

export const realUndo = (undo: string | undefined): boolean =>
  !!undo && bareUndo(undo).length >= 10 && !NO_UNDO.test(bareUndo(undo));
