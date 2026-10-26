import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import {
  Finding,
  PHASES,
  type ChangeLifecycle,
  type ChangeType,
  type LifecycleState,
} from "@maycombhq/core";
import type { ChangeContext } from "./context.js";
import type { Reason } from "./errors.js";
import type { Footprint } from "./footprint.js";
import type { StageStep } from "./policy.js";
import { isFilled } from "./markdown.js";
import { changeFolder } from "./store.js";
import type { Artifact, PhaseId } from "./types.js";

/** A phase's state shares its name, except release, which waits for go/no-go. */
export function phaseState(phase: PhaseId): LifecycleState {
  return phase === "release" ? "release-ready" : phase;
}

/** The phase a change is in, if its state is a phase state. */
export function statePhase(state: LifecycleState): PhaseId | undefined {
  if (state === "release-ready") return "release";
  return (PHASES as readonly string[]).includes(state) ? (state as PhaseId) : undefined;
}

/** The state a merged hand-off of this phase leads to. */
export function nextState(type: ChangeType, phase: PhaseId): LifecycleState {
  const i = type.phases.indexOf(phase);
  const next = type.phases[i + 1];
  return next ? phaseState(next) : "released";
}

const ARRIVE: Record<PhaseId, string> = {
  define: "definition",
  design: "architecture",
  plan: "planning",
  build: "build",
  qa: "QA",
  release: "release",
};

/** The hand-off's name, as people say it. */
export function handoffName(type: ChangeType, phase: PhaseId): string {
  switch (phase) {
    case "define": {
      const next = type.phases[type.phases.indexOf(phase) + 1];
      return next ? `Send to ${ARRIVE[next]}` : "Go/no-go";
    }
    case "design":
      return "Approve design";
    case "plan":
      return "Plan ready";
    case "build":
      return "Raise PR";
    case "qa":
      return "QA sign-off";
    case "release":
      return "Go/no-go";
  }
}

/**
 * The phase in which a type writes and hands off an artifact: the policy's phase for the
 * artifact if the type has it, else the type's next phase after it (an emergency fix writes
 * its proposal in Build), else the type's last phase.
 */
export function artifactPhase(ctx: ChangeContext, type: ChangeType, artifact: Artifact): PhaseId {
  const want = PHASES.indexOf(ctx.policy.artifactPhases[artifact]);
  return type.phases.find((p) => PHASES.indexOf(p) >= want) ?? type.phases.at(-1)!;
}

/** Artifacts of the type handed off in this phase; brief.md also rides with the first phase. */
export function phaseArtifacts(ctx: ChangeContext, type: ChangeType, phase: PhaseId): Artifact[] {
  const out = (type.artifacts as Artifact[]).filter((a) => artifactPhase(ctx, type, a) === phase);
  if (phase === type.phases[0] && !out.includes("brief")) out.unshift("brief");
  return out;
}

/**
 * Artifacts that must exist and be filled in before the phase hands off. data.md is only
 * required when the change touches a data store; brief.md only when the type lists it.
 */
export function requiredArtifacts(
  ctx: ChangeContext,
  type: ChangeType,
  phase: PhaseId,
  footprint: Footprint,
): Artifact[] {
  return phaseArtifacts(ctx, type, phase).filter((a) => {
    if (!type.artifacts.includes(a)) return false;
    // On the stage path the architecture stage writes data.md only for data changes (a new table,
    // new or retyped columns), so a read of a table doesn't make it due (B-change).
    if (a === "data")
      return footprint.from.some((f) => f.startsWith("target-flows/"))
        ? footprint.signals.some((s) => s.factor === "schema")
        : footprint.dataStores.length + footprint.tables.length > 0;
    return true;
  });
}

/**
 * The stage a change is on for a phase (ADR 0087), or undefined when the change is on the
 * change-draft path: its folder holds no stage's loop state, or the policy has no stage for the
 * phase. A change is on the stage path once any stage of the path has run.
 */
export async function phaseStage(
  ctx: ChangeContext,
  change: ChangeLifecycle,
  phase: PhaseId,
): Promise<StageStep | undefined> {
  const step = ctx.policy.stages.find((x) => x.phase === phase);
  if (!step) return undefined;
  const dir = changeFolder(ctx.root, change.id);
  for (const x of ctx.policy.stages)
    if (
      await readFile(join(dir, ...x.loop.split("/"))).then(
        () => true,
        () => false,
      )
    )
      return step;
  return undefined;
}

/** A stage's command for a change. */
export const stageCommand = (step: StageStep, change: string) =>
  step.command.replaceAll("<change>", change);

/**
 * Why a phase's stage isn't done (ADR 0087): its loop state, as `stage/<stage>.yaml` says it,
 * isn't done, or a file the stage writes is missing. Empty when the stage is done.
 */
