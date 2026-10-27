import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  changeBranch,
  WORKSPACE_SCHEMA_VERSION,
  type ChangeRepo,
  type ChangeRepos,
  type ManifestRepo,
} from "@maycombhq/core";
import { readChangeRepos, writeChangeRepos } from "./files.js";
import { createGit, GitError, type GitRunner } from "./git.js";
import {
  baseClonePath,
  branchCheckoutPath,
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
  /**
   * The branch the remote calls its default (ADR 0123), read at this sync: a warning when the
   * manifest's defaultBranch is another one. Undefined when the remote didn't say.
   */
  remoteDefault?: string;
  /** The clone of yours it was copied from (`sync --from`), when one matched. */
  from?: string;
}

export interface SyncOptions {
  /**
   * A folder holding your own clones (`atticus workspace sync --from <dir>`). A missing base
   * clone is copied from your clone of the same repo there (matched by its origin URL, else by
   * folder name), with no network: Git hard-links the objects on the same drive. It takes the
   * branch as your clone last fetched it (origin/<branch>), never your unpushed commits or
   * edits, and points origin at the manifest's URL, so later syncs fetch from the server. Your
   * clones are only read.
   */
  from?: string;
}

export interface WorkspaceManager {
  readonly root: string;
  /** Clone missing base clones and fast-forward existing ones to the default branch. One failure doesn't stop the rest. */
  sync(repos: ManifestRepo[], opts?: SyncOptions): Promise<SyncResult[]>;
  /**
   * Another branch of a repo, checked out read-only beside its base clone (ADR 0123), fetched
   * first: what `atticus scan --ref` reads. Nothing is ever committed there.
   */
  checkoutBranch(repo: ManifestRepo, branch: string): Promise<{ dir: string; commit: string }>;
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

/**
 * A manifest url of `.` or `./<path>` names a repo already in place under the metarepo root
 * (an adopted repo, or a folder of clones): scans read it there, so there is no base clone.
 */
export function isInPlace(url: string): boolean {
  return url === "." || url.startsWith("./");
}

/**
 * The remote's default branch as the base clone last heard it (refs/remotes/origin/HEAD, which
 * every sync refreshes): read offline, for doctor and the Repos screen. Undefined when unknown.
 */
export async function remoteDefaultBranch(
  dir: string,
  git: GitRunner = createGit(),
): Promise<string | undefined> {
  if (!existsSync(dir)) return undefined;
  try {
    const r = (await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], dir)).stdout;
    return r.trim().replace(/^origin\//, "") || undefined;
  } catch {
    return undefined;
  }
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

  // Ask the remote which branch it calls its default (ADR 0123); never fails the sync.
  const remoteDefault = async (cwd: string): Promise<{ remoteDefault?: string }> => {
    try {
      await g(["remote", "set-head", "origin", "--auto"], cwd);
    } catch {
      // the remote didn't say; what the clone knew stays
    }
    const b = await remoteDefaultBranch(cwd, git);
    return b ? { remoteDefault: b } : {};
  };

