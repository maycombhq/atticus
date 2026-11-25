import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import {
  askedGapQuestionId,
  Finding,
  isAssistantResolution,
  listQuestions,
  readQuestion,
  PHASES,
  STAGE_GATE_PREFIX,
  type ChangeLifecycle,
  type ChangeType,
  type LifecycleState,
} from "@maycombhq/core";
import { BUILT_IN_AGENTS } from "./assistant-names.js";
import type { ChangeContext } from "./context.js";
import { asOpenItem, type Reason } from "./errors.js";
import type { Footprint } from "./footprint.js";
import { isWritePattern, writeMatches, type StageStep } from "./policy.js";
import { isFilled } from "./markdown.js";
import { personWrittenPlanning, writesPlanning } from "./planning.js";
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
      // Ninth UX walk: "raise \"Raise PR\"" said raise twice; the build is ready for review.
      return "Build ready";
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
  if (text === undefined) {
    // Beta.27 review: planning files a person wrote are the stage's work done by hand (the stage
    // refuses to replace them unless forced); the gate's critic rounds still read them.
    if (writesPlanning(step) && (await personWrittenPlanning(dir)).length) return [];
    return reason(`The ${step.stage} stage hasn't run yet: run ${run}.`);
  }
  let loop: { state?: unknown; run?: unknown; questions?: unknown; openItems?: unknown } | null;
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
    case "questions": {
      // Seventh UX walk: once every question it asked is answered, it runs again to read them.
      const asked = Array.isArray(loop?.questions)
        ? loop.questions.filter((q): q is string => typeof q === "string")
        : [];
      if (asked.length) {
        const open = new Set(
          (
            await listQuestions(root, { state: "open" }).catch(() => ({ questions: [] }))
          ).questions.map((q) => q.id),
        );
        if (!asked.some((q) => open.has(q)))
          return reason(
            `The ${step.stage} stage's questions are answered: run it again so it reads the answers (${run}).`,
          ).map(asOpenItem);
      }
      // ADR 0210 part 7: open questions are an open item; the hand-off goes ahead with them.
      return reason(
        `The ${step.stage} stage waits for a person to answer its questions: answer them on Questions (or atticus questions), then run the stage again (${run}).`,
      ).map(asOpenItem);
    }
    case "waiting":
      return reason(
        `The ${step.stage} stage is with your assistant${typeof loop?.run === "string" ? ` (run ${loop.run})` : ""}: finish the hand-off, then run ${run} again.`,
      );
    case "drafting":
      return reason(`The ${step.stage} stage is still drafting and isn't done: run ${run}.`);
    default:
      return reason(`${step.loop} doesn't read as a stage's loop state: run ${run} again.`);
  }
  // ADR 0210 part 7: what the stage went on with (a gate it no longer stops at) rides to the hand-off.
  const out: Reason[] = (Array.isArray(loop?.openItems) ? loop.openItems : [])
    .filter((m): m is string => typeof m === "string")
    .map((message) => asOpenItem({ code: "stage-open-item", message }));
  // A folder, a pattern, the loop's own files and a type's artifact (proposal.md, which the
  // artifacts the stage writes decide) aren't due by name: the stage writes them when it has them.
  const artifactFile = new Set(Object.values(FILE));
  for (const w of step.writes.filter(
    (x) =>
      !x.endsWith("/") && !x.startsWith("stage/") && !isWritePattern(x) && !artifactFile.has(x),
  ))
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
    if (w.endsWith("/")) out.push(...(await changeFolderFiles(dir, w.slice(0, -1))));
    else if (isWritePattern(w)) {
      const parent = w.split("/").slice(0, -1).join("/");
      out.push(...(await changeFolderFiles(dir, parent)).filter((p) => writeMatches(w, p)));
    } else if (
      await readFile(join(dir, ...w.split("/"))).then(
        () => true,
        () => false,
      )
    )
      out.push(w);
  }
  return [...new Set(out)].sort();
}

/** Every file under `rel` of a folder (all of it by default), relative to it, sorted. */
export async function changeFolderFiles(dir: string, rel = ""): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(join(dir, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await changeFolderFiles(dir, p)));
    else out.push(p);
  }
  return out.sort();
}

