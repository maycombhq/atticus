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
 * `settled`: the task's earlier PR was merged or closed and its branch has nothing of its own, so
 * the branch already cut doesn't hold the change branch back (review round 48).
 */
export async function catchUpChangeBranch(
  root: string,
  change: string,
  task: string,
  repo: string,
  changeDir: string,
  git: GitRunner = createGit(),
  o: { settled?: boolean } = {},
): Promise<string | undefined> {
  const base = baseClonePath(root, repo);
  if (!existsSync(base)) return undefined;
  const from = changeBranch(change);
  const rev = (ref: string) =>
    git(["rev-parse", "--verify", "--quiet", ref], base).then(
      (r) => r.stdout.trim() || undefined,
      () => undefined,
    );
  // Review round 48: a task branch whose PR was merged or closed with nothing of its own left
  // (taskBranchOwnCommits) starts again from the change branch, so it catches up too.
  if (!o.settled && (await rev(`refs/heads/${taskBranch(change, task)}`))) return undefined;
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
  /**
   * Review round 44: whether the commits only the local branch has are all this change's
   * hand-downs, and the host's branch has their files as they are (a squash or rebase merge of
   * the tasks' PRs, which carried them).
   */
  const onlyHandDowns = async (onHostTip: string, localTip: string): Promise<boolean> => {
    try {
      const log = await git(["log", "--format=%P%x00%B%x1e", `${onHostTip}..${localTip}`], base);
      const commits = log.stdout
        .split("\x1e")
        .map((c) => c.replace(/^\n+/, ""))
        .filter(Boolean);
      if (commits.length === 0) return false;
      for (const c of commits) {
        const [parents = "", body = ""] = c.split("\x00");
        if (parents.trim().split(/\s+/).length !== 1) return false;
        if (!body.startsWith("Hand down task ")) return false;
        if (!body.split("\n").includes(`Atticus-Change: ${change}`)) return false;
      }
      const diff = await git(["diff", "--name-only", "-z", `${onHostTip}...${localTip}`], base);
      const files = [...new Set(diff.stdout.split("\0").filter(Boolean))];
      if (files.length > 0)
        await git(
          ["--literal-pathspecs", "diff", "--quiet", onHostTip, localTip, "--", ...files],
          base,
        );
      return true;
    } catch {
      return false;
    }
  };
  const rel = changeDir.slice(root.length + 1).replace(/\\/g, "/");
  const note = (handedDown: boolean) =>
    `Brought ${from} in ${repo} up to the Git host's first (the tasks merged into it there).${handedDown ? " Its local hand-down commits were already there, in the tasks' merged PRs." : ""}`;
  // Review round 44: a hand-down commit reaches the host only inside its task's PR, so a squash
  // or rebase merge leaves it local-only for good. When every local-only commit is a hand-down
  // of this change whose files the host's branch already has as they are, the local branch moves
  // to the host's (local bookkeeping: nothing is pushed). Anything else is never rewritten.
  const behind = await ancestor(local, remote);
  const handedDown = !behind && (await onlyHandDowns(remote, local));
  if (!behind && !handedDown)
    throw new SpecKitError(
      "refused",
      `${from} in ${repo} has commits the Git host's hasn't, and the host's has commits it hasn't (tasks merged there): Atticus doesn't rewrite it. Merge origin/${from} into it in ${rel} (or push it), then run task ${task} again.`,
    );
  // Final review (git and tasks): only change/<id> moves. The reset or merge runs in the change
  // worktree only when that branch is checked out there; a person who switched the worktree to
  // a branch of their own keeps it as it is, and change/<id> moves by compare-and-swap when no
  // worktree has it checked out.
  const there = await git(["symbolic-ref", "-q", "HEAD"], changeDir).then(
    (r) => r.stdout.trim(),
    () => "",
  );
  if (there !== `refs/heads/${from}`) {
    const list = await git(["worktree", "list", "--porcelain"], base);
    const out = list.stdout.split("\n").includes(`branch refs/heads/${from}`);
    if (out) {
      const has = there ? there.replace(/^refs\/heads\//, "") : "a detached HEAD";
      const own = there ? ` (commit your work on ${has} first)` : "";
      throw new SpecKitError(
        "refused",
        `${from} in ${repo} is behind the Git host's (tasks merged there), but the change worktree ${rel} has ${has} checked out, not ${from}, and ${from} is checked out in another worktree: Atticus doesn't move a branch you're working on. Switch ${rel} back to ${from}${own}, then run task ${task} again.`,
      );
    }
    await git(["update-ref", `refs/heads/${from}`, remote, local], base);
    return note(handedDown);
  }
  try {
    await git(
      handedDown ? ["reset", "-q", "--keep", remote] : ["merge", "-q", "--ff-only", remote],
      changeDir,
    );
  } catch (e) {
    throw new SpecKitError(
      "refused",
      `${from} in ${repo} is behind the Git host's (tasks merged there), and it can't fast-forward in ${rel}: ${(e instanceof Error ? e.message : String(e)).trim()}. Commit or put aside the edits there, then run task ${task} again.`,
    );
  }
  return note(handedDown);
}

/**
 * Review round 48: the commits of a task's branch that neither the change branch here nor the Git
 * host's has (fetched first; a host that can't be reached is judged by the branch here). After the
 * task's PR was closed, they are the work that PR carried; after a squash or rebase merge, the
 * commits the host merged in another form. Zero when the task branch isn't there. Reads only.
 */
export async function taskBranchOwnCommits(
  root: string,
  change: string,
  task: string,
  repo: string,
  git: GitRunner = createGit(),
): Promise<number> {
  const base = baseClonePath(root, repo);
  if (!existsSync(base)) return 0;
  const branch = taskBranch(change, task);
  const from = changeBranch(change);
  const has = (ref: string) =>
    git(["rev-parse", "--verify", "--quiet", ref], base).then(
      (r) => !!r.stdout.trim(),
      () => false,
    );
  if (!(await has(`refs/heads/${branch}`))) return 0;
  await git(
    ["fetch", "-q", "origin", `+refs/heads/${from}:refs/remotes/origin/${from}`],
    base,
  ).catch(() => undefined);
  const not: string[] = [];
  for (const ref of [`refs/heads/${from}`, `refs/remotes/origin/${from}`])
    if (await has(ref)) not.push(ref);
  const r = await git(["rev-list", "--count", `refs/heads/${branch}`, "--not", ...not], base);
  return Number(r.stdout.trim()) || 0;
}

/**
 * The task's worktree on its branch, cut from the change branch when the branch isn't there yet.
 * `fresh` (review round 48: the task's earlier PR was merged or closed, and its branch has nothing
 * of its own): a task branch already there moves on to the change branch, by fast-forward only
 * (in its worktree when it is checked out there, else compare-and-swap when no worktree has it).
 */
export async function openTaskWorktree(
  root: string,
  change: string,
  task: string,
  repo: string,
  git: GitRunner = createGit(),
  o: { fresh?: boolean } = {},
): Promise<{ path: string; branch: string; created: boolean }> {
  const path = taskWorktreePath(root, change, task, repo);
  const branch = taskBranch(change, task);
  if (existsSync(path)) {
    if (o.fresh) await fastForwardTask(root, change, task, repo, path, git);
    return { path, branch, created: false };
  }
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
  if (await ok(`refs/heads/${branch}`)) {
    if (o.fresh) await fastForwardTask(root, change, task, repo, undefined, git);
    await git(["worktree", "add", "--", path, branch], base);
  } else {
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

/** Moves a task branch with nothing of its own on to the change branch, by fast-forward only. */
async function fastForwardTask(
  root: string,
  change: string,
  task: string,
  repo: string,
  path: string | undefined,
  git: GitRunner,
): Promise<void> {
  const base = baseClonePath(root, repo);
  const branch = taskBranch(change, task);
  const from = changeBranch(change);
  const rev = (ref: string) =>
    git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], base).then(
      (r) => r.stdout.trim() || undefined,
      () => undefined,
    );
  const tip = await rev(`refs/heads/${branch}`);
  const to = await rev(`refs/heads/${from}`);
  if (!tip || !to || tip === to) return;
  const behind = await git(["merge-base", "--is-ancestor", tip, to], base).then(
    () => true,
    () => false,
  );
  if (!behind) return;
  const there = path
    ? await git(["symbolic-ref", "-q", "HEAD"], path).then(
        (r) => r.stdout.trim(),
        () => "",
      )
    : "";
  try {
    if (path && there === `refs/heads/${branch}`) {
      await git(["merge", "-q", "--ff-only", to], path);
      return;
    }
    const list = await git(["worktree", "list", "--porcelain"], base);
    if (list.stdout.split("\n").includes(`branch refs/heads/${branch}`))
      throw new Error(`${branch} is checked out in another worktree`);
    await git(["update-ref", `refs/heads/${branch}`, to, tip], base);
  } catch (e) {
    throw new SpecKitError(
      "refused",
      `${branch} in ${repo} couldn't move on to ${from} for a fresh start: ${(e instanceof Error ? e.message : String(e)).trim()}. Commit or put aside the edits in its worktree, then run task ${task} again.`,
    );
  }
}
