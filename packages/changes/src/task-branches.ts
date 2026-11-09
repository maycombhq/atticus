import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { changeBranch, taskBranch, toCanonicalYaml, type ChangeRepo } from "@maycombhq/core";
import { baseClonePath, createGit, readChangeRepos, type GitRunner } from "@maycombhq/workspace";
import { ChangeError, type Reason } from "./errors.js";
import { changeFolder, writeFileAtomic } from "./store.js";

/**
 * App-only audit (tasks, release): a change is never released without its tasks' code. A task's
 * work reaches the change branch `change/<id>` by its PR (ADR 0036); until it has, the task branch
 * `task/<id>/<task>` holds commits the change branch hasn't, here or on the Git host. While any
 * task branch does, Build ready, go/no-go and the release PRs are held, naming the task and what
 * to do. A person may decide a task's work isn't needed (`decision.yaml`, with a reason): that
 * holds while the branch is where they decided it, and no longer once it moves on.
 *
 * Reads only: refs here, `ls-remote` and a fetch of the change branch into its remote-tracking ref
 * when the host's commit isn't known here. A host that can't be reached is judged by the branch
 * here.
 */

export const TASK_DECISION_FILE = "decision.yaml";

const TaskDecision = z.strictObject({
  schemaVersion: z.literal(1),
  task: z.string().min(1),
  branch: z.string().min(1),
  /** The task branch's commit the person decided over. */
  commit: z.string().regex(/^[0-9a-f]{7,64}$/),
  by: z.string().min(1),
  at: z.string().min(1),
  reason: z.string().min(1),
});
export type TaskDecision = z.infer<typeof TaskDecision>;

/** A task branch with commits the change branch hasn't. */
export interface UnmergedTask {
  task: string;
  repo: string;
  branch: string;
  /** Its commits in neither the change branch here nor the Git host's. */
  commits: number;
  /** Where its last task run stands (task-run.yaml), when it ran. */
  state?: string;
  pr?: { number: number; url: string };
}

interface TaskRef {
  task: string;
  repo?: string;
  branch: string;
  state?: string;
  pr?: { number: number; url: string };
  /** Atticus saw its PR merged on the Git host (a squash merge leaves its commits apart). */
  ticked?: boolean;
}

/** The task runs of a change, read loosely (the task-run.yaml schema is the taskrun package's). */
async function taskRefs(root: string, id: string): Promise<TaskRef[]> {
  const dir = join(changeFolder(root, id), "tasks");
  const out: TaskRef[] = [];
  for (const d of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!d.isDirectory()) continue;
    const text = await readFile(join(dir, d.name, "task-run.yaml"), "utf8").catch(() => undefined);
    let y: Record<string, unknown> | undefined;
    try {
      y = text ? (parse(text) as Record<string, unknown>) : undefined;
    } catch {
      y = undefined;
    }
    const task = String(y?.task ?? d.name);
    let branch: string;
    try {
      branch = typeof y?.branch === "string" ? y.branch : taskBranch(id, task);
    } catch {
      continue;
    }
    const pr = y?.pr as { number?: unknown; url?: unknown } | undefined;
    out.push({
      task,
      ...(typeof y?.repo === "string" ? { repo: y.repo } : {}),
      branch,
      ...(typeof y?.state === "string" ? { state: y.state } : {}),
      ...(pr && typeof pr.number === "number" && typeof pr.url === "string"
        ? { pr: { number: pr.number, url: pr.url } }
        : {}),
      ...(y?.ticked ? { ticked: true } : {}),
    });
  }
  return out;
}

/** The folder to read a change repo's refs in: its worktree, else its base clone. */
function repoDir(root: string, r: Pick<ChangeRepo, "id" | "worktree">): string | undefined {
  const dirs = [join(root, r.worktree)];
  try {
    dirs.push(baseClonePath(root, r.id));
  } catch {
    // not a repo id a base clone can have
  }
  return dirs.find((d) => existsSync(d));
}

