import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AdapterError,
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
import { changeBranch, changesRelOf, runsDirOf, runsRelOf } from "@maycombhq/core";
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
import { shellCommandRunner, type CommandRunner } from "./commands.js";
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
  const run = await c.runtime.run(prepared.runId);
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
    `When you are done, run: atticus handoff done ${run.runId}`,
    "",
  ].join("\n");
}

async function build(c: Ctx, runId: string, fixRun?: string): Promise<BuildAttempt | undefined> {
  const command = c.t.repo.build;
  if (!command) return undefined;
  const n = c.record.attempts.length + 1;
  const res = await c.commands(command, c.worktree);
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

/** Write a one-shot answer's files into the worktree; returns problems (empty when applied). */
async function applyAnswer(c: Ctx, run: Run): Promise<string[]> {
  if (c.runtime.kind === "headless-claude-code") {
    const changed = await c.git(["status", "--porcelain"], c.worktree);
    for (const l of changed.stdout.split("\n").filter(Boolean)) {
      const p = l.slice(3).trim();
      if (!c.record.changed.includes(p)) c.record.changed.push(p);
    }
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
  while (!a.passed && fixes < c.maxFix && c.runtime.kind !== "hand-off") {
    fixes++;
    const log = await import("node:fs/promises").then((fs) =>
      fs.readFile(join(c.root, a!.log), "utf8"),
    );
    const fix = await aiStep(c, { command: a.command, text: log, attempt: fixes });
    if (fix.state !== "validated") {
      c.record.notes.push(`Fix round ${fixes} failed: ${fix.errors.join("; ") || fix.state}.`);
      break;
    }
    const problems = await applyAnswer(c, fix);
    if (problems.length) {
      c.record.notes.push(`Fix round ${fixes} was not applied: ${problems.join("; ")}.`);
      break;
    }
    a = (await build(c, runId, fix.runId))!;
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
  // The approval covers this push: the change branch (so the PR has a base) and the task branch.
  await c.git(
    [
      "push",
      "-q",
      "origin",
      `refs/heads/${base}:refs/heads/${base}`,
      `refs/heads/${c.record.branch}:refs/heads/${c.record.branch}`,
    ],
    c.worktree,
  );
  try {
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
    if (e instanceof AdapterError) {
      c.record.state = "needs-person";
      c.record.notes.push(`The PR couldn't be opened: ${e.message}`);
      return;
    }
    throw e;
  }
}

async function finish(c: Ctx, run: Run): Promise<TaskRunRecord> {
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
    if (c.record.state === "built" || c.record.state === "unverified") await commit(c, run.runId);
    if (c.record.level === "pr") await openPr(c);
  }
  return done(c);
}

async function done(c: Ctx): Promise<TaskRunRecord> {
  delete c.record.waiting;
  c.record.finishedAt = stamp(c.now());
  return saveTaskRun(c.root, c.record);
}

export async function runTask(
  root: string,
  changeId: string,
  taskId: string,
  o: RunTaskOptions,
): Promise<TaskRunRecord> {
  const now = o.now ?? (() => new Date());
  const git = o.git ?? createGit();
  let t = await loadTask(root, changeId, taskId);
  const rt = t.ctx.orgPack.runtime;
  const level = o.level ?? AUTONOMY[rt.autonomy.default];
  const cap = rt.autonomy.capPerRepo[t.repo.id];
  if (cap && LEVEL_RANK[level] > LEVEL_RANK[AUTONOMY[cap]])
    throw new TaskRunError(
      "refused",
      `${t.repo.id} allows Run with AI up to ${cap} (runtime.yaml autonomy.capPerRepo); ask for a lower level.`,
    );
  if (level === "pr") {
    try {
      requireApproval("git-host", o.approval);
    } catch {
      throw new TaskRunError(
        "refused",
        "The pr level pushes the task branch and opens a PR, which needs your approval: run it again with --approve.",
      );
    }
  }
  const engine = buildEngineFor(t.ctx.orgPack, t.repo.id);
  // Hand the task down first if nobody has: the run works from the handed-down feature.
  const changeDir = await changeWorktree(root, t.change.id, t.repo.id);
  const handed =
    engine === "speckit" ? `specs/${t.task.id}/plan.md` : `.atticus/tasks/${t.task.id}.md`;
  const notes: string[] = [];
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
  if (run.state !== "validated") {
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
  const record = await findWaitingTaskRun(root, runId);
  if (!record) throw new TaskRunError("not-found", `No task run is waiting on ${runId}.`);
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
      attempt = await build(c, runId);
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
      const changed = await git(["status", "--porcelain"], c.worktree);
      for (const l of changed.stdout.split("\n").filter(Boolean)) {
        const p = l.slice(3).trim();
        if (!record.changed.includes(p)) record.changed.push(p);
      }
      await commit(c, runId);
      if (record.level === "pr") await openPr(c);
    }
    return done(c);
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

/** Whether a run id belongs to a waiting task run (the lead routes `atticus handoff done` with it). */
export async function isTaskRun(root: string, runId: string): Promise<boolean> {
  return (await findWaitingTaskRun(root, runId)) !== undefined;
}

export { readTaskRun };
