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
