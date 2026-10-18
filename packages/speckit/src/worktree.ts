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