export async function readTaskDecision(
  root: string,
  id: string,
  task: string,
): Promise<TaskDecision | undefined> {
  const text = await readFile(
    join(changeFolder(root, id), "tasks", task, TASK_DECISION_FILE),
    "utf8",
  ).catch(() => undefined);
  if (text === undefined) return undefined;
  try {
    const r = TaskDecision.safeParse(parse(text));
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every task branch of the change with commits the change branch hasn't, here or on the Git host,
 * that no person decided to let go at its present commit. `offline` reads refs here only (the
 * Task board's quick look); otherwise the host's change branch is asked for too.
 */
export async function unmergedTaskBranches(
  root: string,
  id: string,
  o: { git?: GitRunner; remote?: string; offline?: boolean; task?: string } = {},
): Promise<UnmergedTask[]> {
  const cr = await readChangeRepos(root, id).catch(() => undefined);
  if (!cr?.repos.length) return [];
  const git = o.git ?? createGit({ timeoutMs: 30_000 });
  const remote = o.remote ?? "origin";
  const from = changeBranch(id);
  const records = await taskRefs(root, id);
  const out: UnmergedTask[] = [];
  const sha = (dir: string, ref: string) =>
    git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], dir).then(
      (x) => x.stdout.trim() || undefined,
      () => undefined,
    );
  for (const r of cr.repos) {
    const dir = repoDir(root, r);
    if (!dir) continue;
    // Task branches of this change in the repo, whether a run made them or a person did.
    const listed = await git(
      ["for-each-ref", "--format=%(refname)", `refs/heads/task/${id}/`],
      dir,
    ).then(
      (x) =>
        x.stdout
          .split(/\r?\n/)
          .map((l) => l.trim().replace(/^refs\/heads\//, ""))
          .filter(Boolean),
      () => [] as string[],
    );
    const branches = new Map<string, TaskRef>();
    for (const b of listed)
      branches.set(
        b,
        records.find((x) => x.branch === b) ?? { task: b.split("/").at(-1)!, branch: b },
      );
    for (const x of records)
      if (x.repo === r.id && !branches.has(x.branch)) branches.set(x.branch, x);
    const refs = [...branches.values()].filter(
      (x) => (!x.repo || x.repo === r.id) && (!o.task || x.task === o.task),
    );
    if (!refs.length) continue;
    const not: string[] = [];
    if (await sha(dir, `refs/heads/${from}`)) not.push(`refs/heads/${from}`);
    if (!o.offline) {
      const onHost = await git(["ls-remote", "--heads", remote, `refs/heads/${from}`], dir).then(
        (x) => x.stdout.trim().split(/\s+/)[0] || undefined,
        () => undefined,
      );
      if (onHost && !(await sha(dir, onHost)))
        await git(
          ["fetch", "-q", remote, `+refs/heads/${from}:refs/remotes/${remote}/${from}`],
          dir,
        ).catch(() => undefined);
      if (onHost && (await sha(dir, onHost))) not.push(onHost);
    } else if (await sha(dir, `refs/remotes/${remote}/${from}`))
      not.push(`refs/remotes/${remote}/${from}`);
    for (const x of refs) {
      if (x.ticked) continue;
      const tip = await sha(dir, `refs/heads/${x.branch}`);
      if (!tip) continue;
      const decided = await readTaskDecision(root, id, x.task);
      if (decided && decided.branch === x.branch && sameSha(decided.commit, tip)) continue;
      const commits = await git(
        ["rev-list", "--count", `refs/heads/${x.branch}`, ...(not.length ? ["--not", ...not] : [])],
        dir,
      ).then(
        (y) => Number(y.stdout.trim()) || 0,
        () => 0,
      );
      if (commits > 0)
        out.push({
          task: x.task,
          repo: r.id,
          branch: x.branch,
          commits,
          ...(x.state ? { state: x.state } : {}),
          ...(x.pr ? { pr: x.pr } : {}),
        });
    }
  }
  return out.sort((a, b) => (a.task < b.task ? -1 : a.task > b.task ? 1 : 0));
}

const sameSha = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);

/** What the person does about one unmerged task, in the app's words (and the CLI's). */
export function unmergedTaskWords(id: string, u: UnmergedTask): string {
  const from = changeBranch(id);
  const n = `${u.commits} commit${u.commits === 1 ? "" : "s"}`;
  const what =
    u.state === "pr-open" && u.pr
      ? `its PR #${u.pr.number} isn't merged yet: a person merges it on the Git host (${u.pr.url}), then Sync records it`
      : u.state === "unverified" || u.state === "needs-person" || u.state === "failed"
        ? `it was never built and raised: Build and raise PR on the Task board (or Run again), then merge its PR into ${from}`
        : `raise its PR (Raise the task's PR on the Task board) and merge it into ${from}`;
  return `Task ${u.task}'s branch ${u.branch} in ${u.repo} has ${n} not in ${from}, so its code isn't in the change: ${what}. If its work isn't needed, mark the task done with a reason.`;
}

/** The reasons unmerged task branches hold Build ready, go/no-go and the release PRs. */
export async function taskBranchReasons(
  root: string,
  id: string,
  o: { git?: GitRunner; remote?: string } = {},
): Promise<Reason[]> {
  return (await unmergedTaskBranches(root, id, o)).map((u) => ({
    code: "task-not-merged" as const,
    message: unmergedTaskWords(id, u),
  }));
}

/**
 * A person's decision that a task's work isn't needed in the change: recorded with their reason
 * and the task branch's commit, so it holds only while the branch is there. Refused without a
 * reason. A task with no branch, or one whose work is merged, needs no decision; it is recorded
 * anyway when asked (nothing to hold).
 */
export async function recordTaskDecision(
  root: string,
  id: string,
  task: string,
  o: { by: string; at: string; reason: string; git?: GitRunner },
): Promise<TaskDecision> {
  const reason = o.reason.trim();
  if (!reason)
    throw new ChangeError(
      "invalid",
      `Say why task ${task}'s work isn't needed in ${id}: a reason is recorded with the decision.`,
    );
  const branch = taskBranch(id, task);
  const git = o.git ?? createGit({ timeoutMs: 30_000 });
  const cr = await readChangeRepos(root, id).catch(() => undefined);
  let commit: string | undefined;
  for (const r of cr?.repos ?? []) {
    const dir = repoDir(root, r);
    if (!dir) continue;
    commit = await git(
      ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`],
      dir,
    ).then(
      (x) => x.stdout.trim() || undefined,
      () => undefined,
    );
    if (commit) break;
  }
  if (!commit)
    throw new ChangeError(
      "refused",
      `Task ${task} has no branch ${branch} here, so there is nothing to decide: mark it done.`,
    );
  const d = TaskDecision.parse({
    schemaVersion: 1,
    task,
    branch,
    commit,
    by: o.by.trim(),
    at: o.at,
    reason,
  });
  await writeFileAtomic(
    join(changeFolder(root, id), "tasks", task, TASK_DECISION_FILE),
    toCanonicalYaml(d, ["schemaVersion", "task", "branch", "commit"]),
  );
  return d;
}
