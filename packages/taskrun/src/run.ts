import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createAdapters,
  fileStepStore,
  requireApproval,
  type Approval,
  type GitHost,
} from "@maycombhq/adapters";
import {
  createRuntime,
  HandoffRuntime,
  quarantineItems,
  toRunSummary,
  type AiRequest,
  type AiRuntime,
  type CreateRuntimeOptions,
  type Run,
  type RuntimeMode,
} from "@maycombhq/ai";
import { writeFileAtomic, changeFolder } from "@maycombhq/changes";
import {
  acquireLock,
  changeBranch,
  changesRelOf,
  LockHeldError,
  runsDirOf,
  runsRelOf,
  taskBranch,
} from "@maycombhq/core";
import { writeQuarantineItems } from "@maycombhq/naysayer";
import {
  buildEngineFor,
  changeWorktree,
  handDown,
  loadTask,
  openTaskWorktree,
  type TaskContext,
} from "@maycombhq/speckit";
import { createGit, toRepoRelative, type GitRunner } from "@maycombhq/workspace";
import { applyChanges, parseAnswer } from "./apply.js";
import {
  holdSignals,
  shellCommandRunner,
  stopRequested,
  stopSignal,
  type CommandRunner,
} from "./commands.js";
import { conformAfterBuild } from "./conform.js";
import { taskPack, taskRunnerAgent } from "./prompt.js";
import {
  findWaitingTaskRun,
  readTaskRun,
  saveRunSummary,
  saveTaskRun,
  type BuildAttempt,
  type RunLevel,
  type TaskRunRecord,
} from "./store.js";

/**
 * Run with AI (ADR 0030 point 3, ADR 0014, ADR 0009): one task of a change, in its repo, at
 * one of three levels.
 *
 * - `plan`: the AI writes a plan for the task to `tasks/<task>/plan.md` in the change folder.
 * - `draft`: the AI changes code in the task's own worktree on `task/<change-id>/<task-id>`
 *   (cut from the change branch); Atticus runs the repo's build, sends failures back for up to
 *   `autonomy.maxFixRounds` fix rounds (three by default), each recorded, then stops and hands
 *   to a person. A passing build is committed on the task branch, locally.
 * - `pr`: as draft, then, with a person's approval, pushes the task branch and opens a PR into
 *   the change branch through the Git host adapter. Never to a protected branch; AI never
 *   pushes to main or deploys.
 *
 * In hand-off mode Atticus writes the prompt and context pack and waits (prepared → waiting);
 * `atticus handoff done <run>` completes it through `completeTaskHandoff`. Every AI run's C5
 * summary is recorded under the change.
 */

export class TaskRunError extends Error {
  constructor(
    readonly code: "refused" | "invalid" | "not-found",
    message: string,
  ) {
    super(message);
    this.name = "TaskRunError";
  }
}

export interface RunTaskOptions {
  /** Default: runtime.yaml autonomy.default. */
  level?: RunLevel;
  /** Default: runtime.yaml modes.default. */
  mode?: RuntimeMode;
  by: string;
  /** Required for the pr level: the person's approval to push the task branch and open the PR. */
  approval?: Approval;
  /** Use this runtime instead of building one from runtime.yaml (tests: mock or replay). */
  runtime?: AiRuntime;
  /** Replay mode: the folder of recordings (the CLI passes ATTICUS_REPLAY_DIR). */
  replayDir?: string;
  /** Extra runtime-factory options (model providers, a headless runner). */
  runtimeOptions?: Omit<CreateRuntimeOptions, "root" | "mode">;
  commands?: CommandRunner;
  git?: GitRunner;
  gitHost?: GitHost;
  now?: () => Date;
}

const LEVEL_RANK: Record<RunLevel, number> = { plan: 0, draft: 1, pr: 2 };
const AUTONOMY: Record<"plan-only" | "draft" | "draft-and-pr", RunLevel> = {
  "plan-only": "plan",
  draft: "draft",
  "draft-and-pr": "pr",
};

const stamp = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/** The Git host runtime.yaml names; a manual one writes its steps into the metarepo (ADR 0032). */
function gitHostOf(root: string, t: TaskContext): GitHost | undefined {
  return createAdapters(
    t.ctx.orgPack.runtime,
    {},
    { store: fileStepStore(root), root, procedures: t.ctx.orgPack.procedures },
  ).gitHost;
}

interface Ctx {
  root: string;
  t: TaskContext;
  record: TaskRunRecord;
  worktree: string;
  runtime: AiRuntime;
  commands: CommandRunner;
  git: GitRunner;
  gitHost?: GitHost;
  approval?: Approval;
  now: () => Date;
  maxFix: number;
  /** Atticus was stopped during a build (Ctrl+C on atticus ui): the run does nothing more. */
  stopped?: boolean;
}

async function summarise(c: Ctx, run: Run) {
  await saveRunSummary(c.root, c.t.change.id, c.t.task.id, toRunSummary(run));
  if (!c.record.runs.includes(run.runId)) c.record.runs.push(run.runId);
}

