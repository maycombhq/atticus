import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { changesRelOf, orgPackDirOf } from "@maycombhq/core";
import { RuntimeConfigError, runtimeForCli, type AiRuntime } from "@maycombhq/ai";
import { changeFolder, loadChangeContext } from "@maycombhq/changes";
import { gateStatus, ownerWaitsLine } from "@maycombhq/naysayer";
import {
  stageGate,
  checkStageDraft,
  formatDraftProblems,
  architectureStage,
  featureStage,
  smallStage,
  stageEnd,
  storiesStage,
  TARGET_DIR,
  type Stage,
  type StageResult,
} from "@maycombhq/planner";
import { runDesignBench, type DesignScore } from "@maycombhq/evals";
import type { Output } from "./commands.js";
import { contextFlags, contextLines } from "./context-flags.js";

/**
 * The change lifecycle's three stages as loops (ADR 0087, plan 4.4): `atticus change feature`,
 * `atticus change architecture`, and `atticus plan stories` on a change with target flows; and
 * `atticus bench design`. Each stage drafts through the AI runtime, runs its checks and the
 * critic on every draft, and goes round until nothing blocks or a question goes to a person.
 */

export interface StageDeps {
  runtime?: AiRuntime;
  /** The critic lenses' runtime; null for its rules only. */
  criticRuntime?: AiRuntime | null;
  now?: Date;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);

async function runtimeOf(
  root: string,
  mode: string | undefined,
  io: Output,
): Promise<AiRuntime | undefined> {
  try {
    return (await runtimeForCli(root, mode ? { mode } : {})).runtime;
  } catch (e) {
    if (e instanceof RuntimeConfigError) {
      io.err(e.message);
      return undefined;
    }
    throw e;
  }
}

const NAMES: Record<Stage, string> = {
  feature: "feature",
  architecture: "architecture",
  stories: "stories",
  small: "fast path",
};

/**
 * atticus stage check <change> <stage> <file> (W3a): the stage's own checks on a draft's file,
 * for a drafter checking its draft before it hands it in (headless Claude Code runs it). Prints
 * the problems with their lines, or that the draft is clean; writes nothing. Exit 1 on problems.
 */
export async function stageCheck(
  root: string,
  change: string | undefined,
  stage: string | undefined,
  file: string | undefined,
  io: Output,
): Promise<number> {
  const stages = ["feature", "architecture", "stories", "small"];
  if (!change || !stage || !file || !stages.includes(stage)) {
    io.err(
      `Usage: atticus stage check <change> <${stages.join("|")}> <file>, for example: atticus stage check add-fraud-check architecture .runs/add-fraud-check/<run>/architecture-answer.yaml`,
    );
    return 2;
  }
  const text = await readFile(resolve(root, file), "utf8").catch(() => undefined);
  if (text === undefined) {
    io.err(`${file} doesn't exist: write the draft there first.`);
    return 2;
  }
  try {
    const problems = await checkStageDraft(root, change, stage as Stage, text);
    io.out(formatDraftProblems(problems));
    return problems.length ? 1 : 0;
  } catch (e) {
    if (e instanceof Error && ["PlannerError", "ChangeError"].includes(e.name)) {
      io.err(e.message);
      return 1;
    }
    throw e;
  }
}

/** What a person calls each stage's files, for "kept your …". */
const WORDS: Record<Stage, string> = {
  feature: "feature placement",
  architecture: "target flows",
  stories: "stories",
  small: "plan",
};

/**
 * What the stage wrote, by the hashes (ADR 0087 addendum): the files a write changed on disk, and
 * "nothing changed" when every hash matched what was there, "kept your …" for a person's files.
 */
export function wroteLines(
  r: Pick<StageResult<unknown>, "stage" | "files" | "changed" | "byPerson">,
): string[] {
  if (!r.files.length) return [];
  if (!r.changed) return [`Wrote ${r.files.join(", ")}.`];
  if (!r.changed.length)
    return [`Kept ${r.byPerson ? "your" : "the"} ${WORDS[r.stage]}: nothing changed.`];
  const kept = r.files.filter((f) => !r.changed!.includes(f));
  return [
    `Wrote ${r.changed.join(", ")}${kept.length ? ` (${kept.join(", ")} ${kept.length === 1 ? "is" : "are"} as it was)` : ""}.`.replace(
      /are as it was\)/,
      "are as they were)",
    ),
  ];
}

