import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";

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

/** How long a stopped git gets to end before it is killed outright. */
const KILL_AFTER_MS = 5000;

/** Every process below `pid` (POSIX `ps`), deepest last; none when ps can't be run. */
function descendantsOf(pid: number): number[] {
  let text: string;
  try {
    text = execFileSync("ps", ["-A", "-o", "pid=,ppid="], {
      encoding: "utf8",
      timeout: 2000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [];
  }
  const kids = new Map<number, number[]>();
  for (const line of text.split("\n")) {
    const [p, pp] = line.trim().split(/\s+/).map(Number);
    if (!p || pp === undefined || Number.isNaN(pp)) continue;
    kids.set(pp, [...(kids.get(pp) ?? []), p]);
  }
  const out: number[] = [];
  const walk = (p: number) => {
    for (const k of kids.get(p) ?? []) {
      if (out.includes(k)) continue;
      out.push(k);
      walk(k);
    }
  };
  walk(pid);
  return out;
}

/**
 * Kill a process and everything it started: git clone runs git-remote-https and index-pack. On
 * Windows, taskkill /T takes the tree; elsewhere the git ran in its own process group, which is
 * signalled whole, and killed outright if it hasn't ended a moment later.
 */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      }).on("error", () => child.kill());
    } catch {
      child.kill();
    }
    return;
  }
  // Its descendants, found before any is killed (a killed parent's children are no longer its):
  // where a new process group can't be made (a sandbox), the group alone would miss them.
  const tree = [...descendantsOf(pid), pid];
  const signal = (s: NodeJS.Signals) => {
    try {
      process.kill(-pid, s);
    } catch {
      // no group of its own: each process below is signalled
    }
    for (const p of tree)
      try {
        process.kill(p, s);
      } catch {
        // gone already
      }
  };
  signal("SIGTERM");
  const hard = setTimeout(() => signal("SIGKILL"), KILL_AFTER_MS);
  hard.unref?.();
  child.once("exit", () => {
    // The group may outlive its leader a moment (a child still writing): it goes too.
    signal("SIGKILL");
    clearTimeout(hard);
  });
}

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
        killTree(child);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
}
