import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { changesRelOf, orgPackDirOf } from "@maycombhq/core";
import { RuntimeConfigError, runtimeForCli, type AiRuntime } from "@maycombhq/ai";
import { changeFolder } from "@maycombhq/changes";
import {
  architectureStage,
  featureStage,
  smallStage,
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

function printStage(
  r: StageResult<unknown>,
  rerun: string,
  io: Output,
  extra: string[] = [],
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
    io.out(
      `The ${NAMES[r.stage]} stage stopped for a person after ${plural(r.iteration, "draft")}: ${plural(r.questions.length, "question")} to answer.`,
    );
    for (const q of r.questions) io.out(`  ${q.id}: ${q.question}`);
    io.out(
      `Answer each with atticus questions answer <id> --option <n> (or --text "..."), or with /atticus-answer; then run ${rerun} again.`,
    );
    return 1;
  }
  io.out(
    `The ${NAMES[r.stage]} stage is done after ${plural(r.iteration, "draft")} (${plural(r.drafts, "draft")} this run): nothing blocking is open and no question is waiting.`,
  );
  if (r.files.length) io.out(`Wrote ${r.files.join(", ")}.`);
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
      return printStage(r, `atticus change feature ${arg}`, io, extra);
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
      return printStage(r, `atticus change architecture ${arg}`, io, extra);
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
      return printStage(r, `atticus change small ${arg}`, io, extra);
    }
    const r = await storiesStage(root, arg, o);
    if (json) return out(io, r);
    const tasks = r.stories.reduce((n, s) => n + s.tasks.length, 0);
    return printStage(r, `atticus plan stories ${arg}`, io, [
      `${r.stories.length} ${r.stories.length === 1 ? "story" : "stories"} and ${plural(tasks, "task")} in ${plural(new Set(r.stories.map((s) => s.repo)).size, "repo")}, from the target flows; ${r.requests.length} ${r.requests.length === 1 ? "request or process" : "requests and processes"} suggested from the knowledge items, in requests.md. A person raises each one.`,
    ]);
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
