import { spawn } from "node:child_process";

/**
 * Runs a repo's build or test command (repos.manifest.yaml `build`). Injectable: tests pass a
 * fake, so no build tool runs in CI. Output is kept for the run's log.
 */
export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string,
  cwd: string,
  o?: { timeoutMs?: number; env?: Record<string, string> },
) => Promise<CommandResult>;

/** The most of each stream kept for the log: the end of it, where a build says what failed. */
export const KEEP_OUTPUT = 4 * 1024 * 1024;

/** Keeps the last `max` characters of what is added, saying how much was left out. */
export function tail(max = KEEP_OUTPUT) {
  let text = "";
  let dropped = 0;
  return {
    add(d: string) {
      text += d;
      if (text.length > max) {
        dropped += text.length - max;
        text = text.slice(text.length - max);
      }
    },
    get text() {
      return dropped ? `[${dropped} characters of output left out]\n${text}` : text;
    },
  };
}

/** The command and everything it started: on Windows the shell's whole tree, elsewhere its group. */
function stopTree(child: ReturnType<typeof spawn>) {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    const k = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    k.on("error", () => child.kill());
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill();
  }
}

/** The real runner: the command through the platform shell (build commands are shell lines). */
export function shellCommandRunner(): CommandRunner {
  return (command, cwd, o = {}) =>
    new Promise((resolve) => {
      const child = spawn(command, {
        cwd,
        shell: true,
        env: { ...process.env, ...o.env },
        windowsHide: true,
        // Its own process group off Windows, so a timeout stops the build, not only the shell.
        detached: process.platform !== "win32",
      });
      const out = tail();
      const err = tail();
      const timer = setTimeout(() => stopTree(child), o.timeoutMs ?? 30 * 60_000);
      // Its own group no longer hears the terminal's Ctrl+C: when Atticus stops, so does the build.
      const onExit = () => stopTree(child);
      process.once("exit", onExit);
      child.on("close", () => process.off("exit", onExit));
      child.stdout!.setEncoding("utf8").on("data", (d: string) => out.add(d));
      child.stderr!.setEncoding("utf8").on("data", (d: string) => err.add(d));
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ exitCode: null, stdout: out.text, stderr: err.text + e.message });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code, stdout: out.text, stderr: err.text });
      });
    });
}