/** Prepare and run one AI step; a hand-off run comes back waiting. */
async function aiStep(
  c: Ctx,
  buildLog?: { command: string; text: string; attempt: number },
): Promise<Run> {
  const level = c.record.level;
  const oneShot = c.runtime.kind !== "hand-off" && c.runtime.kind !== "headless-claude-code";
  const pack = await taskPack({
    t: c.t,
    level,
    engine: c.record.engine,
    worktree: c.worktree,
    worktreeRel: c.record.worktree,
    oneShot,
    git: c.git,
    ...(buildLog ? { buildLog } : {}),
    now: c.now(),
  });
  const request: AiRequest = {
    change: c.t.change.id,
    agent: taskRunnerAgent(c.t),
    pack,
    outputPath: `tasks/${c.t.task.id}/${level === "plan" ? "plan.md" : "report.md"}`,
  };
  const prepared = await c.runtime.prepare(request);
  // Sources the defences left out of the pack (ADR 0042) become items for a person.
  await writeQuarantineItems(
    c.root,
    c.t.change.id,
    prepared.runId,
    quarantineItems(pack.defences ?? []),
  );
  if (c.runtime instanceof HandoffRuntime) {
    // The generic hand-off prompt says "change no other files"; a task run works in its
    // worktree, so it gets its own prompt with the same completion command.
    await writeFile(
      join(runsDirOf(c.root), request.change, prepared.runId, "prompt.md"),
      handoffPrompt(c, prepared),
      "utf8",
    );
  }
  // Stopping Atticus ends the model call or the assistant's session too (headless, Copilot).
  const run = await c.runtime.run(prepared.runId, stopSignal);
  await summarise(c, run);
  return run;
}

function handoffPrompt(c: Ctx, run: Run): string {
  const out = `${changesRelOf(c.root)}/${c.t.change.id}/${run.request.outputPath}`;
  return [
    `# ${run.request.agent.id}: task ${c.t.task.id} of change ${c.t.change.id}`,
    "",
    c.record.level === "plan"
      ? `Write the plan to ${out}. Change no code.`
      : `Make the changes in ${c.record.worktree} (branch ${c.record.branch}) only, then write a short report of what you changed to ${out}.`,
    "",
    run.request.pack.prompt.trimEnd(),
    "",
    c.record.level === "pr"
      ? `When you are done, stop and ask the person to run: atticus handoff done ${run.runId} --approve (it pushes the branch and opens a PR, so the person runs it, never you)`
      : `When you are done, run: atticus handoff done ${run.runId}`,
    "",
  ].join("\n");
}

async function build(c: Ctx, runId: string, fixRun?: string): Promise<BuildAttempt | undefined> {
  const command = c.t.repo.build;
  if (!command) return undefined;
  const n = c.record.attempts.length + 1;
  const res = await c.commands(command, c.worktree);
  if (res.stopped) c.stopped = true;
  const logRel = `${runsRelOf(c.root)}/${c.t.change.id}/${runId}/build-${n}.log`;
  await mkdir(join(runsDirOf(c.root), c.t.change.id, runId), { recursive: true });
  await writeFile(
    join(c.root, logRel),
    `$ ${command}\n${res.stdout}${res.stderr ? `\n${res.stderr}` : ""}\n(exit ${res.exitCode ?? "none"})\n`,
    "utf8",
  );
  const a: BuildAttempt = {
    n,
    ...(fixRun ? { fixRun } : {}),
    command,
    exitCode: res.exitCode,
    passed: res.exitCode === 0,
    log: logRel,
    at: stamp(c.now()),
  };
  c.record.attempts.push(a);
  return a;
}

/**
 * What changed in the worktree, by `git status`: -z and quotePath=false, so a name with an
 * accent or a space is as it is, and a rename is its new name.
 */
async function changedFiles(c: Ctx): Promise<string[]> {
  const r = await c.git(["-c", "core.quotePath=false", "status", "--porcelain", "-z"], c.worktree);
  const parts = r.stdout.split("\0").filter(Boolean);
  const out: string[] = [];
  for (let k = 0; k < parts.length; k++) {
    const e = parts[k]!;
    // A rename or copy is followed by its old name: skipped.
    if (/^[RC]/.test(e)) k++;
    if (e.slice(3)) out.push(e.slice(3));
  }
  return out;
}

/** Write a one-shot answer's files into the worktree; returns problems (empty when applied). */
async function applyAnswer(c: Ctx, run: Run): Promise<string[]> {
  if (c.runtime.kind === "headless-claude-code") {
    for (const p of await changedFiles(c))
      if (!c.record.changed.includes(p)) c.record.changed.push(p);
    await writeReport(c, run.output ?? "");
    return [];
  }
  const a = parseAnswer(run.output ?? "");
  if (a.problems.length) return a.problems;
  if (a.changes.length === 0) return ["the answer changes no files"];
  for (const p of await applyChanges(c.worktree, a.changes))
    if (!c.record.changed.includes(p)) c.record.changed.push(p);
  await writeReport(c, a.report);
  return [];
}

async function writeReport(c: Ctx, text: string) {
  await writeFileAtomic(
    join(changeFolder(c.root, c.t.change.id), `tasks/${c.t.task.id}/report.md`),
    `# Task ${c.t.task.id}: ${c.t.task.title}\n\n${text.trim() || "No report was given."}\n`,
  );
}

