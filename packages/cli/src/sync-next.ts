/**
 * Review of beta.23 (ADR 0188): a step that needs a repo's base clone and finds none says so in
 * the command line's words (clone it with atticus workspace sync). The app turns the same refusal
 * into its Sync the repos button: a job's result or a problem carries `next: { step: "sync",
 * repos }`, read from these lines, so the two never differ.
 */

/** The command line's words for a repo with no checkout here. */
export function noCheckoutLine(repo: string): string {
  return `No checkout of ${repo}: clone it (atticus workspace sync) or give its folder with --dir.`;
}

/** The command line's words, or the app's for them (handoff-resume.ts's appLines). */
const NO_CHECKOUT =
  /^No checkout of (\S+?)(?:: clone it \(atticus workspace sync\)| on this machine: Sync the repos)/;

/** What the app offers next for these lines: Sync the repos with no checkout, or nothing. */
export interface SyncNext {
  step: "sync";
  repos: string[];
}

/** The repos the lines say have no checkout here, as the app's next step; undefined for none. */
export function syncNextOf(lines: readonly string[]): SyncNext | undefined {
  const repos = [
    ...new Set(
      lines.flatMap((l) => {
        const m = NO_CHECKOUT.exec(l.trim());
        return m ? [m[1]!] : [];
      }),
    ),
  ];
  return repos.length ? { step: "sync", repos } : undefined;
}
