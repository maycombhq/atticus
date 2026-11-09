import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import type { Cancel, Cli, CliResult } from "./types";

/**
 * Running the `atticus` command line (ADR 0090). Arguments go to the process as they are, never
 * through a shell where it can be avoided: on Windows the `atticus.cmd` that npm or pnpm writes is
 * read for the `bin.js` it starts, and that file is run with `node`. Every command run and its
 * exit code go to the log (the "Atticus" output channel).
 */

export interface CliOptions {
  /** The setting atticus.path: a command on PATH, a full path, or a `.js` file. */
  atticusPath: string;
  /** The metarepo; commands run there. */
  cwd: string;
  /** The `node` that runs a `.js` atticus. Default `node` on PATH. */
  nodePath?: string;
  log?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/** How to start atticus: the program, the arguments that go before atticus's own, and whether a shell is needed. */
export interface Command {
  file: string;
  prefix: string[];
  shell: boolean;
}

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** The `.js` a Windows command shim starts, when the shim is npm's or pnpm's. */
export function shimTarget(cmdFile: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(cmdFile, "utf8");
  } catch {
    return undefined;
  }
  // npm's and pnpm's "%~dp0\node_modules\…\bin.js", or the offline bundle's "%~dp0..\<version>\dist\bin.js".
  const m = /"%~?dp0%?\\?([^"]*?\.[cm]?js)"/i.exec(text);
  if (!m) return undefined;
  const js = resolve(dirname(cmdFile), m[1]!.replace(/\\/g, "/"));
  return isFile(js) ? js : undefined;
}

/** Find a command on PATH (with PATHEXT on Windows). */
function onPath(name: string, env: NodeJS.ProcessEnv, win: boolean): string | undefined {
  // A PATH entry may be quoted ("C:\\Users\\dev\\AppData\\Roaming\\npm"), as cmd.exe reads it.
  const dirs = (env.PATH ?? env.Path ?? "")
    .split(delimiter)
    .map((d) => d.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
  const exts = win ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
  // On Windows a bare name is found with PATHEXT's extensions only, as Windows does: npm's
  // extensionless `atticus` beside atticus.cmd is a Git Bash script, which cmd can't run directly.
  const tries = win ? (/\.[a-z0-9]+$/i.test(name) ? [""] : exts.map((e) => e.toLowerCase())) : exts;
  for (const d of dirs)
    for (const e of tries) {
      const f = join(d, name + e);
      if (isFile(f)) return f;
    }
  return undefined;
}

export function resolveCommand(o: CliOptions): Command {
  const env = o.env ?? process.env;
  const win = (o.platform ?? process.platform) === "win32";
  const node = o.nodePath ?? "node";
  const p = o.atticusPath.trim() || "atticus";
  if (/\.[cm]?js$/i.test(p)) return { file: node, prefix: [resolve(o.cwd, p)], shell: false };
  if (!win) return { file: p, prefix: [], shell: false };
  const found = isAbsolute(p) || /[\\/]/.test(p) ? resolve(o.cwd, p) : onPath(p, env, true);
  if (found && /\.exe$/i.test(found)) return { file: found, prefix: [], shell: false };
  if (found && /\.(cmd|bat)$/i.test(found)) {
    const js = shimTarget(found);
    if (js) return { file: node, prefix: [js], shell: false };
    return { file: found, prefix: [], shell: true };
  }
  return { file: found ?? p, prefix: [], shell: true };
}

/** Characters cmd.exe reads as its own; an argument with one can't go through a shell safely. */
export const SHELL_UNSAFE = /["%^&|<>!\r\n]/;

/** An argument as a person types it in a terminal: bare when plain, else in double quotes. */
export const quoteArg = (a: string) =>
  /^[\w./:@=+-]+$/.test(a) ? a : `"${a.replace(/(["\\$`])/g, "\\$1")}"`;

/** The command line as the log shows it. */
export const commandText = (args: string[]) => `atticus ${args.map(quoteArg).join(" ")}`;

