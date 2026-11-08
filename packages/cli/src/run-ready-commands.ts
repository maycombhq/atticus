import { RUNTIME_MODES, type RuntimeMode } from "@maycombhq/ai";
import {
  RunLevel,
  runReadyTasks,
  readyTasksOf,
  type ReadyPlan,
  type RunReadyResult,
} from "@maycombhq/taskrun";
import type { Output } from "./commands.js";
import { describeRun, type RunDeps } from "./run-commands.js";

/**
 * ADR 0181 part 4: `atticus task run-ready <change>`, Run all ready tasks. The tech lead or
 * architect runs every task whose dependencies are done, in the cross-repo order (the deployment
 * plan's order of the repos), one task run each (ADR 0036), and the batch stops on the first that
 * needs a person. Each ends at the level the person chose: a draft on its own
 * task/<change>/<task> branch, or, with --level pr and the person's --approve, a PR from it into
 * the change branch. Nothing is merged or pushed to a protected branch. Exit codes: 0 ok (or
 * nothing ready), 1 stopped on a task for a person, 2 usage.
 */

/**
 * The change's repos in the order they deploy, from the deployment plan (`atticus release plan`):
 * read from files with stored judgments only (no model is asked), and undefined when the plan
 * can't be made, so tasks.md's order stands.
 */
export async function deployOrderOf(root: string, change: string): Promise<string[] | undefined> {
  try {
    const { loadRelease, deploymentPlan } = await import("@maycombhq/release");
    const plan = await deploymentPlan(await loadRelease(root, change));
    const out: string[] = [];
    for (const s of [...plan.steps].sort((a, b) => a.n - b.n))
      if (!out.includes(s.repo)) out.push(s.repo);
    return out;
  } catch {
    return undefined;
  }
}

/** The ready list in words: what runs, in order, and what waits and why. */
export function readyLines(change: string, p: ReadyPlan): string[] {
  if (!p.tasks.length) return [`Every task of ${change} is done.`];
  const repoOf = new Map(p.tasks.map((t) => [t.id, t.repo]));
  const out = p.ready.length
    ? [
        `Ready to run, in cross-repo order: ${p.ready.map((id) => `${id} (${repoOf.get(id)})`).join(", ")}.`,
      ]
    : [`No task of ${change} is ready to run.`];
  for (const t of p.tasks.filter((x) => !x.ready)) out.push(`  Not ready: task ${t.id}: ${t.why}.`);
  return out;
}

/** atticus task run-ready <change> [--level plan|draft|pr] [--mode <mode>] [--approve] [--dry-run] [--json] */
export async function taskRunReady(
  root: string,
  changeId: string | undefined,
  o: {
    level?: string;
    mode?: string;
    by?: string;
    approve?: boolean;
    dryRun?: boolean;
    json?: boolean;
  },
  io: Output,
  deps: RunDeps & { repoOrder?: string[] } = {},
): Promise<number> {
  if (!changeId) {
    io.err(
      "Usage: atticus task run-ready <change> [--level draft|pr] [--mode hand-off|model|headless-claude-code] [--approve] [--dry-run]",
    );
    return 2;
  }
  if (!o.by) {
    io.err(
      "Say who is running the tasks: set your Git user (git config user.name), or pass --by <you>.",
    );
    return 2;
  }
  if (o.level !== undefined && !RunLevel.safeParse(o.level).success) {
    io.err(`Unknown level ${o.level}. Use one of: plan, draft, pr.`);
    return 2;
  }
  const env = deps.env ?? process.env;
  const mode = o.mode ?? env.ATTICUS_RUNTIME;
  if (
    mode !== undefined &&
    (!(RUNTIME_MODES as readonly string[]).includes(mode) || mode === "mock")
  ) {
    io.err(`Unknown mode ${mode}. Use one of: hand-off, model, headless-claude-code, replay.`);
    return 2;
  }
  const repoOrder = deps.repoOrder ?? (await deployOrderOf(root, changeId));
  let plan: ReadyPlan;
  try {
    plan = await readyTasksOf(root, changeId, repoOrder ? { repoOrder } : {});
  } catch (e) {
    io.err((e as Error).message);
    return 1;
  }
  const level = o.level as RunLevel | undefined;
  // As `task run`: the pr level without --approve, or --dry-run, says what each would do and does
  // nothing. The yes is the person's: an assistant never approves a push.
  const dry = o.dryRun === true || (level === "pr" && !o.approve);
  const now = deps.now ?? (() => new Date());
  let r: RunReadyResult;
  try {
    r = await runReadyTasks(root, changeId, {
      by: o.by,
      ...(level ? { level } : {}),
      ...(mode ? { mode: mode as RuntimeMode } : {}),
      ...(env.ATTICUS_REPLAY_DIR ? { replayDir: env.ATTICUS_REPLAY_DIR } : {}),
      ...(repoOrder ? { repoOrder } : {}),
      ...(dry ? { dryRun: true } : {}),
      ...(o.approve
        ? {
            approval: {
              by: o.by,
              at: now().toISOString(),
              ref: `the ready tasks of ${changeId}: push and PR each (Run all ready tasks)`,
            },
          }
        : {}),
      ...(deps.runtime ? { runtime: deps.runtime } : {}),
      ...(deps.runtimeOptions ? { runtimeOptions: deps.runtimeOptions } : {}),
      ...(deps.commands ? { commands: deps.commands } : {}),
      ...(deps.git ? { git: deps.git } : {}),
      ...(deps.gitHost ? { gitHost: deps.gitHost } : {}),
      now,
    });
  } catch (e) {
    io.err((e as Error).message);
    return 1;
  }
  if (o.json) {
    io.out(
      JSON.stringify(
        { change: changeId, ...plan, ...r, ...(dry ? { dryRun: true } : {}) },
        null,
        2,
      ),
    );
    return r.stopped ? 1 : 0;
  }
  for (const l of readyLines(changeId, plan)) io.out(l);
  if (dry) {
    for (const p of r.previews ?? [])
      io.out(
        "refused" in p
          ? `Task ${p.task}: ${p.refused}`
          : `Task ${p.task} on ${p.repo} at the ${p.level} level, on ${p.branch}${p.level === "pr" ? (p.gitHost ? ", then its PR into the change branch." : "; no Git host is connected, so you push it and open the PR.") : "."}`,
      );
    io.out(
      level === "pr" && !o.approve && !o.dryRun
        ? "Nothing was done: run it again with --approve to let each task's branch be pushed and its PR opened (the person's yes; an assistant never approves a push)."
        : "Nothing was done: this was a dry run.",
    );
    return 0;
  }
  for (const x of r.ran) {
    if ("record" in x) describeRun(root, x.record, io);
    else io.out(`Task ${x.task} wasn't run: ${x.refused}`);
  }
  if (r.stopped) {
    const left = r.planned.slice(r.planned.indexOf(r.stopped.task) + 1);
    io.out(
      `Stopped at task ${r.stopped.task}, which needs a person${left.length ? `; not run yet: ${left.join(", ")}` : ""}. Run atticus task run-ready ${changeId} again once it is picked up.`,
    );
    return 1;
  }
  if (r.ran.length)
    io.out(
      `Ran ${r.ran.length} ${r.ran.length === 1 ? "task" : "tasks"}. A person reviews and merges each PR on the Git host; nothing was merged.`,
    );
  return 0;
}
