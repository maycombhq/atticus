import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import type { ChangeLifecycle, ChangeType } from "@maycombhq/core";
import type { ChangeContext } from "./context.js";
import { handoffName, statePhase } from "./lifecycle.js";
import { changeFolder } from "./store.js";
import type { PhaseId } from "./types.js";

/** One stage of a change's stage path and where its loop is (ADR 0087). */
export interface StageCompletion {
  stage: string;
  phase: PhaseId;
  /** The loop's own state (done, drafting, waiting, questions, stopped), or not-started. */
  state: string;
}

/**
 * How far each stage of the change's stage path has got (ADR 0124 addendum B-change): read from
 * its loop file, `stage/<stage>.yaml`. The one place the lifecycle reads stage completion, so it
 * can come from elsewhere (OpenSpec's own status of the change's artifacts) without the gates
 * on top of it changing: the critic's rounds and the hand-off PR a person merges.
 */
export async function stageCompletion(
  ctx: Pick<ChangeContext, "root" | "policy">,
  change: Pick<ChangeLifecycle, "id">,
): Promise<StageCompletion[]> {
  const dir = changeFolder(ctx.root, change.id);
  const out: StageCompletion[] = [];
  for (const s of ctx.policy.stages) {
    const text = await readFile(join(dir, ...s.loop.split("/")), "utf8").catch(() => undefined);
    let state = "not-started";
    if (text !== undefined) {
      try {
        const y = parse(text) as { state?: unknown } | null;
        state = typeof y?.state === "string" ? y.state : "unknown";
      } catch {
        state = "unknown";
      }
    }
    out.push({ stage: s.stage, phase: s.phase, state });
  }
  return out;
}

/**
 * Where a change's work is against its lifecycle state (B-change). The stages can run ahead of
 * the gates: a change whose stories are done is still in define until its define hand-off PR
 * merges. `done` is the stages done, in order; `ahead` the phases whose stage is done but whose
 * gate the lifecycle hasn't reached; `summary` says it in one sentence.
 */
export interface WorkProgress {
  done: string[];
  ahead: PhaseId[];
  summary: string;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const and = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;

/** Undefined off the stage path (no stage has run) and for a change past its stages' phases. */
export function workProgress(
  type: ChangeType,
  state: string,
  stages: StageCompletion[],
  /** The phase's hand-off PR is open. */
  raised = false,
): WorkProgress | undefined {
  if (stages.every((s) => s.state === "not-started")) return undefined;
  const phase = state === "returned" ? type.phases[0] : statePhase(state as never);
  if (!phase) return undefined;
  const at = type.phases.indexOf(phase);
  const own = stages.filter((s) => type.phases.includes(s.phase));
  if (own.length && own.every((s) => type.phases.indexOf(s.phase) < at)) return undefined;
  const done = own.filter((s) => s.state === "done").map((s) => s.stage);
  const ahead = own
    .filter((s) => s.state === "done" && type.phases.indexOf(s.phase) > at)
    .map((s) => s.phase);
  const current = own.find((s) => s.phase === phase);
  const under = own.find((s) => s.state !== "done" && s.state !== "not-started");
  const last = own.filter((s) => s.state === "done").at(-1);
  const name = handoffName(type, phase);
  let summary: string;
  if (under)
    summary = `The ${under.stage} stage is ${under.state === "questions" ? "waiting on answers" : under.state}${done.length ? ` (${and(done)} done)` : ""}; the change is in ${state}.`;
  else if (!current || current.state !== "done")
    summary = `${done.length ? `${cap(and(done))} done; ` : ""}the ${current?.stage ?? phase} stage hasn't run yet; the change is in ${state}.`;
  else if (ahead.length)
    summary = `${cap(last!.stage)} done; the change is still in ${state}: ${raised ? "merge" : "raise"} "${name}" (the ${phase} hand-off), then the ${and(ahead)} hand-offs.`;
  else
    summary = `${cap(current.stage)} done; waiting on "${name}" (the ${phase} hand-off${raised ? " PR to merge" : ", not raised yet"}).`;
  return { done, ahead, summary };
}
