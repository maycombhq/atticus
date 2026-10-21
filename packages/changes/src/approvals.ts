import type { ChangeHandoff, ChangeType } from "@maycombhq/core";
import type { ChangeContext } from "./context.js";
import type { Footprint } from "./footprint.js";
import type { PhaseId } from "./types.js";

/**
 * Approvals are the pull request (ADR 0073). A phase's gate is approved when its hand-off PR
 * merges on the Git host; who may approve it is the Git host's business (branch protection,
 * CODEOWNERS), not a role in the org pack. Atticus reads the PR and records what happened.
 */

export interface PrivacyImpact {
  touched: boolean;
  records: Footprint["personal"];
  /** The phase whose hand-off PR carries the personal-data review. */
  phase: PhaseId;
}

const strip = (h: string) => (h.startsWith("@") ? h.slice(1) : h);

export function privacyImpact(
  ctx: ChangeContext,
  type: ChangeType,
  footprint: Footprint,
): PrivacyImpact {
  const { phases } = ctx.policy.privacy;
  return {
    touched: footprint.personal.length > 0,
    records: footprint.personal,
    phase: phases.find((p) => type.phases.includes(p)) ?? type.phases.at(-1)!,
  };
}

/**
 * The people whose approving review counts on a hand-off PR: everyone who approved, except
 * the person who raised it. A PR is a request for someone else's review.
 */
export function prApprovers(handoff: Pick<ChangeHandoff, "by">, approvers: string[]): string[] {
  const raiser = strip(handoff.by);
  return [...new Set(approvers.map(strip))].filter((p) => p !== raiser).sort();
}