/** The open gap of the stage's gate that waits on its owner, when the stage is done (ADR 0087 addendum). */
async function ownerLine(root: string, r: StageResult<unknown>): Promise<string | undefined> {
  if (r.state !== "done") return undefined;
  const gate = stageGate(await loadChangeContext(root), r.stage);
  if (!gate) return undefined;
  const s = await gateStatus(root, r.change, gate).catch(() => undefined);
  return s ? ownerWaitsLine(s, r.change) : undefined;
}

function printStage(
  r: StageResult<unknown>,
  rerun: string,
  io: Output,
  extra: string[] = [],
  owner?: string,
): number {
  for (const n of r.notes) io.out(n);
  for (const l of contextLines(r.context)) io.out(l);
  const current = r.findings.filter((f) => f.blocking && !f.question);
  if (r.state === "waiting") {
    if (current.length) {
      io.out(
        `The last draft went back to your assistant with ${plural(current.length, "finding")}:`,
      );
      for (const f of current) io.out(`  ${f.message}`);
    }
    const w = r.waiting!;
    // The run the stage waits on, as data: a runner offers exactly this run (ADR 0115).
    io.report?.({ handoff: { runId: w.runId, ...(w.lens ? { lens: w.lens } : {}) } });
    io.out(
      w.lens
        ? `Handed the critic's ${w.lens} lens to your assistant to review the ${NAMES[r.stage]} draft (run ${w.runId}). When it is done, run: atticus handoff done ${w.runId}, then ${rerun} --resume ${w.runId}`
        : `Handed the ${NAMES[r.stage]} draft to your assistant (run ${w.runId}). When it is done, run: atticus handoff done ${w.runId}, then ${rerun} --resume ${w.runId}`,
    );
    return 1;
  }
  if (r.state === "questions") {
    // One stop, one message: the questions, then what the assistant kept getting wrong (A2).
    for (const l of stageEnd(r, rerun)) io.out(l);
    return 1;
  }
  io.out(
    `The ${NAMES[r.stage]} stage is done after ${plural(r.iteration, "draft")} (${plural(r.drafts, "draft")} this run): nothing blocking is open and no question is waiting.`,
  );
  // The gate's open gap, in the words change status uses (ADR 0087 addendum).
  if (owner) io.out(owner);
  for (const l of wroteLines(r)) io.out(l);
  for (const l of extra) io.out(l);
  io.out(`Open the stage's pull request for a person to approve: ${r.pr}`);
  return 0;
}

