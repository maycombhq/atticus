import { changeFolder } from "@maycombhq/changes";
import { readChangeFiles, readStoryIndex } from "@maycombhq/naysayer";
import { readChangeTasks } from "@maycombhq/speckit";
import { previewTaskRun, runTask, type RunTaskOptions, type TaskRunPreview } from "./run.js";
import { readTaskRun, type RunLevel, type TaskRunRecord, type TaskRunState } from "./store.js";

/**
 * ADR 0181 part 4: Run all ready tasks. The tech lead or architect runs every task of a change
 * whose dependencies are done, on its repos, in the cross-repo order, one task run per task (ADR
 * 0036: its lock, dry run and preview), one after another, stopping on the first that needs a
 * person. Each ends at the level the person chose: a draft committed on its own
 * task/<change>/<task> branch, or, at the pr level with the person's approval, a PR from that
 * branch into the change branch. Nothing is merged, and nothing is pushed to a protected branch.
 *
 * A task depends on the tasks of the stories its story depends on (stories.md, "Depends on"), and
 * (ninth UX walk) on the earlier tasks of its own repo in tasks.md order, since each task's draft
 * starts from the change branch: a task marked [P] (Spec Kit's marker) doesn't wait for the [P]
 * tasks just before it in its repo. It is done when it is ticked in tasks.md (a merged PR ticks it). The cross-repo order is the
 * deployment plan's order of the repos when the caller gives one, else tasks.md's.
 */

/** A task as the ready list reads it. */
export interface ReadyInput {
  id: string;
  repo: string;
  done: boolean;
  stories: string[];
  /** Ninth UX walk: tasks.md marks it [P], so it may go with the [P] tasks next to it in its repo. */
  parallel?: boolean | undefined;
  /** Where its last task run stands, if it ran. */
  state?: TaskRunState | undefined;
  /** For a task whose PR is open: the Git host says it was merged or closed (review round 43). */
  prSettled?: "merged" | "closed" | undefined;
}

/** A not-done task, in run order: ready to run, or why not. */
export interface ReadyTask {
  id: string;
  repo: string;
  ready: boolean;
  /** The not-done tasks it waits for (its stories' dependencies, and the earlier ones of its repo). */
  waitsFor: string[];
  /**
   * Ninth UX walk: of those, the earlier not-done tasks of its own repo in tasks.md order, so each
   * is drafted from a base with the code before it. Absent when none.
   */
  sameRepo?: string[];
  /** Why it isn't ready, in words; absent when it is. */
  why?: string;
}

export interface ReadyPlan {
  /** Every task not done yet, in the cross-repo order. */
  tasks: ReadyTask[];
  /** The ids of the ready ones, in the order they run. */
  ready: string[];
}

/** The states in which a task has run and waits on its PR, the assistant or a person: not run again here. */
const PAST: Partial<Record<TaskRunState, string>> = {
  waiting: "it is with your assistant: Done on its run carries on",
  built: "it is drafted: its PR is the next step",
  // App-only audit: Build and raise PR builds it (once its repo has a build command), or Run again.
  unverified:
    "it is drafted but not built yet: Build and raise PR on its card builds it with its repo's build command, or Run again drafts it afresh",
  "pr-open": "its PR is open on the Git host",
  "needs-person": "it needs a person: carry on in its worktree, or Run with AI on it",
};

/**
 * Ninth UX walk: the not-done tasks before `t` in its own repo, in tasks.md order. A [P] task
 * doesn't wait for the [P] tasks right before it in its repo (they go together), only for what is
 * before them.
 */
function sameRepoBefore(tasks: readonly ReadyInput[], t: ReadyInput): string[] {
  const mine = tasks.slice(0, tasks.indexOf(t)).filter((x) => x.repo === t.repo);
  let cut = mine.length;
  if (t.parallel) while (cut > 0 && mine[cut - 1]!.parallel) cut--;
  return mine
    .slice(0, cut)
    .filter((x) => !x.done)
    .map((x) => x.id);
}

