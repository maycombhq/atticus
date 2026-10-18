import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
  changeBranch,
  type ChangeRepo,
  type ChangeRepos,
  type ManifestRepo,
} from "@maycombhq/core";
import { readChangeRepos, writeChangeRepos } from "./files.js";
import { createGit, GitError, type GitRunner } from "./git.js";
import {
  baseClonePath,
  changeWorktreesDir,
  ensureGitignore,
  toRepoRelative,
  worktreePath,
} from "./layout.js";
import { removeEditorWorkspaces, writeEditorWorkspaces } from "./editors.js";

export interface SyncResult {
  id: string;
  action: "cloned" | "updated" | "skipped" | "failed";
  sha?: string;
  reason?: string;
}

export interface WorkspaceManager {
  readonly root: string;
  /** Clone missing base clones and fast-forward existing ones to the default branch. One failure doesn't stop the rest. */
  sync(repos: ManifestRepo[]): Promise<SyncResult[]>;
  /** Create (or reuse) a worktree on change/<id> in each repo, record them in repos.yaml and write the editor workspaces. */
  openChange(change: string, repos: ManifestRepo[]): Promise<ChangeRepos>;
  /**
   * Remove worktrees whose PR merged or closed (or all of them with `all`), and the editor
   * workspaces once none remain. Worktrees with uncommitted work are kept unless `force`.
   */
  prune(
    change: string,
    opts?: { all?: boolean; force?: boolean },
  ): Promise<{ removed: string[]; kept: { id: string; reason: string }[] }>;
}

export function createWorkspace(root: string, git: GitRunner = createGit()): WorkspaceManager {
  const g = (args: string[], cwd = root) => git(args, cwd);
  const head = async (cwd: string) => (await g(["rev-parse", "HEAD"], cwd)).stdout.trim();
  const dirty = async (cwd: string) =>
    (await g(["status", "--porcelain", "--untracked-files=normal"], cwd)).stdout.trim() !== "";
  const refExists = async (cwd: string, ref: string) => {
    try {
      await g(["rev-parse", "--verify", "--quiet", ref], cwd);
      return true;
    } catch {
      return false;
    }
  };

  async function syncOne(repo: ManifestRepo): Promise<SyncResult> {
    if (repo.archived) return { id: repo.id, action: "skipped", reason: "archived" };
    const dest = baseClonePath(root, repo.id);
    const branch = repo.defaultBranch;
    try {
      if (!existsSync(dest)) {
        await mkdir(dirname(dest), { recursive: true });
        const args = ["clone", "--no-tags", "--branch", branch, "--filter=blob:none"];
        if (repo.sparse.length > 0) args.push("--sparse");
        args.push("--", repo.url, dest);
        await g(args);
        if (repo.sparse.length > 0) await g(["sparse-checkout", "set", "--", ...repo.sparse], dest);
        return { id: repo.id, action: "cloned", sha: await head(dest) };
      }
      if (await dirty(dest)) {
        return {
          id: repo.id,
          action: "skipped",
          sha: await head(dest),
          reason: "the base clone has local changes; base clones are read-only",
        };
      }
      await g(
        ["fetch", "--no-tags", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
        dest,
      );
      await g(["checkout", "--quiet", "-B", branch, `refs/remotes/origin/${branch}`], dest);
      if (repo.sparse.length > 0) await g(["sparse-checkout", "set", "--", ...repo.sparse], dest);
      return { id: repo.id, action: "updated", sha: await head(dest) };
    } catch (err) {
      return { id: repo.id, action: "failed", reason: (err as Error).message };
    }
  }

  async function worktreeFor(change: string, repo: ManifestRepo): Promise<ChangeRepo> {
    const base = baseClonePath(root, repo.id);
    if (!existsSync(base))
      throw new Error(`no base clone for ${repo.id}; run atticus workspace sync first`);
    const branch = changeBranch(change);
    const path = worktreePath(root, change, repo.id);
    const baseRef = `refs/remotes/origin/${repo.defaultBranch}`;
    const baseSha = (await g(["rev-parse", baseRef], base)).stdout.trim();

    if (!existsSync(path)) {
      await mkdir(dirname(path), { recursive: true });
      // Someone may already have pushed this change's branch; continue from it if so.
      try {
        await g(
          ["fetch", "--no-tags", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
          base,
        );
      } catch {
        // no remote branch yet
      }
      if (await refExists(base, `refs/heads/${branch}`)) {
        await g(["worktree", "add", "--", path, branch], base);
      } else if (await refExists(base, `refs/remotes/origin/${branch}`)) {
        await g(
          ["worktree", "add", "--track", "-b", branch, "--", path, `refs/remotes/origin/${branch}`],
          base,
        );
      } else {
        await g(["worktree", "add", "--no-track", "-b", branch, "--", path, baseRef], base);
      }
    }
    return {
      id: repo.id,
      branch,
      base: repo.defaultBranch,
      baseSha,
      worktree: toRepoRelative(root, path),
      build: { status: "not-run" },
    };
  }

  return {
    root,

    async sync(repos) {
      await ensureGitignore(root);
      const out: SyncResult[] = [];
      for (const repo of repos) out.push(await syncOne(repo));
      return out;
    },

    async openChange(change, repos) {
      await ensureGitignore(root);
      const existing = await readChangeRepos(root, change);
      const byId = new Map((existing?.repos ?? []).map((r) => [r.id, r]));
      for (const repo of repos) {
        const fresh = await worktreeFor(change, repo);
        const prior = byId.get(repo.id);
        // Keep what is already known (PR, build, original base) for repos opened before.
        byId.set(repo.id, prior ? { ...fresh, ...prior, worktree: fresh.worktree } : fresh);
      }
      const value: ChangeRepos = {
        schemaVersion: 1,
        change,
        repos: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
      };
      await writeChangeRepos(root, value);
      await writeEditorWorkspaces(root, value);
      return value;
    },

    async prune(change, opts = {}) {
      const repos = await readChangeRepos(root, change);
      const removed: string[] = [];
      const kept: { id: string; reason: string }[] = [];
      if (!repos) return { removed, kept };
      for (const r of repos.repos) {
        const done = r.pr?.state === "merged" || r.pr?.state === "closed";
        if (!done && !opts.all) {
          kept.push({ id: r.id, reason: r.pr ? `PR is ${r.pr.state}` : "no PR yet" });
          continue;
        }
        const path = worktreePath(root, change, r.id);
        if (!existsSync(path)) {
          removed.push(r.id);
          continue;
        }
        const base = baseClonePath(root, r.id);
        try {
          if (!opts.force && (await dirty(path))) {
            kept.push({ id: r.id, reason: "uncommitted changes in the worktree" });
            continue;
          }
          const args = ["worktree", "remove"];
          if (opts.force) args.push("--force");
          await g([...args, "--", path], base);
          removed.push(r.id);
        } catch (err) {
          kept.push({ id: r.id, reason: err instanceof GitError ? err.message : String(err) });
        }
      }
      for (const r of repos.repos) {
        if (existsSync(baseClonePath(root, r.id)))
          await g(["worktree", "prune"], baseClonePath(root, r.id)).catch(() => undefined);
      }
      if (kept.length === 0) {
        await removeEditorWorkspaces(root, change);
        await rm(changeWorktreesDir(root, change), { recursive: true, force: true });
      }
      return { removed, kept };
    },
  };
}
