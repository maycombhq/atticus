import { readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { changesDirOf, RecordId } from "@maycombhq/core";

/**
 * Where things live in a metarepo (see the plan's folder layout):
 *
 *   workspace/<repo>/                        base clone of the default branch (scans read these)
 *   workspace/.worktrees/<change>/<repo>/    change worktree on branch change/<change>
 *   workspace/.branches/<repo>/<branch>/     another branch, read-only, scanned beside (ADR 0123)
 *   workspace/<change>.code-workspace        VS Code workspace for the change
 *   workspace/.intellij/<change>/            IntelliJ project for the change
 *   openspec/changes/<change>/repos.yaml     the change's branch, worktree, PR and build per repo
 *                                            (the change folder follows sources.yaml layout.openspec)
 *
 * workspace/, .index/ and .runs/ are git-ignored and never committed.
 */
export const WORKSPACE_DIR = "workspace";
/** Anchored to the metarepo root so a package or folder named "workspace" elsewhere is not ignored. */
export const IGNORED = ["/workspace/", "/.index/", "/.runs/"] as const;

function id(what: string, value: string): string {
  if (!RecordId.safeParse(value).success)
    throw new Error(`${what} "${value}" must be a lowercase slug`);
  return value;
}

export function baseClonePath(root: string, repo: string): string {
  return join(root, WORKSPACE_DIR, id("repo id", repo));
}

/** A branch name as one folder name: what isn't a letter, digit, dot or hyphen becomes "-". */
export const branchSlug = (branch: string) => branch.replace(/[^A-Za-z0-9.-]+/g, "-");

/** Where another branch of a repo is checked out, read-only, to be scanned (ADR 0123). */
export function branchCheckoutPath(root: string, repo: string, branch: string): string {
  return join(root, WORKSPACE_DIR, ".branches", id("repo id", repo), branchSlug(branch));
}

export function changeWorktreesDir(root: string, change: string): string {
  return join(root, WORKSPACE_DIR, ".worktrees", id("change id", change));
}

export function worktreePath(root: string, change: string, repo: string): string {
  return join(changeWorktreesDir(root, change), id("repo id", repo));
}

export function changeDir(root: string, change: string): string {
  return join(changesDirOf(root), id("change id", change));
}

export function changeReposPath(root: string, change: string): string {
  return join(changeDir(root, change), "repos.yaml");
}

export function vscodeWorkspacePath(root: string, change: string): string {
  return join(root, WORKSPACE_DIR, `${id("change id", change)}.code-workspace`);
}

export function intellijProjectPath(root: string, change: string): string {
  return join(root, WORKSPACE_DIR, ".intellij", id("change id", change));
}

/** A path relative to the metarepo, always with forward slashes (stored in repos.yaml). */
export function toRepoRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

/** Add the local-state folders to the metarepo's .gitignore if they are missing. Returns what was added. */
export async function ensureGitignore(root: string): Promise<string[]> {
  const path = join(root, ".gitignore");
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch {
    // none yet
  }
  // "/workspace/", "/workspace", "workspace/" and "workspace" all ignore the root folder.
  const norm = (l: string) => l.trim().replace(/^\//, "").replace(/\/$/, "");
  const have = new Set(text.split(/\r?\n/).map(norm));
  const missing = IGNORED.filter((p) => !have.has(norm(p)));
  if (missing.length > 0) {
    const prefix = text === "" || text.endsWith("\n") ? text : text + "\n";
    await writeFile(
      path,
      `${prefix}${prefix ? "\n" : ""}# Atticus local state\n${missing.join("\n")}\n`,
      "utf8",
    );
  }
  return missing;
}
