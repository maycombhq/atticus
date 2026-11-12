import { execFile } from "node:child_process";
import { killProcessTree, trackTree } from "@maycombhq/core";

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

/** Beta.27 review: git stopped by its caller's signal (Stop on a sync), not failed. */
export class GitStoppedError extends GitError {
  constructor(args: readonly string[]) {
    super(`git ${args[0] ?? ""} stopped`, args, null, "");
    this.name = "GitStoppedError";
  }
}

export interface GitResult {
  stdout: string;
  stderr: string;
}

/**
 * Runs git. Injectable so callers can log or sandbox it; the default uses the git on PATH.
 * Beta.27 review: `signal` stops it (Stop on a sync in the app): git and every process it started
 * are killed, and the call rejects with GitStoppedError.
 */
export type GitRunner = (
  args: string[],
  cwd: string,
  o?: { signal?: AbortSignal },
) => Promise<GitResult>;

/**
 * Default runner: no shell, no prompts (credentials come from the user's credential
 * manager or fail fast), English messages, no pager.
 */
export function createGit(opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): GitRunner {
  const env = {
    ...(opts.env ?? process.env),
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    LC_ALL: "C",
  };
  // Windows: paths past 260 characters (a deep Java package in a deep folder) work for every
  // command, whether or not the person set core.longpaths themselves.
  const pre = process.platform === "win32" ? ["-c", "core.longpaths=true"] : [];
  return (args, cwd, o = {}) =>
    new Promise((resolve, reject) => {
      const signal = o.signal;
      if (signal?.aborted) {
        reject(new GitStoppedError(args));
        return;
      }
      let stopped = false;
      const child = execFile(
        "git",
        [...pre, ...args],
        {
          cwd,
          env,
          timeout: opts.timeoutMs ?? 10 * 60_000,
          maxBuffer: 64 * 1024 * 1024,
          windowsHide: true,
          encoding: "utf8",
          // A git that may be stopped runs in its own process group (POSIX), so the stop takes
          // what it started too. Only then: a terminal's Ctrl+C still reaches a plain git.
          ...(signal && process.platform !== "win32" ? { detached: true } : {}),
        },
        (err, stdout, stderr) => {
          signal?.removeEventListener("abort", onAbort);
          untrack?.();
          if (stopped) {
            reject(new GitStoppedError(args));
            return;
          }
          if (err) {
            const code = typeof err.code === "number" ? err.code : null;
            const detail = (stderr || err.message).trim().split(/\r?\n/).slice(-3).join(" ");
            reject(new GitError(`git ${args[0] ?? ""} failed: ${detail}`, args, code, stderr));
            return;
          }
          resolve({ stdout, stderr });
        },
      );
      const onAbort = () => {
        stopped = true;
        killProcessTree(child);
      };
      // Beta.27 review: in its own group, the git no longer hears the terminal (Ctrl+C, the
      // terminal closed under atticus ui): kept with core's trees, it is stopped with Atticus
      // (a stop, as Stop is) and killed when Atticus exits, never left running past the lock.
      const untrack = signal
        ? trackTree(child, (s) => {
            stopped = true;
            killProcessTree(child, s);
          })
        : undefined;
      signal?.addEventListener("abort", onAbort, { once: true });
    });
}
