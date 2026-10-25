import type { FileChange } from "@maycombhq/core";
import { createGit, type GitRunner } from "./git.js";

/**
 * The files changed between two commits of a checkout (ADR 0124 addendum A-incremental), so a
 * repo read at one commit is read again only where it changed. Local git only: `git diff
 * --name-status -M` between the two commits (renames followed), never the working tree and never
 * the network. Sorted by path, so the same two commits give the same list.
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
  const r = await git(
    ["diff", "--name-status", "-M", "-z", "--no-color", "--no-ext-diff", from, to, "--"],
    dir,
  );
  const parts = r.stdout.split("\0");
  const out: FileChange[] = [];
  for (let i = 0; i < parts.length;) {
    const code = parts[i++] ?? "";
    if (!code) continue;
    const status = STATUS[code[0]!];
    if (status === "renamed" || status === "copied") {
      const old = parts[i++] ?? "";
      const path = parts[i++] ?? "";
      if (old && path) out.push({ status, path, from: old });
    } else {
      const path = parts[i++] ?? "";
      // an unmerged or unknown status (U, X) is no commit-to-commit change: said as an edit
      if (path) out.push({ status: status ?? "modified", path });
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Same commit when either names the other's prefix (a facts file may keep a short one). */
const sameCommit = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);

/**
 * The files changed from each earlier commit to `to`, one diff per distinct commit; a commit the
 * clone doesn't have (a shallow or stale clone) is `missing`, never guessed.
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
      changes[c] = await changedFiles(dir, c, to, git);
    } catch {
      missing.push(c);
    }
  }
  return { changes, missing };
}