/** The stage commands; undefined when the arguments aren't one of them. */
export async function stageCli(
  root: string,
  positionals: string[],
  values: Record<string, unknown>,
  io: Output,
  deps: StageDeps = {},
): Promise<number | undefined> {
  const [group, command, arg] = positionals;
  const json = values.json === true;
  const isStage =
    (group === "change" &&
      (command === "feature" || command === "architecture" || command === "small")) ||
    (group === "plan" &&
      command === "stories" &&
      !!arg &&
      existsSync(join(changeFolder(root, arg), TARGET_DIR)));
  if (group === "bench" && command === "design") return benchDesign(root, values, io, deps);
  if (!isStage) return undefined;
  if (!arg) {
    io.err(
      `change ${command} needs a change id, for example: atticus change ${command} add-fraud-check`,
    );
    return 2;
  }
  const flags = contextFlags(values);
  if ("error" in flags) {
    io.err(flags.error);
    return 2;
  }
  const runtime = deps.runtime ?? (await runtimeOf(root, str(values.mode), io));
  if (!runtime) return 2;
  const o = {
    context: flags.context,
    runtime,
    ...(deps.criticRuntime !== undefined ? { criticRuntime: deps.criticRuntime } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(str(values.resume) ? { resume: str(values.resume)! } : {}),
    ...(values.force === true ? { force: true } : {}),
  };
  try {
    if (command === "feature") {
      const figma = str(values["from-figma"]);
      const r = await featureStage(root, arg, {
        ...o,
        ...(figma ? { fromFigma: resolve(figma) } : {}),
      });
      if (json) return out(io, r);
      const a = r.answer;
      const extra = a
        ? [
            `Touches ${plural(a.features.length, "feature")} and ${plural(a.flows.length, "flow")}; needs ${plural(a.newFlows.length, "new flow")}; ${plural(a.gaps.length, "gap")}; ${plural(a.conflicts.length, "other change")} in flight on the same flows or systems.`,
            `Next: atticus change architecture ${arg} (or /atticus-architecture ${arg}) once the feature PR is merged.`,
          ]
        : [];
      return printStage(r, `atticus change feature ${arg}`, io, extra, await ownerLine(root, r));
    }
    if (command === "architecture") {
      const r = await architectureStage(root, arg, o);
      if (json) return out(io, r);
      const extra = r.answer
        ? [
            `Target flows: ${r.answer.flows.map((d) => `${d.flow} (${d.change}, ${plural(d.steps.length, "step")})`).join(", ")}, in ${changesRelOf(root)}/${arg}/${TARGET_DIR}/.`,
            `Next: atticus plan stories ${arg} (or /atticus-stories ${arg}) once the architecture PR is merged.`,
          ]
        : [];
      return printStage(
        r,
        `atticus change architecture ${arg}`,
        io,
        extra,
        await ownerLine(root, r),
      );
    }
    // ADR 0113: the fast path, brief to tasks in one AI step.
    if (command === "small") {
      const r = await smallStage(root, arg, o);
      if (json) return out(io, r);
      const tasks = r.stories.reduce((n, s) => n + s.tasks.length, 0);
      const extra = r.answer
        ? [
            `Placed on ${plural(r.answer.flows.length, "flow")}; ${plural(r.answer.targetFlows.length, "target flow")}; ${r.stories.length} ${r.stories.length === 1 ? "story" : "stories"} and ${plural(tasks, "task")}, from the target flows; ${r.requests.length} ${r.requests.length === 1 ? "request or process" : "requests and processes"} suggested in requests.md. A person raises each one.`,
            `Next: once the pull request is merged, the tasks (atticus task context ${arg} <task>, or /atticus-task ${arg} <task>).`,
          ]
        : [];
      return printStage(r, `atticus change small ${arg}`, io, extra, await ownerLine(root, r));
    }
    const r = await storiesStage(root, arg, o);
    if (json) return out(io, r);
    const tasks = r.stories.reduce((n, s) => n + s.tasks.length, 0);
    return printStage(
      r,
      `atticus plan stories ${arg}`,
      io,
      [
        `${r.stories.length} ${r.stories.length === 1 ? "story" : "stories"} and ${plural(tasks, "task")} in ${plural(new Set(r.stories.map((s) => s.repo)).size, "repo")}, from the target flows; ${r.requests.length} ${r.requests.length === 1 ? "request or process" : "requests and processes"} suggested from the knowledge items, in requests.md. A person raises each one.`,
      ],
      await ownerLine(root, r),
    );
  } catch (e) {
    if (
      e instanceof Error &&
      ["PlannerError", "ChangeError", "ChangeFileError", "RuntimeConfigError"].includes(e.name)
    ) {
      io.err(e.message);
      return 1;
    }
    throw e;
  }
}

function out(io: Output, r: StageResult<unknown>): number {
  io.out(JSON.stringify(r, null, 2));
  return r.state === "done" ? 0 : 1;
}

// ------------------------------------------------------------------ atticus bench design

const defaultCache = () =>
  process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "atticus", "bench")
    : join(homedir(), ".cache", "atticus", "bench");

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function printDesignScore(s: DesignScore, io: Output): void {
  io.out(
    `Screens: ${s.screens.found} of ${s.screens.of} found${s.screens.missed.length ? ` (missed: ${s.screens.missed.join(", ")})` : ""}`,
  );
  io.out(
    `Fields: ${s.fields.found} of ${s.fields.of} found; precision ${pct(s.fields.precision)}, recall ${pct(s.fields.recall)}${s.fields.extra.length ? `; ${s.fields.extra.length} not in the reference` : ""}`,
  );
  io.out(`Backing: ${s.backing.correct} of ${s.backing.of} found fields classified right`);
  for (const w of s.backing.wrong) io.out(`  ${w.figmaId} "${w.label}": ${w.why}`);
  io.out(`Actions: ${s.actions.found} of ${s.actions.of} found, ${s.actions.mapped} mapped right`);
  for (const w of s.actions.wrong) io.out(`  ${w.figmaId} "${w.label}": ${w.why}`);
  io.out(
    `Gaps: ${s.gaps.found} of ${s.gaps.of} flagged; precision ${pct(s.gaps.precision)} of ${s.gaps.flagged} flagged`,
  );
  for (const g of s.gaps.missed) io.out(`  missed: ${g}`);
}