export async function checkStage(
  root: string,
  change: ChangeLifecycle,
  step: StageStep,
): Promise<Reason[]> {
  const dir = changeFolder(root, change.id);
  const run = stageCommand(step, change.id);
  const reason = (message: string): Reason[] => [{ code: "stage-not-done", message }];
  const text = await readFile(join(dir, ...step.loop.split("/")), "utf8").catch(() => undefined);
  if (text === undefined) return reason(`The ${step.stage} stage hasn't run yet: run ${run}.`);
  let loop: { state?: unknown; run?: unknown } | null;
  try {
    loop = parse(text) as typeof loop;
  } catch {
    loop = null;
  }
  const state = typeof loop?.state === "string" ? loop.state : undefined;
  switch (state) {
    case "done":
      break;
    case "stopped":
      return reason(
        `The ${step.stage} stage stopped and isn't done: see what stopped it, then run ${run} again.`,
      );
    case "questions":
      return reason(
        `The ${step.stage} stage waits for a person to answer its questions: answer them (atticus questions), then run ${run} again.`,
      );
    case "waiting":
      return reason(
        `The ${step.stage} stage is with your assistant${typeof loop?.run === "string" ? ` (run ${loop.run})` : ""}: finish the hand-off, then run ${run} again.`,
      );
    case "drafting":
      return reason(`The ${step.stage} stage is still drafting and isn't done: run ${run}.`);
    default:
      return reason(`${step.loop} doesn't read as a stage's loop state: run ${run} again.`);
  }
  const out: Reason[] = [];
  for (const w of step.writes.filter((x) => !x.endsWith("/") && !x.startsWith("stage/")))
    if (
      !(await readFile(join(dir, ...w.split("/"))).then(
        () => true,
        () => false,
      ))
    )
      out.push(
        ...reason(`${w} is missing, though the ${step.stage} stage is done: run ${run} again.`),
      );
  return out;
}

/** The files a stage wrote that exist, relative to the change folder, with its loop state. */
export async function stageFiles(dir: string, step: StageStep): Promise<string[]> {
  const out: string[] = [];
  for (const w of [...step.writes, step.loop]) {
    if (w.endsWith("/")) out.push(...(await walk(dir, w.slice(0, -1))));
    else if (
      await readFile(join(dir, ...w.split("/"))).then(
        () => true,
        () => false,
      )
    )
      out.push(w);
  }
  return [...new Set(out)].sort();
}

async function walk(dir: string, rel = ""): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(join(dir, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walk(dir, p)));
    else out.push(p);
  }
  return out.sort();
}

/** The files of one artifact that exist, relative to the change folder. */
export async function artifactFiles(dir: string, artifact: Artifact): Promise<string[]> {
  if (artifact === "specs") return (await walk(dir, "specs")).filter((f) => f.endsWith(".md"));
  if (artifact === "stories") {
    const index = (await walk(dir)).includes("stories.md") ? ["stories.md"] : [];
    return [...index, ...(await walk(dir, "stories")).filter((f) => f.endsWith(".md"))];
  }
  const f = `${artifact}.md`;
  try {
    await readFile(join(dir, f));
    return [f];
  } catch {
    return [];
  }
}

const FILE: Record<Artifact, string> = {
  brief: "brief.md",
  proposal: "proposal.md",
  specs: "specs/<capability>/spec.md",
  interfaces: "interfaces.md",
  mappings: "mappings.md",
  data: "data.md",
  design: "design.md",
  ux: "ux.md",
  stories: "stories.md",
  tasks: "tasks.md",
  snow: "snow.md",
};

/** Missing or still-template artifacts, in the type's order. */
export async function checkArtifacts(
  root: string,
  change: ChangeLifecycle,
  artifacts: Artifact[],
): Promise<Reason[]> {
  const dir = changeFolder(root, change.id);
  const reasons: Reason[] = [];
  for (const a of artifacts) {
    let files = await artifactFiles(dir, a);
    if (a === "stories") files = files.filter((f) => f === "stories.md");
    if (files.length === 0) {
      reasons.push({ code: "missing-artifact", artifact: a, message: `${FILE[a]} is missing.` });
      continue;
    }
    const texts = await Promise.all(files.map((f) => readFile(join(dir, f), "utf8")));
    if (!texts.some(isFilled)) {
      reasons.push({
        code: "unfilled-artifact",
        artifact: a,
        message: `${files.length === 1 ? files[0] : FILE[a]} still holds only the template.`,
      });
    }
  }
  return reasons;
}

/**
 * Findings that stop a gate: in the newest round of `review/<gate>/<round>/`, open blocking
 * findings and open knowledge gaps. Waived, applied, dismissed and asked findings, risks
 * and ideas never block. A file that isn't a valid finding blocks too: it can't be checked.
 */
