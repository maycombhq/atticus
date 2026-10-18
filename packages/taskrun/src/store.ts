import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { changeFolder, writeFileAtomic } from "@maycombhq/changes";
import { changesDirOf, RecordId, RunSummary, RuntimeKind, toCanonicalYaml } from "@maycombhq/core";

/**
 * A task run's record, `openspec/changes/<change>/tasks/<task>/task-run.yaml`, next to the
 * C5 run summaries of every AI run it made (`tasks/<task>/runs/<runId>.yaml`) and the plan
 * or report it produced. Full prompts, context packs and build logs stay in git-ignored
 * `.runs/<change>/<runId>/`.
 */
export const TaskRunState = z.enum([
  /** Plan-only finished: tasks/<task>/plan.md is written. */
  "planned",
  /** Hand-off mode: the person's assistant is doing the step. */
  "waiting",
  /** Draft finished with a passing build, committed on the task branch. */
  "built",
  /** Draft finished but the repo has no build command, so nothing was checked. */
  "unverified",
  /** The PR from the task branch to the change branch is open. */
  "pr-open",
  /** The build still fails after the allowed fix rounds, or a PR can't be opened: a person takes over. */
  "needs-person",
  /** The AI run itself failed. */
  "failed",
]);
export type TaskRunState = z.infer<typeof TaskRunState>;

export const RunLevel = z.enum(["plan", "draft", "pr"]);
export type RunLevel = z.infer<typeof RunLevel>;

export const BuildAttempt = z.strictObject({
  n: z.number().int().positive(),
  /** The AI fix run that came before this build, if any. */
  fixRun: z.string().optional(),
  command: z.string(),
  exitCode: z.number().int().nullable(),
  passed: z.boolean(),
  /** Log path relative to the metarepo (.runs/...). */
  log: z.string(),
  at: z.string(),
});
export type BuildAttempt = z.infer<typeof BuildAttempt>;

export const TaskRunRecord = z.strictObject({
  schemaVersion: z.literal(1),
  change: RecordId,
  task: RecordId,
  repo: RecordId,
  level: RunLevel,
  runtime: RuntimeKind,
  engine: z.enum(["speckit", "atticus"]),
  by: z.string().min(1),
  branch: z.string(),
  /** Task worktree, relative to the metarepo. */
  worktree: z.string(),
  state: TaskRunState,
  /** Every AI run, in order (the first is the main run, then fix runs). */
  runs: z.array(z.string()).default([]),
  /** The hand-off run Atticus waits on. */
  waiting: z.string().optional(),
  attempts: z.array(BuildAttempt).default([]),
  /** Files the run changed in the worktree. */
  changed: z.array(z.string()).default([]),
  commit: z.string().optional(),
  pr: z.strictObject({ number: z.number().int().positive(), url: z.string() }).optional(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  notes: z.array(z.string()).default([]),
});
export type TaskRunRecord = z.infer<typeof TaskRunRecord>;

const LEADING = [
  "schemaVersion",
  "change",
  "task",
  "repo",
  "level",
  "runtime",
  "engine",
  "by",
  "branch",
  "worktree",
  "state",
];

export const taskDir = (root: string, change: string, task: string) =>
  join(changeFolder(root, change), "tasks", task);

export async function saveTaskRun(root: string, r: TaskRunRecord): Promise<TaskRunRecord> {
  const v = TaskRunRecord.parse(r);
  await writeFileAtomic(
    join(taskDir(root, v.change, v.task), "task-run.yaml"),
    toCanonicalYaml(v, LEADING),
  );
  return v;
}

export async function readTaskRun(
  root: string,
  change: string,
  task: string,
): Promise<TaskRunRecord | undefined> {
  const text = await readFile(join(taskDir(root, change, task), "task-run.yaml"), "utf8").catch(
    () => undefined,
  );
  return text === undefined ? undefined : TaskRunRecord.parse(parse(text));
}

export async function saveRunSummary(
  root: string,
  change: string,
  task: string,
  s: RunSummary,
): Promise<string> {
  const rel = `tasks/${task}/runs/${s.runId}.yaml`;
  await writeFileAtomic(
    join(changeFolder(root, change), rel),
    toCanonicalYaml(RunSummary.parse(s), ["schemaVersion", "runId"]),
  );
  return rel;
}

/** The task run waiting on a hand-off run, if `runId` is one (for `atticus handoff done`). */
export async function findWaitingTaskRun(
  root: string,
  runId: string,
): Promise<TaskRunRecord | undefined> {
  const changes = changesDirOf(root);
  for (const c of (await readdir(changes, { withFileTypes: true }).catch(() => [])).filter((d) =>
    d.isDirectory(),
  )) {
    for (const t of (
      await readdir(join(changes, c.name, "tasks"), { withFileTypes: true }).catch(() => [])
    ).filter((d) => d.isDirectory())) {
      const r = await readTaskRun(root, c.name, t.name).catch(() => undefined);
      if (r?.waiting === runId) return r;
    }
  }
  return undefined;
}
