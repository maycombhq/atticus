import { execFile } from "node:child_process";

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

export interface GitResult {
  stdout: string;
  stderr: string;
}

/** Runs git. Injectable so callers can log or sandbox it; the default uses the git on PATH. */
export type GitRunner = (args: string[], cwd: string) => Promise<GitResult>;

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
  return (args, cwd) =>
    new Promise((resolve, reject) => {
      execFile(
        "git",
        args,
        {
          cwd,
          env,
          timeout: opts.timeoutMs ?? 10 * 60_000,
          maxBuffer: 64 * 1024 * 1024,
          windowsHide: true,
          encoding: "utf8",
        },
        (err, stdout, stderr) => {
          if (err) {
            const code = typeof err.code === "number" ? err.code : null;
            const detail = (stderr || err.message).trim().split(/\r?\n/).slice(-3).join(" ");
            reject(new GitError(`git ${args[0] ?? ""} failed: ${detail}`, args, code, stderr));
            return;
          }
          resolve({ stdout, stderr });
        },
      );
    });
}