/** The files of one artifact that exist, relative to the change folder. */
export async function artifactFiles(dir: string, artifact: Artifact): Promise<string[]> {
  if (artifact === "specs")
    return (await changeFolderFiles(dir, "specs")).filter((f) => f.endsWith(".md"));
  if (artifact === "stories") {
    const index = (await changeFolderFiles(dir)).includes("stories.md") ? ["stories.md"] : [];
    return [
      ...index,
      ...(await changeFolderFiles(dir, "stories")).filter((f) => f.endsWith(".md")),
    ];
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

/**
 * Beta.27: whether a change's artifact is written (there, and more than its template), as
 * checkArtifacts and the change's page (All changes: Written) say it; a stage's conversation
 * that never ran says the same of the file rather than "hasn't started".
 */
export async function artifactWritten(
  root: string,
  change: string,
  artifact: Artifact,
): Promise<boolean> {
  return (await checkArtifacts(root, { id: change }, [artifact])).length === 0;
}

/** Missing or still-template artifacts, in the type's order. */
export async function checkArtifacts(
  root: string,
  change: Pick<ChangeLifecycle, "id">,
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

/** What an assistant's resolution did, in words (ADR 0115 addendum: it closes nothing). */
const DONE_WORDS: Record<string, string> = {
  apply: "applied",
  "edit-and-apply": "applied",
  "not-relevant": "dismissed",
  waive: "waived",
  ask: "asked",
};

/**
 * Findings on a gate: in the newest round of `review/<gate>/<round>/`, open blocking findings and
 * open knowledge gaps. Waived, applied, dismissed and asked findings, risks and ideas never count.
 * ADR 0210 part 7: an org or team finding is an open item (the hand-off goes ahead and its PR lists
 * it); a constitution finding (the quarantine rule's gaps among them, `layer: constitution`), a
 * round that didn't finish, a lens that didn't review or is still out, and a file that isn't a
 * valid finding still stop the gate.
 */
export async function checkFindings(
  root: string,
  change: ChangeLifecycle,
  gates: string[],
  /** The names that are an AI's (assistantNames): Atticus's own agents at least. */
  known: readonly string[] = BUILT_IN_AGENTS,
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
    const files = (await readdir(dir)).filter((f) => /\.ya?ml$/.test(f)).sort();
    // Round 47: the critic writes `state: in-progress` in meta/round.yaml before its lenses run
    // and the finished record last, so a round it didn't finish (a crash, a kill, or one still
    // running) is never judged by the findings it got to write. A round folder with neither its
    // record nor a finding is one a crash left behind; an older round with finding files and no
    // record is still judged by its findings.
    const unfinished = {
      code: "round-unfinished" as const,
      message: `Critic round ${round} on the ${gate} gate didn't finish: run atticus critic ${change.id} --gate ${gate} again.`,
    };
    let hasMeta = false;
    try {
      const meta = parse(await readFile(join(dir, "meta", "round.yaml"), "utf8")) as {
        state?: string;
        lenses?: {
          lens?: string;
          state?: string;
          runId?: string;
          reason?: string;
          persona?: string;
        }[];
      } | null;
      hasMeta = true;
      if (meta?.state === "in-progress") {
        reasons.push(unfinished);
        continue;
      }
      for (const l of meta?.lenses ?? [])
        // ADR 0203 C: a persona lens never holds a gate; its answer is read in when it comes.
        if (l.persona) continue;
        else if (l.state === "waiting")
          reasons.push({
            code: "lens-waiting",
            message: `The ${l.lens ?? "AI"} lens on the ${gate} gate (round ${round}) is waiting for its hand-off answer${l.runId ? ` (Done on run ${l.runId} in Model runs, or atticus handoff done ${l.runId})` : ""}.`,
          });
        else if (l.state === "failed")
          reasons.push({
            code: "lens-failed",
            message: `The ${l.lens ?? "AI"} lens on the ${gate} gate (round ${round}) didn't review${l.reason ? ` (${l.reason})` : ""}: run atticus critic ${change.id} --gate ${gate} again.`,
          });
    } catch {
      // No meta/round.yaml: an older round, judged by its finding files alone.
    }
    if (!hasMeta && files.length === 0) {
      reasons.push(unfinished);
      continue;
    }
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
      // Ninth UX walk: a knowledge gap a person asked of its owner waits for the owner question
      // Ask raised; a person's answer closes it here. (An ask from before the question existed has
      // none on file, and stays closed as it was.)
      if (x.severity === "gap" && x.state === "asked") {
        const q = await readQuestion(root, askedGapQuestionId(change.id, x)).catch(() => undefined);
        if (q?.state === "open")
          reasons.push(
            (x.layer === "constitution" ? (r: Reason) => r : asOpenItem)({
              code: "open-gap",
              finding: x.id,
              message: `Knowledge gap ${x.id} on the ${gate} gate (round ${round}) was asked of ${q.askedOf ?? x.resolution?.askedOf ?? "its owner"} and waits for the answer (owner question ${q.id}, in Questions, Owner questions): ${x.summary}`,
            }),
          );
        continue;
      }
      // An assistant's resolution of a blocking finding closes nothing (ADR 0115 addendum,
      // 2026-10-25): only a person's does. A file from before the rule still blocks.
      const byAssistant = x.severity === "blocking" && isAssistantResolution(x.resolution, known);
      if (x.state !== "open" && !byAssistant) continue;
      // Constitution rules can never be waived (rule 6): their findings keep stopping the gate.
      const item = x.layer === "constitution" ? (r: Reason) => r : asOpenItem;
      if (x.severity === "blocking")
        reasons.push(
          item({
            code: "blocking-finding",
            finding: x.id,
            message: `Blocking finding ${x.id} on the ${gate} gate (round ${round}): ${x.summary}${byAssistant ? `${/[.!?]$/.test(x.summary) ? "" : "."} An assistant (${x.resolution!.by}) ${DONE_WORDS[x.resolution!.action] ?? "resolved"} it, which closes nothing: only a person's decision does.` : ""}`,
          }),
        );
      else if (x.severity === "gap")
        reasons.push(
          item({
            code: "open-gap",
            finding: x.id,
            message: `Knowledge gap ${x.id} on the ${gate} gate (round ${round}) needs an answer or a fix: ${x.summary}`,
          }),
        );
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
    // ADR 0210 part 7: an open item; the hand-off's PR says no critic reviewed the gate.
    if (rounds.length === 0)
      reasons.push(
        asOpenItem({
          code: "critic-round-missing",
          message: `The ${gate} gate is mandatory on this platform and the critic hasn't reviewed it yet: run atticus critic ${change.id} --gate ${gate}.`,
        }),
      );
  }
  return reasons;
}

/** Gate ids from gates.yaml that sit on this phase. */
export function phaseGates(ctx: ChangeContext, phase: PhaseId): string[] {
  // ADR 0203 A.1: a gates.yaml gate named stage-<x> is a problem of the org pack, never a
  // phase's gate: its folder holds a stage's own findings.
  return ctx.orgPack.gates.gates
    .filter((g) => g.phase === phase && !g.id.startsWith(STAGE_GATE_PREFIX))
    .map((g) => g.id);
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
