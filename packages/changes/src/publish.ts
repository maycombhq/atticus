import { rm } from "node:fs/promises";
import { join } from "node:path";
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
  }): Promise<{ commit: string }>;
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
    async publish({ root, branch, base, files, message, approval }) {
      requireApproval("git", approval);
      const git = createGit({ env });
      const out = async (args: string[]) => (await git(args, root)).stdout.trim();
      const tryOut = (args: string[]) => out(args).catch(() => undefined);

      const gitDir = await out(["rev-parse", "--absolute-git-dir"]);
      await tryOut(["fetch", "--quiet", remote, base]);
      await tryOut(["fetch", "--quiet", remote, branch]);
      const start =
        (await tryOut([
          "rev-parse",
          "--verify",
          "--quiet",
          `refs/remotes/${remote}/${branch}^{commit}`,
        ])) ??
        (await tryOut([
          "rev-parse",
          "--verify",
          "--quiet",
          `refs/remotes/${remote}/${base}^{commit}`,
        ])) ??
        (await out(["rev-parse", "--verify", `refs/heads/${base}^{commit}`]));

      const index = join(gitDir, "atticus-handoff-index");
      const staged = createGit({ env: { ...env, GIT_INDEX_FILE: index } });
      try {
        await staged(["read-tree", start], root);
        if (files.length > 0) await staged(["add", "-f", "--", ...files], root);
        const tree = (await staged(["write-tree"], root)).stdout.trim();
        const startTree = await out(["rev-parse", `${start}^{tree}`]);
        const commit =
          tree === startTree ? start : await out(["commit-tree", tree, "-p", start, "-m", message]);
        await out(["update-ref", `refs/heads/${branch}`, commit]);
        await out(["push", "--quiet", remote, `${commit}:refs/heads/${branch}`]);
        return { commit };
      } finally {
        await rm(index, { force: true });
      }
    },
  };
}
