import type { Artifact } from "./types.js";

/** Why a change can't move on. Each reason is one plain sentence for people, plus its subject. */
export type ReasonCode =
  | "wrong-state"
  | "missing-artifact"
  | "unfilled-artifact"
  | "blocking-finding"
  | "open-gap"
  | "bad-finding"
  | "critic-round-missing"
  | "lens-waiting"
  | "lens-failed"
  /** Round 47: the newest critic round didn't finish (its record says in-progress, or it has none and no finding). */
  | "round-unfinished"
  | "stage-not-done"
  /** ADR 0210 part 7: what a stage went on with instead of stopping (its loop's openItems). */
  | "stage-open-item"
  | "pr-not-merged"
  | "approval-missing"
  | "self-approval"
  | "changes-requested"
  | "no-handoff"
  | "host-refused"
  | "pr-closed"
  /** `openspec validate --strict` refused the change (ADR 0006 addendum). */
  | "openspec-invalid"
  /** ADR 0210 part 7: the hand-off's open items changed since its PR showed them. */
  | "open-items-changed"
  /** ADR 0210 part 7: the PR's approval came before the open items it last showed. */
  | "open-items-unseen"
  /** ADR 0184: a repo the change touched has no release PR into its default branch. */
  | "release-pr-missing"
  /** ADR 0184: a repo's release PR isn't merged yet (unless the org pack doesn't require it). */
  | "release-pr-not-merged"
  /** Review round 48: the change branch has commits since its release PR merged. */
  | "release-pr-stale"
  /** App-only audit: a task branch has commits the change branch hasn't, here or on the Git host. */
  | "task-not-merged"
  /** ADR 0206: a quick change's design.md In the code is missing or doesn't read. */
  | "design.code-table"
  /** v31 (WP-05): a quick change's task has no acceptance criteria at all. */
  | "stories.no-criteria";

export interface Reason {
  code: ReasonCode;
  message: string;
  artifact?: Artifact;
  finding?: string;
  person?: string;
  /**
   * ADR 0210 part 7: a gate's reason, now an open item on the change. A hand-off goes ahead with
   * it and its PR lists it under "Open items": the person who approves the PR decides it. A
   * reason without it (a safety rule, a constitution finding, an unfinished critic round, an
   * error) still stops the step.
   */
  openItem?: true;
}

/** ADR 0210 part 7: the reason as an open item, which a step goes ahead with. */
export const asOpenItem = (r: Reason): Reason => ({ ...r, openItem: true });

/** Reasons that still stop a step, and the open items it goes ahead with. */
export function splitOpenItems(reasons: readonly Reason[]): { stops: Reason[]; open: Reason[] } {
  return {
    stops: reasons.filter((r) => !r.openItem),
    open: reasons.filter((r) => r.openItem),
  };
}

/** The PR body's or a report's "Open items" lines, one per open item (ADR 0210 part 7). */
export const openItemLines = (items: readonly Reason[]): string[] =>
  [...new Set(items.map((r) => r.message))].map((m) => `- ${m}`);

export type ChangeErrorCode = "not-found" | "invalid" | "conflict" | "refused";

/**
 * An operation on a change that can't go ahead. `refused` carries the reasons (missing
 * artifacts, blocking findings, the hand-off PR), so callers can show all of them at once.
 */
export class ChangeError extends Error {
  constructor(
    readonly code: ChangeErrorCode,
    message: string,
    readonly reasons: Reason[] = [],
  ) {
    super(message);
    this.name = "ChangeError";
  }
}