/** Build, and fix with the AI until it passes or the fix rounds are used up. */
async function buildAndFix(c: Ctx, runId: string): Promise<void> {
  let a = await build(c, runId);
  if (!a) {
    c.record.notes.push(
      `${c.t.repo.id} has no build command in repos.manifest.yaml, so the change wasn't built or tested.`,
    );
    c.record.state = "unverified";
    return;
  }
  let fixes = 0;
  const halted = () => c.stopped || stopRequested();
  while (!a.passed && !halted() && fixes < c.maxFix && c.runtime.kind !== "hand-off") {
    fixes++;
    const log = await import("node:fs/promises").then((fs) =>
      fs.readFile(join(c.root, a!.log), "utf8"),
    );
    const fix = await aiStep(c, { command: a.command, text: log, attempt: fixes });
    if (fix.state !== "validated") {
      c.record.notes.push(`Fix round ${fixes} failed: ${fix.errors.join("; ") || fix.state}.`);
      break;
    }
    // Stopped while the model answered: its files aren't written.
    if (halted()) break;
    const problems = await applyAnswer(c, fix);
    if (problems.length) {
      c.record.notes.push(`Fix round ${fixes} was not applied: ${problems.join("; ")}.`);
      break;
    }
    a = (await build(c, runId, fix.runId))!;
  }
  if (halted()) {
    c.record.state = "needs-person";
    c.record.notes.push(
      `Atticus was stopped while the build ran, so nothing more was done; a person takes over in ${c.record.worktree}. See ${a.log}.`,
    );
    return;
  }
  if (!a.passed) {
    c.record.state = "needs-person";
    c.record.notes.push(
      `The build still fails after ${fixes} fix round${fixes === 1 ? "" : "s"}; a person takes over in ${c.record.worktree}. See ${a.log}.`,
    );
    return;
  }
  c.record.state = "built";
}

async function commit(c: Ctx, runId: string): Promise<void> {
  await c.git(["add", "-A", "--", "."], c.worktree);
  const staged = (await c.git(["diff", "--cached", "--name-only"], c.worktree)).stdout.trim();
  if (!staged) {
    c.record.notes.push("Nothing to commit.");
    return;
  }
  await c.git(
    [
      "commit",
      "-q",
      "-m",
      `${c.t.task.title} (task ${c.t.task.id} of ${c.t.change.id})`,
      "-m",
      `Atticus-Change: ${c.t.change.id}\nAtticus-Task: ${c.t.task.id}\nAtticus-Run: ${runId}\nRequested-By: ${c.record.by}`,
    ],
    c.worktree,
  );
  c.record.commit = (await c.git(["rev-parse", "HEAD"], c.worktree)).stdout.trim();
}

async function openPr(c: Ctx): Promise<void> {
  if (c.record.state !== "built") {
    c.record.notes.push(
      c.record.state === "unverified"
        ? "No PR: a pull request needs a passing build, and this repo has no build command."
        : "No PR: the build doesn't pass.",
    );
    if (c.record.state === "unverified") c.record.state = "needs-person";
    return;
  }
  const approval = requireApproval("git-host", c.approval);
  if (!c.gitHost) {
    c.record.state = "needs-person";
    c.record.notes.push(
      `No Git host is connected (runtime.yaml adapters.gitHost): push ${c.record.branch} and open the PR into ${changeBranch(c.t.change.id)} by hand, then record it.`,
    );
    return;
  }
  const base = changeBranch(c.t.change.id);
  // Review round 42: the PR's body says the build passed, so what is pushed is the commit it
  // passed at. A branch that moved on since is refused rather than pushed at record.commit,
  // which would leave the branch here and the one on the host saying different things.
  if (c.record.commit) {
    const head = (
      await c
        .git(["rev-parse", "--verify", "-q", `refs/heads/${c.record.branch}`], c.worktree)
        .catch(() => ({ stdout: "" }))
    ).stdout.trim();
    if (!head)
      throw new TaskRunError(
        "refused",
        `Task ${c.t.task.id}'s branch ${c.record.branch} isn't in ${c.record.worktree} any more: run the task again.`,
      );
    if (head !== c.record.commit)
      throw new TaskRunError(
        "refused",
        `Task ${c.t.task.id}'s branch ${c.record.branch} has commits that weren't built (it is at ${head.slice(0, 12)}; the build passed at ${c.record.commit.slice(0, 12)}): run the task again so its build checks them, or push ${c.record.branch} and open its PR into ${base} yourself.`,
      );
  }
  try {
    const info = await c.gitHost.getRepo(c.t.repo.id);
    for (const b of [c.record.branch, base])
      if (info.protectedBranches.includes(b))
        throw new TaskRunError(
          "refused",
          `${b} is protected in ${c.t.repo.id}; Run with AI never pushes to or opens a PR into a protected branch.`,
        );
    if (base === info.defaultBranch)
      throw new TaskRunError(
        "refused",
        `${base} is ${c.t.repo.id}'s default branch; task PRs go into the change branch.`,
      );
    // The approval covers this push. The change branch is pushed only when the host hasn't got
    // it (so the PR has a base): once there, it moves by merged PRs on the host, and this
    // worktree's copy, behind them, is never pushed over it. Both refs go together or not at all.
    const onHost = (
      await c.git(["ls-remote", "--heads", "origin", `refs/heads/${base}`], c.worktree)
    ).stdout.trim();
    const refs = [`refs/heads/${c.record.branch}:refs/heads/${c.record.branch}`];
    if (!onHost) refs.unshift(`refs/heads/${base}:refs/heads/${base}`);
    await c.git(
      ["push", "-q", ...(refs.length > 1 ? ["--atomic"] : []), "origin", ...refs],
      c.worktree,
    );
    const pr = await c.gitHost.createPullRequest(
      {
        repo: c.t.repo.id,
        head: c.record.branch,
        base,
        title: `${c.t.task.title} (task ${c.t.task.id} of ${c.t.change.id})`,
        body: [
          `Task ${c.t.task.id} of change ${c.t.change.id}, drafted with Run with AI (${c.record.runtime}) and requested by ${c.record.by}.`,
          "",
          `Build: ${c.record.attempts.at(-1)?.command ?? "none"} passed after ${c.record.attempts.length} attempt${c.record.attempts.length === 1 ? "" : "s"}.`,
          `Files: ${c.record.changed.join(", ") || "none"}.`,
          "",
          "A person reviews and merges this PR; Atticus never merges or deploys.",
        ].join("\n"),
      },
      approval,
    );
    c.record.pr = { number: pr.number, url: pr.url };
    c.record.state = "pr-open";
  } catch (e) {
    // A protected branch is the rule's refusal, said as it is.
    if (e instanceof TaskRunError) throw e;
    // A push or a PR that fails (the proxy, the host, a hook) leaves the build as it stands:
    // the task stays built, so the person raises its PR again once that is fixed.
    c.record.notes.push(
      `${PR_NOT_RAISED} ${(e instanceof Error ? e.message : String(e)).replace(/\.?$/, ".")} The build still passes: fix that and raise the task's PR again (Raise the task's PR on the Task board), or push ${c.record.branch} and open its PR into ${base} yourself.`,
    );
  }
}