/** atticus bench design [--mode m] [--resume run] [--bench dir] [--cache dir] [--json] */
async function benchDesign(
  root: string,
  values: Record<string, unknown>,
  io: Output,
  deps: StageDeps,
): Promise<number> {
  const bench = resolve(str(values.bench) ?? "bench");
  if (!existsSync(join(bench, "design", "reference.yaml"))) {
    io.err(
      `There is no design bench at ${join(bench, "design")}: run this from the Atticus repo, or give --bench <dir>.`,
    );
    return 2;
  }
  const cache = resolve(str(values.cache) ?? defaultCache());
  const work = join(cache, "design");
  const stateFile = join(work, "bench-state.json");
  const resume = str(values.resume);
  if (resume) {
    const state = JSON.parse((await readFile(stateFile, "utf8").catch(() => "{}")) || "{}") as {
      runId?: string;
    };
    if (state.runId !== resume) {
      io.err(
        `${resume} isn't the run the design bench is waiting for${state.runId ? ` (it waits for ${state.runId})` : ""}.`,
      );
      return 2;
    }
  } else {
    await mkdir(join(work, "org-pack"), { recursive: true });
    // The bench runs AI the way this metarepo's runtime.yaml says.
    await copyFile(
      join(orgPackDirOf(root), "runtime.yaml"),
      join(work, "org-pack", "runtime.yaml"),
    ).catch(() => {});
  }
  const runtime = deps.runtime ?? (await runtimeOf(work, str(values.mode), io));
  if (!runtime) return 2;
  const now = deps.now ?? new Date();
  const r = await runDesignBench({ bench, runtime, now, ...(resume ? { resume } : {}) });
  if (r.status === "waiting") {
    await writeFile(stateFile, `${JSON.stringify({ runId: r.runId })}\n`, "utf8");
    io.out(
      `Handed the design to your assistant (run ${r.runId}, in ${work}). When it is done: atticus handoff done ${r.runId} --root ${JSON.stringify(work)}, then atticus bench design --resume ${r.runId}`,
    );
    return 0;
  }
  const results = join(cache, "design-results");
  await mkdir(results, { recursive: true });
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const file = join(results, `${stamp.replace(/[:.]/g, "-")}.json`);
  await writeFile(file, `${JSON.stringify({ at: stamp, ...r }, null, 2)}\n`, "utf8");
  await writeFile(stateFile, "{}\n", "utf8").catch(() => {});
  if (values.json === true) {
    io.out(JSON.stringify(r.score, null, 2));
    return 0;
  }
  io.out(
    `Design bench: ${join(bench, "design")} (${r.read.screens} screens, ${r.read.candidates} fields and actions read; ${plural(r.drafts, "draft")})`,
  );
  printDesignScore(r.score, io);
  if (r.problems.length)
    io.out(
      `The last draft still had ${plural(r.problems.length, "problem")} the checks found; they are in the results file.`,
    );
  io.out(`Details: ${file}`);
  return 0;
}
