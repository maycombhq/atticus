import { userInfo } from "node:os";
import { createGit, type GitRunner } from "./git.js";

/**
 * Who is using Atticus (ADR 0073): the Git user of the metarepo, `git config user.name` and
 * `user.email` as Git itself resolves them there (the repo's own config, then the global one).
 * Atticus has no roles and no sign-in: the person is the one whose name goes on their commits.
 * When Git knows no user, the OS user name stands in, with a warning that says how to fix it.
 */
export interface GitUser {
  /** What Atticus records as `by`: the email's local part, else the name, made handle-safe. */
  handle: string;
  /** user.name, when set. */
  name?: string;
  /** user.email, when set. */
  email?: string;
  /**
   * git: from git config; os: Git has no user here, so the OS user name stands in; given: the
   * caller named the person (`--by`, or a test).
   */
  source: "git" | "os" | "given";
  /** Set when Atticus fell back to the OS user: one sentence for the person. */
  warning?: string;
}

/**
 * A handle-safe form of a name or an email's local part: letters, digits, `.`, `_` and `-`,
 * lower case, starting with a letter or digit ("Pat Doe" → "pat-doe"). Empty when nothing is left.
 */
export function toHandle(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[-._]+$/, "")
    .slice(0, 100);
}

async function config(git: GitRunner, root: string, key: string): Promise<string | undefined> {
  try {
    const v = (await git(["config", "--get", key], root)).stdout.trim();
    return v || undefined;
  } catch {
    // Not set (git exits 1), not a repo with no global config, or no git at all.
    return undefined;
  }
}

function osUser(): string | undefined {
  try {
    return userInfo().username || undefined;
  } catch {
    return undefined;
  }
}

/** The Git user of the metarepo at `root`, or the OS user with a warning. Reads files only. */
export async function gitUser(
  root: string,
  o: { git?: GitRunner; env?: NodeJS.ProcessEnv; osUser?: () => string | undefined } = {},
): Promise<GitUser> {
  const git = o.git ?? createGit({ timeoutMs: 10_000, ...(o.env ? { env: o.env } : {}) });
  const [name, email] = await Promise.all([
    config(git, root, "user.name"),
    config(git, root, "user.email"),
  ]);
  const fromEmail = email ? toHandle(email.split("@")[0]!) : "";
  const fromName = name ? toHandle(name) : "";
  const handle = fromEmail || fromName;
  if (handle)
    return {
      handle,
      ...(name ? { name } : {}),
      ...(email ? { email } : {}),
      source: "git",
    };
  const os = toHandle((o.osUser ?? osUser)() ?? "") || "someone";
  return {
    handle: os,
    source: "os",
    warning: `Git has no user here, so Atticus records you as ${os} (your OS user name). Set yours once: git config --global user.name "Your Name" and git config --global user.email you@example.com.`,
  };
}
