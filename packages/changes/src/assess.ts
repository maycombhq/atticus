import type { ChangeHandoff, ChangeLifecycle, ChangeType, LifecycleState } from "@maycombhq/core";
import { prApprovers, privacyImpact, type PrivacyImpact } from "./approvals.js";
import { changeTypeOf, loadChangeContext, type ChangeContext } from "./context.js";
import type { Reason } from "./errors.js";
import { changeFootprint, type Footprint } from "./footprint.js";
import {
  checkArtifacts,
  checkFindings,
  checkMandatoryRounds,
  mandatoryGates,
  handoffName,
  nextState,
  phaseFindingGates,
  phaseGates,
  phaseState,
  requiredArtifacts,
  statePhase,
} from "./lifecycle.js";
import { scoreRisk, testsFor, type Risk, type TestPlan } from "./risk.js";
import { changeStore } from "./store.js";
import type { PhaseId } from "./types.js";

/** Where a change stands and everything that decides whether it can move on. */
export interface Assessment {
  change: ChangeLifecycle;
  type: ChangeType;
  state: LifecycleState;
  /** The phase being worked on (for a returned change, the type's first phase). */
  phase?: PhaseId;
  /** The state the next transition leads to. */
  next?: LifecycleState;
  footprint: Footprint;
  risk: Risk;
  tests: TestPlan;
  privacy: PrivacyImpact;
  /** The open hand-off PR, if any. Merging it approves the phase's gate (ADR 0073). */
  handoff?: ChangeHandoff;
  /** What stops a hand-off from being raised: artifacts, findings, critic rounds. */
  blockers: Reason[];
  /** What stops the change from advancing: blockers, then the hand-off PR until it merges. */
  reasons: Reason[];
}

export const liveHandoff = (c: ChangeLifecycle) =>
  c.handoffs.find((h) => h.state === "open" || h.state === "changes-requested");

export async function assess(ctx: ChangeContext, change: ChangeLifecycle): Promise<Assessment> {
  const type = changeTypeOf(ctx, change.type);
  const footprint = await changeFootprint(ctx, change);
  const risk = scoreRisk({ type: type.id, footprint }, ctx.policy);
  const tests = testsFor(ctx.orgPack.testStrategy, type.id, risk.level);
  const privacy = privacyImpact(ctx, type, footprint);
  const base = { change, type, state: change.state, footprint, risk, tests, privacy };

  const phase = change.state === "returned" ? type.phases[0]! : statePhase(change.state);
  if (!phase) {
    if (change.state === "released")
      return { ...base, next: "archived", blockers: [], reasons: [] };
    if (change.state === "post-release-review") {
      const blockers = await checkFindings(ctx.root, change, ["post-release-review"]);
      return { ...base, next: "archived", blockers, reasons: blockers };
    }
    const reasons: Reason[] = [
      {
        code: "wrong-state",
        message:
          change.state === "archived"
            ? `${change.id} is archived.`
            : `${change.id} is a draft; create it with atticus change new.`,
      },
    ];
    return { ...base, blockers: reasons, reasons };
  }

  const blockers: Reason[] = [
    ...(await checkArtifacts(ctx.root, change, requiredArtifacts(ctx, type, phase, footprint))),
    ...(await checkFindings(ctx.root, change, phaseFindingGates(ctx, phase))),
    ...(await checkMandatoryRounds(
      ctx.root,
      change,
      phaseGates(ctx, phase).filter((g) => mandatoryGates(ctx).includes(g)),
    )),
  ];
  const next = change.state === "returned" ? phaseState(phase) : nextState(type, phase);
  const live = change.state === "returned" ? undefined : liveHandoff(change);
  const reasons = [...blockers];
  if (!live) {
    reasons.push({
      code: "no-handoff",
      message: `No hand-off PR yet: raise "${handoffName(type, phase)}" when the ${phase} work is done.`,
    });
  } else if (live.state === "changes-requested") {
    reasons.push({
      code: "changes-requested",
      message: `Changes were requested on PR #${live.pr.number}; update the artifacts and hand off again.`,
    });
  } else {
    // The gate is approved when the PR merges; until then the PR is what the change waits on.
    const approved = prApprovers(
      live,
      live.approvals.map((a) => a.by),
    );
    reasons.push({
      code: "pr-not-merged",
      message: approved.length
        ? `PR #${live.pr.number} is approved (${approved.join(", ")}) but not merged yet: ${live.pr.url}`
        : `Waiting for PR #${live.pr.number} to be approved and merged on the Git host: ${live.pr.url}`,
    });
  }
  return { ...base, phase, next, ...(live ? { handoff: live } : {}), blockers, reasons };
}

export interface Readiness {
  ok: boolean;
  state: LifecycleState;
  phase?: PhaseId;
  next?: LifecycleState;
  reasons: Reason[];
}

/**
 * Whether a change can move to its next state now: required artifacts exist and are filled
 * in, no open blocking finding or knowledge gap sits on the phase's gate (newest round),
 * and the hand-off PR has merged (as last synced from the Git host).
 */
export async function canAdvance(
  change: ChangeLifecycle | string,
  root: string,
): Promise<Readiness> {
  const ctx = await loadChangeContext(root);
  const c = typeof change === "string" ? await changeStore(root).read(change) : change;
  const a = await assess(ctx, c);
  return {
    ok: a.reasons.length === 0,
    state: a.state,
    ...(a.phase ? { phase: a.phase } : {}),
    ...(a.next ? { next: a.next } : {}),
    reasons: a.reasons,
  };
}

export interface ChangeReport extends Assessment {
  /** One sentence: what to do next. */
  nextStep: string;
  /** Problems loading the org pack, policy, templates or catalog. */
  problems: string[];
}

/** Everything `atticus change status` shows. */
export async function changeReport(root: string, id: string): Promise<ChangeReport> {
  const ctx = await loadChangeContext(root);
  const a = await assess(ctx, await changeStore(root).read(id));
  return { ...a, nextStep: nextStep(a), problems: ctx.problems };
}

function nextStep(a: Assessment): string {
  switch (a.state) {
    case "draft":
      return "Create the change with atticus change new.";
    case "archived":
      return "Nothing: the change is archived.";
    case "released":
      return "Archive the change.";
    case "post-release-review":
      return a.reasons.length
        ? "Resolve the post-release review findings, then archive the change."
        : "Review the skipped lenses, then archive the change.";
    case "returned":
      return `Revise the work, then hand off ${a.phase} again.`;
  }
  const name = handoffName(a.type, a.phase!);
  if (!a.handoff)
    return a.blockers.length
      ? `Finish the ${a.phase} work, then raise "${name}".`
      : `Ready to raise "${name}".`;
  if (a.handoff.state === "changes-requested")
    return `Update the artifacts and hand off again on PR #${a.handoff.pr.number}.`;
  return `Merge PR #${a.handoff.pr.number} once it is approved (${a.handoff.pr.url}); syncing then moves the change on.`;
}