export async function checkFindings(
  root: string,
  change: ChangeLifecycle,
  gates: string[],
): Promise<Reason[]> {
  const reasons: Reason[] = [];
  for (const gate of gates) {
    const base = join(changeFolder(root, change.id), "review", gate);
    let rounds: number[];
    try {
      rounds = (await readdir(base, { withFileTypes: true }))
        .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
        .map((d) => Number(d.name));
    } catch {
      continue;
    }
    if (rounds.length === 0) continue;
    const round = Math.max(...rounds);
    const dir = join(base, String(round));
    // A round started in hand-off mode isn't decided until every AI lens has answered; a lens
    // that failed (no answer, or an answer that isn't a review) never reviewed, so it stops the
    // gate too, until a new critic round reviews.
    try {
      const meta = parse(await readFile(join(dir, "meta", "round.yaml"), "utf8")) as {
        lenses?: { lens?: string; state?: string; runId?: string; reason?: string }[];
      } | null;
      for (const l of meta?.lenses ?? [])
        if (l.state === "waiting")
          reasons.push({
            code: "lens-waiting",
            message: `The ${l.lens ?? "AI"} lens on the ${gate} gate (round ${round}) is waiting for its hand-off answer${l.runId ? ` (atticus handoff done ${l.runId})` : ""}.`,
          });
        else if (l.state === "failed")
          reasons.push({
            code: "lens-failed",
            message: `The ${l.lens ?? "AI"} lens on the ${gate} gate (round ${round}) didn't review${l.reason ? ` (${l.reason})` : ""}: run atticus critic ${change.id} --gate ${gate} again.`,
          });
    } catch {
      // No meta/round.yaml: an older round, judged by its finding files alone.
    }
    const files = (await readdir(dir)).filter((f) => /\.ya?ml$/.test(f)).sort();
    for (const f of files) {
      const rel = `review/${gate}/${round}/${f}`;
      let data: unknown;
      try {
        data = parse(await readFile(join(dir, f), "utf8"));
      } catch {
        data = undefined;
      }
      const r = Finding.safeParse(data);
      if (!r.success) {
        reasons.push({
          code: "bad-finding",
          message: `${rel} is not a valid finding (${r.error.issues[0]?.message ?? "unreadable"}), so the ${gate} gate can't be checked.`,
        });
        continue;
      }
      const x = r.data;
      if (x.state !== "open") continue;
      if (x.severity === "blocking")
        reasons.push({
          code: "blocking-finding",
          finding: x.id,
          message: `Blocking finding ${x.id} on the ${gate} gate (round ${round}): ${x.summary}`,
        });
      else if (x.severity === "gap")
        reasons.push({
          code: "open-gap",
          finding: x.id,
          message: `Knowledge gap ${x.id} on the ${gate} gate (round ${round}) needs an answer or a fix: ${x.summary}`,
        });
    }
  }
  return reasons;
}

/** Gate ids the platform profiles make mandatory (profile.yaml `gates`). */
export function mandatoryGates(ctx: ChangeContext): string[] {
  return [...new Set(ctx.orgPack.profiles.flatMap((p) => p.profile?.gates ?? []))].sort();
}

/**
 * A gate the platform makes mandatory needs a critic round before the hand-off that leaves
 * it: an empty `review/<gate>/` means nobody ran the critic there. (Whether the newest round
 * passes is `checkFindings`'s job.)
 */
export async function checkMandatoryRounds(
  root: string,
  change: ChangeLifecycle,
  gates: string[],
): Promise<Reason[]> {
  const reasons: Reason[] = [];
  for (const gate of gates) {
    const rounds = await readdir(join(changeFolder(root, change.id), "review", gate), {
      withFileTypes: true,
    }).then(
      (ds) => ds.filter((d) => d.isDirectory() && /^\d+$/.test(d.name)),
      () => [],
    );
    if (rounds.length === 0)
      reasons.push({
        code: "critic-round-missing",
        message: `The ${gate} gate is mandatory on this platform and the critic hasn't reviewed it yet: run atticus critic ${change.id} --gate ${gate}.`,
      });
  }
  return reasons;
}

/** Gate ids from gates.yaml that sit on this phase. */
export function phaseGates(ctx: ChangeContext, phase: PhaseId): string[] {
  return ctx.orgPack.gates.gates.filter((g) => g.phase === phase).map((g) => g.id);
}

/**
 * Gates Atticus itself writes findings to, whether or not gates.yaml lists them: the drift
 * check, the Spec Kit hand-up and traceability (ADR 0039), and the code against the target
 * flows (conform, ADR 0114).
 */
export const BUILT_IN_GATES: readonly string[] = ["drift", "hand-up", "trace", "conform"];

/** The phases whose hand-offs the built-in gates hold back: Build, QA and Go/no-go. */
const BUILT_IN_GATE_PHASES: readonly PhaseId[] = ["build", "qa", "release"];

/**
 * The gates whose findings stop this phase's hand-off: its gates.yaml gates, and for the
 * Build, QA and Go/no-go phases the built-in gates too ("read by the lifecycle like any gate").
 */
export function phaseFindingGates(ctx: ChangeContext, phase: PhaseId): string[] {
  const own = phaseGates(ctx, phase);
  if (!BUILT_IN_GATE_PHASES.includes(phase)) return own;
  return [...own, ...BUILT_IN_GATES.filter((g) => !own.includes(g))];
}

export function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}