  /**
   * A base clone copied from your clone at `from`, with no network (sync --from): a local clone
   * (hard-linked objects), origin pointed at the manifest's URL, and the branch checked out at
   * your clone's origin/<branch> (what the server had when you last fetched), else at your
   * local branch when it has never fetched.
   */
  async function copyFrom(repo: ManifestRepo, from: string, dest: string): Promise<SyncResult> {
    const branch = repo.defaultBranch;
    const sha = async (ref: string) => {
      try {
        return (
          await g(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], from)
        ).stdout.trim();
      } catch {
        return "";
      }
    };
    const at = (await sha(`refs/remotes/origin/${branch}`)) || (await sha(`refs/heads/${branch}`));
    if (!at)
      return {
        id: repo.id,
        action: "failed",
        reason: `your clone at ${from} has no ${branch} branch; fetch it there, or sync without --from`,
      };
    await g(["clone", "--quiet", "--no-tags", "--no-checkout", "--", from, dest]);
    await g(["remote", "set-url", "origin", repo.url], dest);
    // Your clone's own branches came over as origin/*: replace them with the one we read.
    const refs = (
      await g(["for-each-ref", "--format=%(refname)", "refs/remotes/origin"], dest)
    ).stdout
      .split("\n")
      .filter(Boolean);
    for (const r of refs) await g(["update-ref", "-d", r], dest);
    await g(["update-ref", `refs/remotes/origin/${branch}`, at], dest);
    if (repo.sparse.length > 0) await g(["sparse-checkout", "set", "--", ...repo.sparse], dest);
    await g(["checkout", "--quiet", "-B", branch, at], dest);
    return { id: repo.id, action: "cloned", sha: await head(dest), from };
  }

  async function syncOne(
    repo: ManifestRepo,
    local: Map<string, string> | undefined,
  ): Promise<SyncResult> {
    if (repo.archived) return { id: repo.id, action: "skipped", reason: "archived" };
    if (isInPlace(repo.url))
      return {
        id: repo.id,
        action: "skipped",
        reason: `in place at ${repo.url}, nothing to clone`,
      };
    const dest = baseClonePath(root, repo.id);
    const branch = repo.defaultBranch;
    try {
      if (!existsSync(dest)) {
        await mkdir(dirname(dest), { recursive: true });
        const from = local && yourClone(local, repo);
        if (from) return await copyFrom(repo, from, dest);
        const args = ["clone", "--no-tags", "--branch", branch, "--filter=blob:none"];
        if (repo.sparse.length > 0) args.push("--sparse");
        args.push("--", repo.url, dest);
        await g(args);
        if (repo.sparse.length > 0) await g(["sparse-checkout", "set", "--", ...repo.sparse], dest);
        return {
          id: repo.id,
          action: "cloned",
          sha: await head(dest),
          ...(await remoteDefault(dest)),
        };
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
      return {
        id: repo.id,
        action: "updated",
        sha: await head(dest),
        ...(await remoteDefault(dest)),
      };
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

    async sync(repos, opts = {}) {
      // Only base clones need workspace/ ignored; a root of in-place repos (an adopted repo)
      // must stay untouched.
      if (repos.some((r) => !r.archived && !isInPlace(r.url))) await ensureGitignore(root);
      const out: SyncResult[] = [];
      const local = opts.from ? await localClones(opts.from) : undefined;
      for (const repo of repos) out.push(await syncOne(repo, local));
      return out;
    },

    async checkoutBranch(repo, branch) {
      const base = baseClonePath(root, repo.id);
      if (!existsSync(base))
        throw new Error(`no base clone for ${repo.id}; run atticus workspace sync first`);
      const ref = `refs/remotes/origin/${branch}`;
      try {
        await g(["fetch", "--no-tags", "origin", `+refs/heads/${branch}:${ref}`], base);
      } catch {
        throw new Error(`${repo.id} has no branch ${branch} on its remote`);
      }
      const dir = branchCheckoutPath(root, repo.id, branch);
      if (!existsSync(dir)) {
        await mkdir(dirname(dir), { recursive: true });
        await g(["worktree", "add", "--detach", "--", dir, ref], base);
      } else await g(["checkout", "--quiet", "--force", "--detach", ref], dir);
      return { dir, commit: await head(dir) };
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
        schemaVersion: WORKSPACE_SCHEMA_VERSION,
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

/**
 * A remote URL as a key: no credentials, no trailing `.git` or `/`, the host in lower case and
 * `git@host:path` written as `host/path`, so a clone made over SSH matches a manifest's HTTPS.
 */
export function remoteKey(url: string): string {
  let u = url.trim().replace(/\\/g, "/");
  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(u);
  if (scp) u = `${scp[1]}/${scp[2]}`;
  u = u.replace(/^[a-z+]+:\/\//i, "").replace(/^[^@/]+@/, "");
  u = u.replace(/\/+$/, "").replace(/\.git$/i, "");
  const slash = u.indexOf("/");
  return slash < 0 ? u.toLowerCase() : u.slice(0, slash).toLowerCase() + u.slice(slash);
}

/** Your clones under `dir` (two levels deep), by their origin's key and by folder name. */
async function localClones(dir: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const visit = async (d: string, depth: number) => {
    let names: string[];
    try {
      names = await readdir(d);
    } catch {
      return;
    }
    if (names.includes(".git")) {
      const cfg = await readFile(join(d, ".git", "config"), "utf8").catch(() => "");
      const url = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(cfg)?.[1];
      if (url && !found.has(`url:${remoteKey(url)}`)) found.set(`url:${remoteKey(url)}`, d);
      if (!found.has(`name:${basename(d)}`)) found.set(`name:${basename(d)}`, d);
      return;
    }
    if (depth === 0) return;
    for (const n of names)
      if (!n.startsWith(".") && n !== "node_modules") await visit(join(d, n), depth - 1);
  };
  await visit(dir, 2);
  return found;
}

const yourClone = (local: Map<string, string>, repo: ManifestRepo): string | undefined =>
  local.get(`url:${remoteKey(repo.url)}`) ?? local.get(`name:${repo.id}`);
