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

/** The real runner: the command through the platform shell (build commands are shell lines). */
export function shellCommandRunner(): CommandRunner {
  return (command, cwd, o = {}) =>
    new Promise((resolve) => {
      const child = spawn(command, {
        cwd,
        shell: true,
        env: { ...process.env, ...o.env },
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill(), o.timeoutMs ?? 30 * 60_000);
      child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
      child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ exitCode: null, stdout, stderr: stderr + e.message });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code, stdout, stderr });
      });
    });
}
