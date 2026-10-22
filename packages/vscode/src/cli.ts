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
  const m = /"%~?dp0%?\\([^"]*?\.[cm]?js)"/i.exec(text);
  if (!m) return undefined;
  const js = resolve(dirname(cmdFile), m[1]!);
  return isFile(js) ? js : undefined;
}

/** Find a command on PATH (with PATHEXT on Windows). */
function onPath(name: string, env: NodeJS.ProcessEnv, win: boolean): string | undefined {
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  const exts = win ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
  for (const d of dirs)
    for (const e of win ? ["", ...exts] : exts) {
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
const SHELL_UNSAFE = /["%^&|<>!\r\n]/;

/** An argument as a person types it in a terminal: bare when plain, else in double quotes. */
export const quoteArg = (a: string) =>
  /^[\w./:@=+-]+$/.test(a) ? a : `"${a.replace(/(["\\$`])/g, "\\$1")}"`;

/** The command line as the log shows it. */
export const commandText = (args: string[]) => `atticus ${args.map(quoteArg).join(" ")}`;

export function cliRunner(o: CliOptions): Cli {
  return (args: string[], token?: Cancel) => runCli(o, args, token);
}

export function runCli(o: CliOptions, args: string[], token?: Cancel): Promise<CliResult> {
  const log = o.log ?? (() => undefined);
  const cmd = resolveCommand(o);
  log(`> ${commandText(args)}`);
  if (cmd.shell && args.some((a) => SHELL_UNSAFE.test(a))) {
    const msg = `Couldn't run this through the Windows shell safely: an argument has one of " % ^ & | < > !. Set atticus.path to the atticus bin.js (for example C:\\...\\node_modules\\@maycombhq\\cli\\dist\\bin.js).`;
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
        env: o.env ?? process.env,
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
      child.kill();
    });
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
