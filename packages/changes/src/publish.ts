import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { requireApproval, type Approval } from "@maycombhq/adapters";
import { createGit } from "@maycombhq/workspace";

/**
 * Puts a hand-off's files on its branch on the Git host, so the PR carries them. Pushing is
 * a write to a shared system, so it takes the same approval as opening the PR.
 */
export interface HandoffPublisher {
  publish(input: {
    root: string;
    branch: string;
    base: string;
    /** Paths relative to the metarepo root, forward slashes. */
    files: string[];
    message: string;
    approval: Approval;
  }): Promise<{
    commit: string;
    /** Review round 48: false when the branch on the remote was already at `commit`. */
    changed?: boolean;
  }>;
}

/**
 * Publishes with git without touching the person's working tree, index or checked-out
 * branch: it builds the commit in a separate index file (GIT_INDEX_FILE) on top of the
 * hand-off branch if it exists on the remote, else on the base branch, then pushes it.
 * A second publish for the same hand-off (after changes were requested) adds a commit.
 */
export function gitHandoffPublisher(
  opts: { remote?: string; env?: NodeJS.ProcessEnv } = {},
): HandoffPublisher {
  const remote = opts.remote ?? "origin";
  const env = opts.env ?? process.env;
  return {
    async publish(input) {
      requireApproval("git", input.approval);
      // Round 37: one publish at a time per metarepo, each in its own index, so two proposals (or a
      // proposal and a hand-off) at once never push each other's files.
      const key = resolve(input.root);
      const before = queue.get(key) ?? Promise.resolve();
      const mine = before.catch(() => undefined).then(() => publishOne(input));
      queue.set(
        key,
        mine.catch(() => undefined),
      );
      return mine;
    },
  };

  async function publishOne({
    root,
    branch,
    base,
    files,
    message,
  }: Parameters<HandoffPublisher["publish"]>[0]): ReturnType<HandoffPublisher["publish"]> {
    {
      const git = createGit({ env });
      const out = async (args: string[]) => (await git(args, root)).stdout.trim();
      const tryOut = (args: string[]) => out(args).catch(() => undefined);

      const gitDir = await out(["rev-parse", "--absolute-git-dir"]);
      await tryOut(["fetch", "--quiet", remote, base]);
      await tryOut(["fetch", "--quiet", remote, branch]);
      const onRemote = await tryOut([
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/remotes/${remote}/${branch}^{commit}`,
      ]);
      const start =
        onRemote ??
        (await tryOut([
          "rev-parse",
          "--verify",
          "--quiet",
          `refs/remotes/${remote}/${base}^{commit}`,
        ])) ??
        (await out(["rev-parse", "--verify", `refs/heads/${base}^{commit}`]));

      const index = join(gitDir, `atticus-handoff-index-${process.pid}-${randomUUID()}`);
      const staged = createGit({ env: { ...env, GIT_INDEX_FILE: index } });
      try {
        await staged(["read-tree", start], root);
        if (files.length > 0) await staged(["add", "-f", "--", ...files], root);
        const tree = (await staged(["write-tree"], root)).stdout.trim();
        const startTree = await out(["rev-parse", `${start}^{tree}`]);
        const commit =
          tree === startTree ? start : await out(["commit-tree", tree, "-p", start, "-m", message]);
        // App-only audit: the local branch holds the commit before the push, so a push that
        // fails leaves it here for Push again (or the person) to send.
        await keepLocalBranch(out, tryOut, branch, start, commit);
        // The commit goes up by itself: never forced, so the remote's branch only moves on.
        await out(["push", "--quiet", remote, `${commit}:refs/heads/${branch}`]);
        return { commit, changed: commit !== onRemote };
      } finally {
        await rm(index, { force: true });
      }
    }
  }
}

const queue = new Map<string, Promise<unknown>>();

/**
 * App-only audit: whether the hand-off branch here is on the remote as it is here, by the
 * remote-tracking ref a push or fetch leaves (no network). False when the branch is here and the
 * remote's (as last seen) is missing or at another commit; true when it isn't here at all.
 */
export async function handoffBranchPushed(
  root: string,
  branch: string,
  o: { remote?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<boolean> {
  const git = createGit({ env: o.env ?? process.env });
  const sha = (ref: string) =>
    git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], root).then(
      (x) => x.stdout.trim() || undefined,
      () => undefined,
    );
  const here = await sha(`refs/heads/${branch}`);
  if (!here) return true;
  return (await sha(`refs/remotes/${o.remote ?? "origin"}/${branch}`)) === here;
}

/**
 * App-only audit: Push again. The hand-off branch here goes to the remote by name, never forced
 * (the remote's only moves on), on the person's approval. A push that fails throws with git's
 * words; the branch stays here.
 */
export async function pushHandoffBranch(
  root: string,
  branch: string,
  o: { approval: Approval; remote?: string; env?: NodeJS.ProcessEnv },
): Promise<{ branch: string; commit: string }> {
  requireApproval("git", o.approval);
  if (!/^handoff\//.test(branch)) throw new Error(`${branch} isn't a hand-off branch`);
  const git = createGit({ env: o.env ?? process.env });
  const commit = (
    await git(["rev-parse", "--verify", `refs/heads/${branch}^{commit}`], root)
  ).stdout.trim();
  await git(
    ["push", "--quiet", o.remote ?? "origin", `refs/heads/${branch}:refs/heads/${branch}`],
    root,
  );
  return { branch, commit };
}

/**
 * Review round 48: the local hand-off branch follows the published commit only when that can't
 * lose anything. A branch checked out in any worktree (HEAD would move under the person) or with
 * commits the publish didn't start from (their unpushed work) is left as it is; otherwise it moves
 * by compare-and-swap, or is made when it isn't there.
 */
async function keepLocalBranch(
  out: (args: string[]) => Promise<string>,
  tryOut: (args: string[]) => Promise<string | undefined>,
  branch: string,
  start: string,
  commit: string,
): Promise<void> {
  const ref = `refs/heads/${branch}`;
  const local = await tryOut(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (local === commit) return;
  const list = (await tryOut(["worktree", "list", "--porcelain"])) ?? "";
  if (list.split(/\r?\n/).includes(`branch ${ref}`)) return;
  if (!local) {
    await tryOut(["update-ref", ref, commit, ""]);
    return;
  }
  const own = await tryOut(["rev-list", "--count", `${start}..${local}`]);
  if (own === undefined || own !== "0") return;
  await out(["update-ref", ref, commit, local]).catch(() => undefined);
}
