import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { changeBranch, RecordId, taskBranch } from "@maycombhq/core";
import { baseClonePath, changeWorktreesDir, createGit, type GitRunner } from "@maycombhq/workspace";
import { SpecKitError } from "./change.js";

/**
 * Task worktrees (ADR 0009 branches): an AI task run works on `task/<change-id>/<task-id>`,
 * cut from the change branch, in its own worktree next to the change's, so a run never
 * touches the change worktree a person may be using. The task branch is merged into the
 * change branch by PR.
 *
 *   workspace/.worktrees/<change>/.tasks/<task>/<repo>/
 */
export function taskWorktreePath(root: string, change: string, task: string, repo: string): string {
  for (const [what, v] of [
    ["task id", task],
    ["repo id", repo],
  ] as const)
    if (!RecordId.safeParse(v).success)
      throw new SpecKitError("invalid", `${what} "${v}" must be a lowercase slug`);
  return join(changeWorktreesDir(root, change), ".tasks", task, repo);
}

/**
 * Seventh UX walk (tasks and manual steps): before a task's branch is cut, the local change branch
 * catches up with the change branch on the Git host, where the change's earlier tasks merged by
 * PR, so the new task starts from their code. Fetched from origin; when the host has commits the
 * local branch hasn't and the local branch has none of its own, it fast-forwards (in the change
 * worktree, where it is checked out). One with commits of its own while the host's has moved on
 * is never rewritten: refused, saying what to do. A host that isn't there or can't be reached,
 * or a task branch already cut, leaves the local branch as it is. Returns a note when it moved.
 */
export async function catchUpChangeBranch(
  root: string,
  change: string,
  task: string,
  repo: string,
  changeDir: string,
  git: GitRunner = createGit(),
): Promise<string | undefined> {
  const base = baseClonePath(root, repo);
  if (!existsSync(base)) return undefined;
  const from = changeBranch(change);
  const rev = (ref: string) =>
    git(["rev-parse", "--verify", "--quiet", ref], base).then(
      (r) => r.stdout.trim() || undefined,
      () => undefined,
    );
  if (await rev(`refs/heads/${taskBranch(change, task)}`)) return undefined;
  const local = await rev(`refs/heads/${from}`);
  if (!local) return undefined;
  const onHost = await git(["ls-remote", "--heads", "origin", `refs/heads/${from}`], base).then(
    (r) => r.stdout.trim(),
    () => "",
  );
  if (!onHost) return undefined;
  const fetched = await git(
    ["fetch", "-q", "origin", `+refs/heads/${from}:refs/remotes/origin/${from}`],
    base,
  ).then(
    () => true,
    () => false,
  );
  const remote = fetched ? await rev(`refs/remotes/origin/${from}`) : undefined;
  if (!remote || remote === local) return undefined;
  const ancestor = (a: string, b: string) =>
    git(["merge-base", "--is-ancestor", a, b], base).then(
      () => true,
      () => false,
    );
  // The host's is behind or the same: the local commits go up with the task's PR.
  if (await ancestor(remote, local)) return undefined;
  const rel = changeDir.slice(root.length + 1).replace(/\\/g, "/");
  if (!(await ancestor(local, remote)))
    throw new SpecKitError(
      "refused",
      `${from} in ${repo} has commits the Git host's hasn't, and the host's has commits it hasn't (tasks merged there): Atticus doesn't rewrite it. Merge origin/${from} into it in ${rel} (or push it), then run task ${task} again.`,
    );
  try {
    await git(["merge", "-q", "--ff-only", remote], changeDir);
  } catch (e) {
    throw new SpecKitError(
      "refused",
      `${from} in ${repo} is behind the Git host's (tasks merged there), and it can't fast-forward in ${rel}: ${(e instanceof Error ? e.message : String(e)).trim()}. Commit or put aside the edits there, then run task ${task} again.`,
    );
  }
  return `Brought ${from} in ${repo} up to the Git host's first (the tasks merged into it there).`;
}

export async function openTaskWorktree(
  root: string,
  change: string,
  task: string,
  repo: string,
  git: GitRunner = createGit(),
): Promise<{ path: string; branch: string; created: boolean }> {
  const path = taskWorktreePath(root, change, task, repo);
  const branch = taskBranch(change, task);
  if (existsSync(path)) return { path, branch, created: false };
  const base = baseClonePath(root, repo);
  if (!existsSync(base))
    throw new SpecKitError(
      "refused",
      `There is no base clone of ${repo}; run atticus workspace sync first.`,
    );
  const ok = async (ref: string) =>
    git(["rev-parse", "--verify", "--quiet", ref], base).then(
      () => true,
      () => false,
    );
  await mkdir(dirname(path), { recursive: true });
  if (await ok(`refs/heads/${branch}`)) await git(["worktree", "add", "--", path, branch], base);
  else {
    const from = changeBranch(change);
    if (!(await ok(`refs/heads/${from}`)))
      throw new SpecKitError(
        "refused",
        `${repo} has no ${from} branch yet. Open the change first: atticus workspace open ${change} --repos ${repo}`,
      );
    await git(["worktree", "add", "--no-track", "-b", branch, "--", path, from], base);
  }
  return { path, branch, created: true };
}