/** Which tasks are ready, and the order to run them in (pure: files are read by `readyTasksOf`). */
export function planReadyTasks(o: {
  tasks: readonly ReadyInput[];
  stories: readonly { id: string; dependsOn: readonly string[] }[];
  /** The repos in the order they deploy (the deployment plan); repos it leaves out go after. */
  repoOrder?: readonly string[];
}): ReadyPlan {
  const deps = new Map(o.stories.map((s) => [s.id, s.dependsOn]));
  const rank = (repo: string) => {
    const i = o.repoOrder?.indexOf(repo) ?? -1;
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const firstOfRepo = new Map<string, number>();
  o.tasks.forEach((t, i) => {
    if (!firstOfRepo.has(t.repo)) firstOfRepo.set(t.repo, i);
  });
  const order = o.tasks
    .map((t, i) => ({ t, i }))
    .sort(
      (a, b) =>
        rank(a.t.repo) - rank(b.t.repo) ||
        firstOfRepo.get(a.t.repo)! - firstOfRepo.get(b.t.repo)! ||
        a.i - b.i,
    )
    .map((x) => x.t);
  const out: ReadyTask[] = [];
  for (const t of order) {
    if (t.done) continue;
    const before = new Set(t.stories.flatMap((s) => deps.get(s) ?? []));
    const byStory = o.tasks
      .filter((x) => x.id !== t.id && !x.done && x.stories.some((s) => before.has(s)))
      .map((x) => x.id);
    const sameRepo = sameRepoBefore(o.tasks, t).filter((id) => !byStory.includes(id));
    const waitsFor = o.tasks
      .map((x) => x.id)
      .filter((id) => byStory.includes(id) || sameRepo.includes(id));
    const past = t.state && !(t.state === "pr-open" && t.prSettled) ? PAST[t.state] : undefined;
    const named = [
      ...byStory,
      ...(sameRepo.length ? [`${sameRepo.join(", ")} (same repo)`] : []),
    ].join(", ");
    const why = waitsFor.length
      ? `it waits for ${waitsFor.length === 1 ? "task" : "tasks"} ${named} to be done first`
      : past;
    out.push({
      id: t.id,
      repo: t.repo,
      ready: !why,
      waitsFor,
      ...(sameRepo.length ? { sameRepo } : {}),
      ...(why ? { why } : {}),
    });
  }
  return { tasks: out, ready: out.filter((t) => t.ready).map((t) => t.id) };
}

/** A change's ready tasks from its files: tasks.md, stories.md and each task's task-run.yaml. */
export async function readyTasksOf(
  root: string,
  change: string,
  o: {
    repoOrder?: readonly string[];
    /** The Git host's word on each open PR (the Task board's read-only ask), by task id. */
    prStates?: ReadonlyMap<string, "open" | "merged" | "closed">;
  } = {},
): Promise<ReadyPlan> {
  const files = await readChangeFiles(changeFolder(root, change));
  const tasks: ReadyInput[] = [];
  for (const t of readChangeTasks(files)) {
    const r = await readTaskRun(root, change, t.id).catch(() => undefined);
    const pr = o.prStates?.get(t.id);
    tasks.push({
      id: t.id,
      repo: t.repo,
      done: t.done,
      stories: t.stories,
      ...(t.parallel ? { parallel: true } : {}),
      ...(r ? { state: r.state } : {}),
      ...(pr === "merged" || pr === "closed" ? { prSettled: pr } : {}),
    });
  }
  return planReadyTasks({
    tasks,
    stories: readStoryIndex(files),
    ...(o.repoOrder ? { repoOrder: o.repoOrder } : {}),
  });
}

/** One task's outcome in a Run all ready tasks. */
export type ReadyOutcome =
  | { task: string; repo: string; record: TaskRunRecord }
  | { task: string; repo: string; refused: string };

export interface RunReadyResult {
  /** The ready tasks, in the order they were to run. */
  planned: string[];
  /** What each task that ran did, in order. */
  ran: ReadyOutcome[];
  /** The task the batch stopped on, and why: it needs a person, failed or was refused. */
  stopped?: { task: string; why: string };
  /** For a dry run: what each ready task would do (nothing is done). */
  previews?: (TaskRunPreview | { task: string; refused: string })[];
}

/**
 * Whether a run's end is one a person picks up from: the build failed, a person is needed, the
 * assistant has it (hand-off), the repo has no build command, or, at the pr level, the PR wasn't
 * raised. The next task then waits for them.
 */
export function needsPerson(r: TaskRunRecord): string | undefined {
  if (r.state === "failed") return r.notes.at(-1) ?? `the run for task ${r.task} failed`;
  if (r.state === "needs-person") return r.notes.at(-1) ?? `task ${r.task} needs a person`;
  if (r.state === "waiting") return `task ${r.task} is with your assistant: Done on its run first`;
  if (r.state === "unverified")
    return `task ${r.task} is drafted but ${r.repo} has no build command, so nothing was built`;
  if (r.level === "pr" && r.state === "built")
    return r.notes.at(-1) ?? `task ${r.task}'s PR wasn't raised`;
  return undefined;
}

/**
 * Run every ready task in order, one task run each (`runTask`, which holds the task's lock), and
 * stop on the first that needs a person. `dryRun` previews each (`previewTaskRun`: the level, the
 * cap, whether it is held) and does nothing. `before` runs before each task (the app opens the
 * task's worktree there); `progress` hears of each step; `cancelled` is asked between tasks.
 */
export async function runReadyTasks(
  root: string,
  change: string,
  o: Omit<RunTaskOptions, "level"> & {
    level?: RunLevel;
    repoOrder?: readonly string[];
    prStates?: ReadonlyMap<string, "open" | "merged" | "closed">;
    dryRun?: boolean;
    /** Run only these of the ready tasks (the ones the person saw), in the ready order. */
    only?: readonly string[];
    before?: (task: string) => Promise<string | undefined>;
    /** The level for one task when `level` isn't given (the app: runtime.yaml's, lowered to draft). */
    levelFor?: (task: string) => Promise<RunLevel | undefined>;
    progress?: (done: number, total: number, message: string) => void;
    cancelled?: () => boolean;
  },
): Promise<RunReadyResult> {
  const plan = await readyTasksOf(root, change, {
    ...(o.repoOrder ? { repoOrder: o.repoOrder } : {}),
    ...(o.prStates ? { prStates: o.prStates } : {}),
  });
  const planned = o.only ? plan.ready.filter((id) => o.only!.includes(id)) : plan.ready;
  const repoOf = new Map(plan.tasks.map((t) => [t.id, t.repo]));
  if (o.dryRun) {
    const previews: NonNullable<RunReadyResult["previews"]> = [];
    for (const task of planned)
      try {
        previews.push(
          await previewTaskRun(root, change, task, {
            ...(o.level ? { level: o.level } : {}),
            ...(o.gitHost ? { gitHost: o.gitHost } : {}),
          }),
        );
      } catch (e) {
        previews.push({ task, refused: (e as Error).message });
      }
    return { planned, ran: [], previews };
  }
  const {
    only: _only,
    before,
    levelFor,
    progress,
    cancelled,
    repoOrder: _r,
    prStates: _p,
    dryRun: _d,
    ...run
  } = o;
  const ran: ReadyOutcome[] = [];
  for (const [i, task] of planned.entries()) {
    const repo = repoOf.get(task) ?? "";
    if (cancelled?.()) return { planned, ran, stopped: { task, why: "the run was cancelled" } };
    progress?.(i, planned.length, `Task ${task} on ${repo}`);
    const refusedBefore = await before?.(task);
    if (refusedBefore) {
      ran.push({ task, repo, refused: refusedBefore });
      return { planned, ran, stopped: { task, why: refusedBefore } };
    }
    let record: TaskRunRecord;
    try {
      const level = run.level ?? (await levelFor?.(task));
      record = await runTask(root, change, task, { ...run, ...(level ? { level } : {}) });
    } catch (e) {
      const why = (e as Error).message;
      ran.push({ task, repo, refused: why });
      return { planned, ran, stopped: { task, why } };
    }
    ran.push({ task, repo, record });
    const why = needsPerson(record);
    if (why) return { planned, ran, stopped: { task, why } };
  }
  progress?.(planned.length, planned.length, "Done");
  return { planned, ran };
}