/**
 * How a task's note starts when its PR wasn't raised: the Task board shows that note beside
 * Raise the task's PR (packages/ui task-pr.tsx matches it).
 */
const PR_NOT_RAISED = "The PR wasn't raised:";

async function finish(c: Ctx, run: Run): Promise<TaskRunRecord> {
  // Stopped while the model answered (Ctrl+C on atticus ui): its answer isn't written.
  if (stopRequested()) {
    c.record.state = "needs-person";
    c.record.notes.push(
      c.runtime.kind === "headless-claude-code"
        ? `Atticus was stopped while Claude Code worked, so nothing more was done; the worktree ${c.record.worktree} may hold some of its edits.`
        : `Atticus was stopped before the answer was applied, so nothing was written; run the task again.`,
    );
    return done(c);
  }
  if (c.record.level === "plan") {
    if (c.runtime.kind !== "hand-off")
      await writeFileAtomic(
        join(changeFolder(c.root, c.t.change.id), run.request.outputPath),
        `${(run.output ?? "").trim()}\n`,
      );
    c.record.state = "planned";
  } else {
    if (c.runtime.kind !== "hand-off") {
      const problems = await applyAnswer(c, run);
      if (problems.length) {
        c.record.state = "failed";
        c.record.notes.push(`The answer was not applied: ${problems.join("; ")}.`);
        return done(c);
      }
    }
    await buildAndFix(c, run.runId);
    await afterBuild(c, run.runId, c.record.state === "built" || c.record.state === "unverified");
  }
  return done(c);
}

/**
 * Commit, check against the design, and at the pr level push and open the PR. A failure here (a
 * pre-commit hook, commit signing with no agent, a push the proxy refuses, a protected branch)
 * is recorded for a person with what it said, and the run ends: never a run left waiting on a
 * hand-off that is already validated, which no Done, Cancel or new run could then move.
 */
async function afterBuild(
  c: Ctx,
  runId: string,
  commitIt: boolean,
  first?: () => Promise<void>,
): Promise<void> {
  try {
    await first?.();
    if (commitIt) await commit(c, runId);
    // ADR 0114: a passing build is checked against the design before anything goes further.
    await conformAfterBuild(c);
    if (c.record.level === "pr") await openPr(c);
  } catch (e) {
    c.record.state = "needs-person";
    c.record.notes.push(
      `${e instanceof Error ? e.message : String(e)} — the work is in ${c.record.worktree} (branch ${c.record.branch}): finish it there by hand, or fix that and run the task again.`,
    );
  }
}

async function done(c: Ctx): Promise<TaskRunRecord> {
  delete c.record.waiting;
  c.record.finishedAt = stamp(c.now());
  return saveTaskRun(c.root, c.record);
}

/**
 * The level a run takes: the one asked for, refused past the repo's cap; else runtime.yaml's
 * default, lowered to the repo's cap (a repo capped at plan-only plans, it isn't refused).
 */
