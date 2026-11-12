/**
 * ADR 0188: a reason the server wrote for the command line (`atticus next`, a refusal), in the
 * app's words: the commands in brackets go (the page has the buttons), and the flags a terminal
 * passes are named as the app's own settings. Pure, so the step model (next.ts) can use it.
 */
export function inAppWords(text: string): string {
  return text
    .replace(/\s*\((?:atticus |\/atticus-)[^)]*\)/g, "")
    .replace(/\s*\(not-relevant --reason, or waive\)/g, " (Not relevant, or Waive)")
    .replace(/: pass --repo, or set metarepo under/g, ": set metarepo under")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * Beta.27 review of the fix: a step's reason as a page's sentence says it ("Not ready to raise
 * … yet: first, <why>"), when the server sent no app-words form of it: as `inAppWords`, and with
 * no "(ADR nnnn)". Final round: the page can't tell a command from prose ("what atticus knows"),
 * so it cuts nothing else; the server's `nextStepApp` takes the commands out (it has the help
 * catalog's commands).
 */
export function sentenceInAppWords(text: string): string {
  return inAppWords(text)
    .replace(/\s*\(ADRs? \d{4}[^)]*\)/g, "")
    .replace(/[ \t]+([.;,:])/g, "$1")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * Beta.27 review of the fix: a change's next-step sentence on a page other than At a glance
 * (Changes, the Gate, Across, Release): when another step comes first it carries that step's
 * reason, written for the command line, so it is said in the app's words. Final round: the
 * server's app-words form (`nextStepApp`, API 3.11.0) when it sent one.
 */
export function nextStepWords(nextStep: string, stepFirst?: boolean, app?: string): string {
  if (app) return app;
  return stepFirst ? sentenceInAppWords(nextStep) : nextStep;
}
