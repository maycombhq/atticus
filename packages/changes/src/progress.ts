import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { PHASES, type ChangeLifecycle, type ChangeType } from "@maycombhq/core";
import type { ChangeContext } from "./context.js";
import { handoffName, statePhase } from "./lifecycle.js";
import { personWrittenPlanning, stageIdle, stageWorkDone, writesPlanning } from "./planning.js";
import { changeFolder } from "./store.js";
import type { PhaseId } from "./types.js";

/** One stage of a change's stage path and where its loop is (ADR 0087). */
export interface StageCompletion {
  stage: string;
  phase: PhaseId;
  /**
   * The loop's own state (done, drafting, waiting, questions, stopped), or not-started. Beta.27
   * review, for a stage with no loop file: `person` when it is the stage that writes the planning
   * files and a person wrote them (the stage would refuse to replace them, so its work is done),
   * and `skipped` when the change is past the stage's phase without it having run.
   */
  state: string;
  /** With `person`: the files a person wrote, change-folder-relative. */
  files?: string[];
}

/** Where a lifecycle state sits among the phases; past the last for a released change. */
function phaseIndex(state: string): number {
  if (state === "draft" || state === "returned") return 0;
  if (state === "release-ready") return PHASES.indexOf("release");
  const i = (PHASES as readonly string[]).indexOf(state);
  return i >= 0 ? i : PHASES.length;
}

/**
 * How far each stage of the change's stage path has got (ADR 0124 addendum B-change): read from
 * its loop file, `stage/<stage>.yaml`. The one place the lifecycle reads stage completion, so it
 * can come from elsewhere (OpenSpec's own status of the change's artifacts) without the gates
 * on top of it changing: the critic's rounds and the hand-off PR a person merges.
 */
export async function stageCompletion(
  ctx: Pick<ChangeContext, "root" | "policy">,
  change: Pick<ChangeLifecycle, "id"> & Partial<Pick<ChangeLifecycle, "state">>,
): Promise<StageCompletion[]> {
  const dir = changeFolder(ctx.root, change.id);
  const out: StageCompletion[] = [];
  for (const s of ctx.policy.stages) {
    const text = await readFile(join(dir, ...s.loop.split("/")), "utf8").catch(() => undefined);
    let state = "not-started";
    if (text === undefined) {
      const own = writesPlanning(s) ? await personWrittenPlanning(dir) : [];
      if (own.length) {
        out.push({ stage: s.stage, phase: s.phase, state: "person", files: own });
        continue;
      }
      if (change.state && phaseIndex(change.state) > PHASES.indexOf(s.phase)) state = "skipped";
    } else {
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
  if (stages.every((s) => stageIdle(s.state))) return undefined;
  const phase = state === "returned" ? type.phases[0] : statePhase(state as never);
  if (!phase) return undefined;
  const at = type.phases.indexOf(phase);
  const own = stages.filter((s) => type.phases.includes(s.phase));
  if (own.length && own.every((s) => type.phases.indexOf(s.phase) < at)) return undefined;
  const done = own.filter((s) => stageWorkDone(s.state)).map((s) => s.stage);
  const ahead = own
    .filter((s) => stageWorkDone(s.state) && type.phases.indexOf(s.phase) > at)
    .map((s) => s.phase);
  const current = own.find((s) => s.phase === phase);
  const under = own.find((s) => !stageWorkDone(s.state) && !stageIdle(s.state));
  const last = own.filter((s) => stageWorkDone(s.state)).at(-1);
  // Beta.27 review: a stage a person did by hand says so, never "done" as if the stage ran.
  const said = (s: StageCompletion) =>
    s.state === "person" ? `${s.stage} (written by a person)` : s.stage;
  const name = handoffName(type, phase);
  let summary: string;
  if (under)
    summary = `The ${under.stage} stage is ${under.state === "questions" ? "waiting on answers" : under.state}${done.length ? ` (${and(done)} done)` : ""}; the change is in ${state}.`;
  else if (!current || !stageWorkDone(current.state))
    summary = `${done.length ? `${cap(and(done))} done; ` : ""}the ${current?.stage ?? phase} stage hasn't run yet; the change is in ${state}.`;
  else if (ahead.length)
    summary = `${cap(said(last!))} done; the change is still in ${state}: ${raised ? "merge" : "raise"} "${name}" (the ${phase} hand-off), then the ${and(ahead)} hand-offs.`;
  else
    summary = `${cap(said(current))} done; waiting on "${name}" (the ${phase} hand-off${raised ? " PR to merge" : ", not raised yet"}).`;
  return { done, ahead, summary };
}
