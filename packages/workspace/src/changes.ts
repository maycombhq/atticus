import type { FileChange } from "@maycombhq/core";
import { createGit, type GitRunner } from "./git.js";

/**
 * The files changed between two commits of a checkout (ADR 0124 addendum A-incremental), so a
 * repo read at one commit is read again only where it changed. Local git only: `git diff --raw
 * -M` between the two commits (renames followed, a submodule's gitlink marked), never the working
 * tree and never the network. Sorted by path, so the same two commits give the same list.
 */

const STATUS: Record<string, FileChange["status"]> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "type-changed",
};

export async function changedFiles(
  dir: string,
  from: string,
  to: string,
  git: GitRunner = createGit({ timeoutMs: 60_000 }),
): Promise<FileChange[]> {
  // Review round 49: --raw, not --name-status, so the modes say when a path is a submodule's
  // gitlink (160000): its bump changes files under it that the diff never names.
  const r = await git(
    ["diff", "--raw", "--no-abbrev", "-M", "-z", "--no-color", "--no-ext-diff", from, to, "--"],
    dir,
  );
  const parts = r.stdout.split("\0");
  const out: FileChange[] = [];
  for (let i = 0; i < parts.length;) {
    const head = parts[i++] ?? "";
    if (!head) continue;
    // ":<old mode> <new mode> <old sha> <new sha> <status>"
    const [oldMode, newMode, , , code = ""] = head.replace(/^:/, "").split(" ");
    const gitlink = oldMode === "160000" || newMode === "160000";
    const link = gitlink ? { gitlink: true } : {};
    const status = STATUS[code[0] ?? ""];
    if (status === "renamed" || status === "copied") {
      const old = parts[i++] ?? "";
      const path = parts[i++] ?? "";
      if (old && path) out.push({ status, path, from: old, ...link });
    } else {
      const path = parts[i++] ?? "";
      // an unmerged or unknown status (U, X) is no commit-to-commit change: said as an edit
      if (path) out.push({ status: status ?? "modified", path, ...link });
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Same commit when either names the other's prefix (a facts file may keep a short one). */
const sameCommit = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);

/**
 * The files changed from each earlier commit to `to`, one diff per distinct commit; a commit the
 * clone doesn't have (a shallow or stale clone), or that `to` is behind or beside, is `missing`,
 * never guessed.
 */
export async function changesSince(
  dir: string,
  commits: readonly string[],
  to: string,
  git?: GitRunner,
): Promise<{ changes: Record<string, FileChange[]>; missing: string[] }> {
  const changes: Record<string, FileChange[]> = {};
  const missing: string[] = [];
  for (const c of [...new Set(commits)].filter((x) => !sameCommit(x, to)).sort()) {
    try {
      // Round 41: only an earlier commit of `to` is carried forward. A commit the clone is
      // behind, or one on another branch, would diff backwards and drop what changed since:
      // it is missing (git exits non-zero when c isn't an ancestor of `to`).
      await (git ?? createGit({ timeoutMs: 60_000 }))(["merge-base", "--is-ancestor", c, to], dir);
      changes[c] = await changedFiles(dir, c, to, git);
    } catch {
      missing.push(c);
    }
  }
  return { changes, missing };
}