function levelOf(t: TaskContext, asked: RunLevel | undefined): RunLevel {
  const rt = t.ctx.orgPack.runtime;
  const cap = rt.autonomy.capPerRepo[t.repo.id];
  const capped = cap ? AUTONOMY[cap] : undefined;
  if (asked === undefined) {
    const level = AUTONOMY[rt.autonomy.default];
    return capped && LEVEL_RANK[level] > LEVEL_RANK[capped] ? capped : level;
  }
  if (capped && LEVEL_RANK[asked] > LEVEL_RANK[capped])
    throw new TaskRunError(
      "refused",
      `${t.repo.id} allows Run with AI up to ${cap} (runtime.yaml autonomy.capPerRepo); ask for a lower level.`,
    );
  return asked;
}

/**
 * Refused while a run of this task waits on the person's assistant (and wasn't cancelled), or
 * while its PR is open: a new run would write over the record that names the PR, and its raise
 * would then collide with it. A PR the Git host says is merged or closed no longer holds the
 * task; the new run notes what became of it.
 */
async function refuseIfHeld(
  root: string,
  t: TaskContext,
  host: () => GitHost | undefined,
): Promise<string[]> {
  const before = await readTaskRun(root, t.change.id, t.task.id);
  if (before?.state === "pr-open") {
    let state: string | undefined;
    let why = "";
    try {
      const h = host();
      if (!h) why = "no Git host is connected (runtime.yaml adapters.gitHost)";
      else if (before.pr) state = (await h.getPullRequest(t.repo.id, before.pr.number)).state;
    } catch (e) {
      why = e instanceof Error ? e.message : String(e);
    }
    if (before.pr && (state === "merged" || state === "closed"))
      return [`Its earlier PR ${before.pr.url} is ${state}.`];
    throw new TaskRunError(
      "refused",
      `Task ${t.task.id}'s PR is open (${before.pr?.url ?? "see its run"}): running the task again would start over beside it. Merge or close the PR first, then run the task again.${why ? ` (Atticus couldn't ask the Git host whether it still is: ${why}.)` : ""}`,
    );
  }
  // Its hand-off run still open on this machine. One cancelled, validated (an earlier Atticus
  // left the record waiting), or not here at all (.runs is this machine's: a teammate's pull,
  // git clean, pruned after 30 days) no longer holds the task.
  const open = ["prepared", "waiting", "produced", "failed"];
  if (
    before?.state === "waiting" &&
    before.waiting &&
    open.includes((await handoffRunState(root, t.change.id, before.waiting)) ?? "")
  )
    throw new TaskRunError(
      "refused",
      `Task ${t.task.id} already waits on your assistant (run ${before.waiting}, in ${before.worktree}): finish it with Done on its run page (Model runs) or atticus handoff done ${before.waiting}, or Cancel it there and run the task again.`,
    );
  return [];
}

/** Whether a Git host is there to push to: one that can't be made (no adapter installed) isn't. */
function gitHostConnected(root: string, t: TaskContext, given?: GitHost): boolean {
  try {
    return !!(given ?? gitHostOf(root, t));
  } catch {
    return false;
  }
}

/** What a task run would do, with every check it would make first, and nothing done. */
export interface TaskRunPreview {
  change: string;
  task: string;
  repo: string;
  level: RunLevel;
  branch: string;
  /** For the pr level: whether a Git host is connected to push and open the PR. */
  gitHost: boolean;
}

/** `atticus task run --dry-run`: the task, its level (runtime.yaml's default when none is asked), the cap. */
export async function previewTaskRun(
  root: string,
  changeId: string,
  taskId: string,
  o: { level?: RunLevel; gitHost?: GitHost; skipGitHost?: boolean } = {},
): Promise<TaskRunPreview> {
  const t = await loadTask(root, changeId, taskId);
  const level = levelOf(t, o.level);
  await refuseIfHeld(root, t, () => o.gitHost ?? (o.skipGitHost ? undefined : gitHostOf(root, t)));
  return {
    change: t.change.id,
    task: t.task.id,
    repo: t.repo.id,
    level,
    branch: taskBranch(t.change.id, t.task.id),
    gitHost: level === "pr" && !o.skipGitHost ? gitHostConnected(root, t, o.gitHost) : false,
  };
}

/**
 * The person cancelled the hand-off run a task run waits on (the app's Cancel): the task run
 * ends with nothing more done, so the task can run again. Undefined when no task run waits on it.
 */
export async function cancelTaskRunWait(
  root: string,
  runId: string,
  o: {
    by: string;
    now?: () => Date;
    /** Marks the run itself cancelled: under the task's lock, so a Done running now is refused first. */
    cancelRun?: () => Promise<void>;
  },
): Promise<TaskRunRecord | undefined> {
  const r = await findWaitingTaskRun(root, runId);
  if (!r) {
    await o.cancelRun?.();
    return undefined;
  }
  const lock = await holdTask(root, r.change, r.task);
  try {
    const cur = await findWaitingTaskRun(root, runId);
    await o.cancelRun?.();
    if (!cur) return undefined;
    delete cur.waiting;
    cur.state = "failed";
    cur.notes.push(
      `Run ${runId} was cancelled by ${o.by}, so nothing more was done; run the task again.`,
    );
    cur.finishedAt = stamp((o.now ?? (() => new Date()))());
    return await saveTaskRun(root, cur);
  } finally {
    await lock.release();
  }
}

/** A hand-off run's state as run.json has it (cancelled in the app frees its task for a new run). */
async function handoffRunState(root: string, change: string, runId: string) {
  const text = await import("node:fs/promises").then((fs) =>
    fs.readFile(join(runsDirOf(root), change, runId, "run.json"), "utf8").catch(() => undefined),
  );
  if (!text) return undefined;
  try {
    return (JSON.parse(text) as { state?: string }).state;
  } catch {
    return undefined;
  }
}

/** One run of a task at a time, here or in another window (two builds in one worktree collide). */
async function holdTask(root: string, change: string, task: string) {
  try {
    // A run longer than half a day is one cut short whose PID Windows handed on.
    return await acquireLock(
      root,
      `task-run-${change}-${task}`,
      `run of task ${task} of ${change}`,
      undefined,
      { maxAgeMs: 12 * 60 * 60_000 },
    );
  } catch (e) {
    if (e instanceof LockHeldError) throw new TaskRunError("refused", e.message);
    throw e;
  }
}

export async function runTask(
  root: string,
  changeId: string,
  taskId: string,
  o: RunTaskOptions,
): Promise<TaskRunRecord> {
  const lock = await holdTask(root, changeId, taskId);
  // A stop (Ctrl+C, the editor gone) during the model call or a build reaches the run, which
  // records itself for a person before Atticus ends.
  const release = holdSignals();
  try {
    return await runTaskHeld(root, changeId, taskId, o);
  } finally {
    // The lock first: letting go of the stop may end Atticus by the signal there and then.
    await lock.release();
    release();
  }
}

async function runTaskHeld(
  root: string,
  changeId: string,
  taskId: string,
  o: RunTaskOptions,
): Promise<TaskRunRecord> {
  const now = o.now ?? (() => new Date());
  const git = o.git ?? createGit();
  let t = await loadTask(root, changeId, taskId);
  const rt = t.ctx.orgPack.runtime;
  const level = levelOf(t, o.level);
  // A run of this task still waits on the person's assistant: a second one would write over
  // its record, and its Done would then find nothing to build.
  const earlier = await refuseIfHeld(root, t, () => o.gitHost ?? gitHostOf(root, t));
  if (level === "pr") {
    try {
      requireApproval("git-host", o.approval);
    } catch {
      throw new TaskRunError(
        "refused",
        "The pr level pushes the task branch and opens a PR, which needs the person's yes: ask them to run it with --approve (an assistant never approves a push).",
      );
    }
  }
  const engine = buildEngineFor(t.ctx.orgPack, t.repo.id);
  // Hand the task down first if nobody has: the run works from the handed-down feature.
  const changeDir = await changeWorktree(root, t.change.id, t.repo.id);
  const handed =
    engine === "speckit" ? `specs/${t.task.id}/plan.md` : `.atticus/tasks/${t.task.id}.md`;
  const notes: string[] = [...earlier];
  if (!existsSync(join(changeDir, handed))) {
    const h = await handDown(root, t.change.id, t.task.id, { git });
    notes.push(
      `Handed the task down first (${h.feature} in ${h.repo}${h.commit ? `, commit ${h.commit.slice(0, 12)}` : ""}).`,
    );
    t = await loadTask(root, changeId, taskId);
  }
  const wt = await openTaskWorktree(root, t.change.id, t.task.id, t.repo.id, git);
  const runtime =
    o.runtime ??
    (await createRuntime(t.ctx.orgPack, {
      root,
      ...(o.mode ? { mode: o.mode } : {}),
      ...(o.replayDir ? { replayDir: o.replayDir } : {}),
      now,
      ...o.runtimeOptions,
      headless: {
        ...o.runtimeOptions?.headless,
        invocation: () => ({
          cwd: wt.path,
          permissionMode: level === "plan" ? "plan" : "acceptEdits",
          ...(engine === "speckit"
            ? { env: { SPECIFY_FEATURE_DIRECTORY: `specs/${t.task.id}` } }
            : {}),
        }),
      },
    }));
  let gitHost = o.gitHost;
  if (!gitHost && level === "pr") gitHost = gitHostOf(root, t);
  const record: TaskRunRecord = {
    schemaVersion: 1,
    change: t.change.id,
    task: t.task.id,
    repo: t.repo.id,
    level,
    runtime: runtime.kind,
    engine,
    by: o.by,
    branch: wt.branch,
    worktree: toRepoRelative(root, wt.path),
    state: "failed",
    runs: [],
    attempts: [],
    changed: [],
    startedAt: stamp(now()),
    notes,
  };
  const c: Ctx = {
    root,
    t,
    record,
    worktree: wt.path,
    runtime,
    commands: o.commands ?? shellCommandRunner(),
    git,
    ...(gitHost ? { gitHost } : {}),
    ...(o.approval ? { approval: o.approval } : {}),
    now,
    maxFix: rt.autonomy.maxFixRounds,
  };
  const run = await aiStep(c);
  if (run.state === "waiting") {
    record.state = "waiting";
    record.waiting = run.runId;
    return saveTaskRun(root, record);
  }
  // A run ended by the stop is said as stopped (finish), not as a failed AI run.
  if (run.state !== "validated" && !stopRequested()) {
    record.notes.push(
      `The AI run ended ${run.state}: ${run.errors.join("; ") || "no reason given"}.`,
    );
    return done(c);
  }
  return finish(c, run);
}

/**
 * `atticus handoff done <run>` for a task run: check the person's assistant's work (the plan
 * file, or the build in the task worktree), then commit and open the PR as the level says. A
 * failing build sends the run back to waiting, up to the fix rounds, then a person takes over.
 */
export async function completeTaskHandoff(
  root: string,
  runId: string,
  o: Omit<RunTaskOptions, "level" | "mode" | "by" | "runtime" | "runtimeOptions"> = {},
): Promise<TaskRunRecord> {
  const waiting = await findWaitingTaskRun(root, runId);
  if (!waiting) throw new TaskRunError("not-found", `No task run is waiting on ${runId}.`);
  // The pr level pushes and opens a PR: without the person's yes, nothing is checked or built,
  // so the run still waits and the same Done with --approve finishes it.
  if (waiting.level === "pr" && !o.approval)
    throw new TaskRunError(
      "refused",
      `Task ${waiting.task} runs at the pr level, which pushes ${waiting.branch} and opens a PR: ask the person to run atticus handoff done ${runId} --approve (an assistant never approves a push).`,
    );
  const lock = await holdTask(root, waiting.change, waiting.task);
  const release = holdSignals();
  try {
    // Not on this machine (.runs is kept per machine): said so, never "no run".
    const state = await handoffRunState(root, waiting.change, runId);
    if (state === undefined)
      throw new TaskRunError(
        "refused",
        `Run ${runId} isn't on this machine (its files are kept where it was started): run the task again here (atticus task run ${waiting.change} ${waiting.task}).`,
      );
    // Cancelled in the app meanwhile: said so, never a transition error.
    if (state === "cancelled")
      throw new TaskRunError(
        "refused",
        `Run ${runId} was cancelled; run the task again (atticus task run ${waiting.change} ${waiting.task}).`,
      );
    // Read again under the lock: another Done may have finished it meanwhile.
    const record = await findWaitingTaskRun(root, runId);
    if (!record) throw new TaskRunError("not-found", `No task run is waiting on ${runId}.`);
    return await completeHeld(root, runId, record, o);
  } finally {
    // The lock first: letting go of the stop may end Atticus by the signal there and then.
    await lock.release();
    release();
  }
}

async function completeHeld(
  root: string,
  runId: string,
  record: TaskRunRecord,
  o: Omit<RunTaskOptions, "level" | "mode" | "by" | "runtime" | "runtimeOptions">,
): Promise<TaskRunRecord> {
  const now = o.now ?? (() => new Date());
  const git = o.git ?? createGit();
  const t = await loadTask(root, record.change, record.task);
  const rt = t.ctx.orgPack.runtime;
  const commands = o.commands ?? shellCommandRunner();
  let gitHost = o.gitHost;
  if (!gitHost && record.level === "pr") gitHost = gitHostOf(root, t);
  const c: Ctx = {
    root,
    t,
    record,
    worktree: join(root, record.worktree),
    runtime: undefined as unknown as AiRuntime,
    commands,
    git,
    ...(gitHost ? { gitHost } : {}),
    ...(o.approval ? { approval: o.approval } : {}),
    now,
    maxFix: rt.autonomy.maxFixRounds,
  };
  let attempt: BuildAttempt | undefined;
  const handoff = new HandoffRuntime({
    root,
    now,
    validate: async (file) => {
      const text = await import("node:fs/promises").then((fs) => fs.readFile(file, "utf8"));
      if (!text.trim()) return [`${file.slice(root.length + 1)} is empty`];
      if (record.level === "plan") return [];
      // Stopping (Ctrl+C on atticus ui): no build starts, and none that ends counts.
      if (stopRequested()) return ["Atticus was stopped"];
      attempt = await build(c, runId);
      if (c.stopped) return ["Atticus was stopped while the build ran"];
      if (!attempt) return [];
      return attempt.passed ? [] : [`${attempt.command} failed; see ${attempt.log}`];
    },
  });
  c.runtime = handoff;
  const run = await handoff.done(runId);
  await summarise(c, run);
  if (run.state === "validated") {
    if (record.level === "plan") record.state = "planned";
    else {
      record.state = attempt ? "built" : "unverified";
      if (!attempt)
        record.notes.push(
          `${t.repo.id} has no build command in repos.manifest.yaml, so the change wasn't built or tested.`,
        );
      await afterBuild(c, runId, true, async () => {
        for (const p of await changedFiles(c))
          if (!record.changed.includes(p)) record.changed.push(p);
      });
    }
    return done(c);
  }
  if (c.stopped || stopRequested()) {
    // Not a failed attempt: nothing is used up, and the person runs atticus handoff done again.
    if (c.stopped && record.attempts.at(-1)?.passed === false) record.attempts.pop();
    record.state = "waiting";
    record.waiting = runId;
    await handoff.retry(runId);
    await handoff.run(runId);
    record.notes.push(
      `Atticus was stopped while it checked the work, so nothing more was done; run atticus handoff done ${runId} again.`,
    );
    return saveTaskRun(root, record);
  }
  if (!attempt) {
    // No build ran: the answer file is missing or empty (the report not written yet). Nothing is
    // used up; the run waits for the file and the same Done.
    record.state = "waiting";
    record.waiting = runId;
    await handoff.retry(runId);
    await handoff.run(runId);
    record.notes.push(
      `${run.errors.join("; ") || "The answer isn't there yet"}: write it, then run atticus handoff done ${runId} again.`,
    );
    return saveTaskRun(root, record);
  }
  const builds = record.attempts.length;
  if (attempt && !attempt.passed && builds <= c.maxFix) {
    // Back to the assistant: same run, next attempt.
    await handoff.retry(runId);
    await handoff.run(runId);
    record.notes.push(
      `Build attempt ${builds} failed; the run is waiting for a fix (${run.errors.join("; ")}).`,
    );
    return saveTaskRun(root, record);
  }
  record.state = attempt && !attempt.passed ? "needs-person" : "failed";
  record.notes.push(
    attempt && !attempt.passed
      ? `The build still fails after ${builds} attempts; a person takes over in ${record.worktree}.`
      : `The hand-off failed: ${run.errors.join("; ")}.`,
  );
  return done(c);
}

/**
 * Sixth UX walk: the PR of a task drafted at the draft level (built and committed on its task
 * branch), on the person's yes: the same push and PR the pr level makes after its build, without
 * running the AI step again. Refused, with nothing changed, for a task with no passing build, one
 * whose PR is open, one whose branch has commits the build didn't check, and without the approval
 * or a Git host. A push or PR that fails leaves it built with a note, so it is raised again.
 */
export async function raiseTaskPr(
  root: string,
  changeId: string,
  taskId: string,
  o: { approval: Approval; git?: GitRunner; gitHost?: GitHost; now?: () => Date },
): Promise<TaskRunRecord> {
  try {
    requireApproval("git-host", o.approval);
  } catch {
    throw new TaskRunError(
      "refused",
      "A task's PR pushes its branch and opens a PR, which needs the person's yes (an assistant never approves a push).",
    );
  }
  const lock = await holdTask(root, changeId, taskId);
  try {
    const record = await readTaskRun(root, changeId, taskId);
    if (!record || record.level === "plan" || ["planned", "failed"].includes(record.state))
      throw new TaskRunError(
        "refused",
        `Task ${taskId} hasn't been drafted yet: run it with AI first; its PR comes after the draft.`,
      );
    if (record.state === "pr-open")
      throw new TaskRunError(
        "refused",
        `Task ${taskId}'s PR is already open: ${record.pr?.url ?? "see its run"}.`,
      );
    if (record.state === "waiting")
      throw new TaskRunError(
        "refused",
        `Task ${taskId} still waits on your assistant (run ${record.waiting ?? "on its page"}): finish it with Done first; its PR comes after the build.`,
      );
    const change = changeBranch(changeId);
    if (record.state === "unverified")
      throw new TaskRunError(
        "refused",
        `Atticus opens a task's PR only after a passing build, and ${record.repo} has no build command in repos.manifest.yaml: add one and run task ${taskId} again, or push ${record.branch} and open its PR into ${change} yourself.`,
      );
    if (record.state !== "built" || !record.commit)
      throw new TaskRunError(
        "refused",
        `Task ${taskId} has no passing build to raise (it is ${record.state}): see its run's notes, then run it again.`,
      );
    const t = await loadTask(root, changeId, taskId);
    const gitHost = o.gitHost ?? gitHostOf(root, t);
    if (!gitHost)
      throw new TaskRunError(
        "refused",
        `No Git host is connected (runtime.yaml adapters.gitHost): push ${record.branch} and open its PR into ${change} yourself.`,
      );
    const now = o.now ?? (() => new Date());
    const c: Ctx = {
      root,
      t,
      record,
      worktree: join(root, record.worktree),
      runtime: undefined as unknown as AiRuntime,
      commands: shellCommandRunner(),
      git: o.git ?? createGit(),
      gitHost,
      approval: o.approval,
      now,
      maxFix: t.ctx.orgPack.runtime.autonomy.maxFixRounds,
    };
    // A refusal (a protected branch, commits the build didn't check) changes nothing; a push or
    // PR that fails is noted and the task stays built, so it can be raised again.
    await openPr(c);
    // openPr moves the state on (TypeScript still reads it as built here).
    if ((record.state as string) === "pr-open")
      record.notes.push(`PR raised by ${o.approval.by} after the draft (${o.approval.ref}).`);
    return await done(c);
  } finally {
    await lock.release();
  }
}

/** Whether a run id belongs to a waiting task run (the lead routes `atticus handoff done` with it). */
export async function isTaskRun(root: string, runId: string): Promise<boolean> {
  return (await findWaitingTaskRun(root, runId)) !== undefined;
}

export { readTaskRun };