/** A program's path as a terminal takes it: bare when plain, else in double quotes (no escapes). */
const quotePath = (p: string) => (/^[\w./:\\@+-]+$/.test(p) ? p : `"${p}"`);

/**
 * Review round 46: the line typed into a terminal, starting with the atticus that atticus.path
 * resolves to (`node "<bin.js>" …`, or the program's path), not a bare `atticus`. PowerShell
 * (`shell`, VS Code's env.shell) runs a quoted program only after `&`.
 */
export function terminalLine(cmd: Command, args: string[], shell?: string): string {
  const program = quotePath(cmd.file);
  const call =
    program.startsWith('"') && /(^|[\\/])(pwsh|powershell)(\.exe)?$/i.test(shell ?? "")
      ? `& ${program}`
      : program;
  return [call, ...cmd.prefix.map(quotePath), ...args.map(quoteArg)].join(" ");
}

export function cliRunner(o: CliOptions): Cli {
  return (args: string[], token?: Cancel, input?: string) => runCli(o, args, token, input);
}

export function runCli(
  o: CliOptions,
  args: string[],
  token?: Cancel,
  input?: string,
): Promise<CliResult> {
  const log = o.log ?? (() => undefined);
  const cmd = resolveCommand(o);
  log(`> ${commandText(args)}`);
  if (cmd.shell && args.some((a) => SHELL_UNSAFE.test(a))) {
    const msg = `Couldn't run this through the Windows shell safely: an argument has one of " % ^ & | < > !. Set atticus.path to the atticus bin.js (for example C:\\...\\node_modules\\@maycombhq\\atticus\\dist\\bin.js).`;
    log(msg);
    log("exit 2");
    return Promise.resolve({ code: 2, stdout: "", stderr: msg, cancelled: false });
  }
  const argv = [...cmd.prefix, ...args].map((a) => (cmd.shell ? `"${a}"` : a));
  return new Promise((done) => {
    let stdout = "";
    let stderr = "";
    let cancelled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd.shell ? `"${cmd.file}"` : cmd.file, argv, {
        cwd: o.cwd,
        // ADR 0187: the app's Console says this run was started from VS Code.
        env: { ...(o.env ?? process.env), ATTICUS_STARTED_BY: "vscode" },
        shell: cmd.shell,
        windowsHide: true,
      });
    } catch (e) {
      const msg = `Couldn't start atticus (${cmd.file}): ${(e as Error).message}`;
      log(msg);
      log("exit 127");
      done({ code: 127, stdout: "", stderr: msg, cancelled: false });
      return;
    }
    const sub = token?.onCancellationRequested(() => {
      cancelled = true;
      // Elsewhere SIGTERM reaches atticus, which stops its builds and its assistant's session
      // and records the stop. Windows ends a process without telling it, and its children
      // (a build, headless Claude Code) would keep going: the whole tree is ended there.
      if (process.platform === "win32" && child.pid !== undefined) {
        const k = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        k.on("error", () => child.kill());
      } else child.kill();
    });
    // What the command reads on stdin (ADR 0110: history add); none closes it at once, so a
    // command that reads it never waits.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input ?? "", "utf8");
    child.stdout?.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr?.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", (e) => {
      stderr += `Couldn't start atticus (${cmd.file}): ${e.message}. Set atticus.path to the atticus command.`;
    });
    child.on("close", (code) => {
      sub?.dispose();
      const c = code ?? (cancelled ? 130 : 127);
      for (const l of stderr.trimEnd().split("\n").filter(Boolean)) log(l);
      log(cancelled ? `exit ${c} (cancelled)` : `exit ${c}`);
      done({ code: c, stdout, stderr, cancelled });
    });
  });
}

/** The one JSON object a command printed, or undefined when it printed none. */
export function parseJson<T>(stdout: string): T | undefined {
  const text = stdout.trim();
  for (const t of [text, text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)])
    try {
      if (t) return JSON.parse(t) as T;
    } catch {
      // try the next
    }
  return undefined;
}
