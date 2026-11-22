import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import {
  changesDirOf,
  changesRelOf,
  redactText,
  runsDirOf,
  runsRelOf,
  stateDirOf,
  type AgentDefinition,
  type RunAssistant,
  type RunTools,
  type RuntimeKind,
  type StepClass,
  type ToolCallRecord,
} from "@maycombhq/core";
import {
  AcpClient,
  AcpRpcError,
  ACP_ERRORS,
  chunkText,
  isAuthRequired,
  UPDATE,
  usageOf,
  type AcpClientHandlers,
  type AcpToolCall,
  type AcpTransport,
  type PermissionOption,
} from "./acp.js";
import { DATA_RULE, estimateTokens } from "./context.js";
import { HandoffRuntime } from "./handoff.js";
import {
  claimRunDir,
  OneShotRuntime,
  RuntimeError,
  type AiRequest,
  type Run,
  type Usage,
} from "./runtime.js";
import { stepClassOf } from "./step-class.js";
import { isPersonsFactsFile, personOnlyWhy, withoutLegacy } from "./person-only.js";

/**
 * copilot-acp (C5, ADR 0171): GitHub Copilot driven unattended through the Copilot language
 * server's Agent Client Protocol mode. Atticus starts the server (`<command> --acp`, no shell
 * where the platform allows), is the protocol's client, and opens one new session per step, rooted
 * at the metarepo, with the text a person would otherwise paste into Copilot Chat. What the
 * session may do is fixed here and not configurable (rule 6):
 *
 * - read files under the metarepo and its clones;
 * - write only the step's own result paths (facts/ for a read, the result file of a hand-off);
 * - run a terminal command only when it is `atticus` with arguments (no shell, never what only a
 *   person may do: answering questions, `--approve`, `--accept`), refused with a message the
 *   agent sees;
 * - every permission the agent asks for outside that is refused; one inside it is allowed once,
 *   never "always".
 *
 * Atticus never handles a token: a server that isn't signed in stops the run with what it said.
 */

// ------------------------------------------------------------------ the command line

/** Words of one line, a double-quoted part kept whole (a Windows path with spaces). */
function words(line: string): { words: string[]; meta: boolean } {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | undefined;
  let any = false;
  let meta = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      any = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur || any) out.push(cur);
      cur = "";
      any = false;
      continue;
    }
    // A shell's words: Atticus runs no shell, so a line that needs one is refused.
    if ("|&;<>`$(){}\n".includes(ch)) meta = true;
    cur += ch;
  }
  if (cur || any) out.push(cur);
  return { words: out, meta: meta || quote !== undefined };
}

/** runtime.yaml's command as a program and its words, `--acp` added when it isn't there. */
export function commandLineOf(line: string): { command: string; args: string[] } {
  const w = words(line.trim()).words;
  if (!w.length) throw new RuntimeConfigLikeError("copilotAcp.command is empty");
  const args = w.slice(1);
  return { command: w[0]!, args: args.includes("--acp") ? args : [...args, "--acp"] };
}

class RuntimeConfigLikeError extends RuntimeError {}

/** The atticus commands a session may not run beyond a person's: what loops, servers, --root. */
const PERSONS: { test: (a: string[]) => boolean; why: string }[] = [
  // What only a person does is personOnlyWhy's list (person-only.ts), shared with the CLI.
  {
    test: (a) => a[0] === "map" && a.includes("--all"),
    why: "this session is one step of atticus map --all; Atticus runs the loop, not the session",
  },
  {
    test: (a) => ["ui", "serve", "mcp"].includes(a[0] ?? ""),
    why: "a server that keeps running isn't a step's command",
  },
  {
    test: (a) => a.some((x) => x === "--root" || x.startsWith("--root=")),
    why: "the session works in this metarepo; --root points elsewhere",
  },
];

const ATTICUS_NAMES = new Set(["atticus", "atticus.cmd", "atticus.exe"]);

/**
 * The arguments of an `atticus` command, from the agent's command and args (as argv, or one line
 * in `command`), or why it is refused. Only the bare program name: a path could be anything.
 */
export function atticusArgvOf(
  command: string,
  args: readonly string[] = [],
): { argv: string[]; refused?: undefined } | { argv?: undefined; refused: string } {
  const head = words(command.trim());
  if (head.meta)
    return {
      refused: `Atticus runs no shell here, so a command line with | & ; < > $ or backquotes is refused: ${short(command)}. Run one atticus command at a time.`,
    };
  const all = [...head.words, ...args];
  const program = all[0] ?? "";
  if (!ATTICUS_NAMES.has(program.toLowerCase()))
    return {
      refused: `Atticus runs only atticus commands in this session (atticus <command> <arguments>); ${short([program, ...all.slice(1)].join(" "))} is refused. Read files with your file tools; write only under facts/ or the step's result file.`,
    };
  const argv = all.slice(1);
  if (!argv.length)
    return { refused: "atticus needs a command (atticus next, atticus verify <repo>, ...)" };
  // `legacy <words>` is <words> (review round 46), as the CLI reads it
  const named = [...withoutLegacy(argv)];
  for (const p of PERSONS) if (p.test(named)) return { refused: `Refused: ${p.why}.` };
  // The command comes first, so what it is can't hide behind a flag and its value (after
  // `legacy` too: `legacy --mode x questions answer` runs `questions answer`).
  const hidden =
    argv[0] === "legacy" &&
    argv[1]?.startsWith("-") &&
    argv.slice(2).some((x) => !x.startsWith("-"));
  if (hidden || (argv[0]!.startsWith("-") && !["--help", "--version", "-h"].includes(argv[0]!)))
    return {
      refused: `Put the command first: atticus <command> [arguments] (got ${short(argv.join(" "))})`,
    };
  const person = personOnlyWhy(argv);
  if (person) return { refused: `Refused: ${person}; Atticus lets a session act as no one.` };
  return { argv };
}

const short = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ------------------------------------------------------------------ the rules for paths

/** What one session may read and write (fixed by the step, never by configuration). */
export interface AcpPolicy {
  /** Folders whose files it may read (the metarepo, its clones). */
  readRoots: string[];
  /** Folders under which it may write (facts/ for a read). */
  writeRoots: string[];
  /** Single files it may write (a hand-off's result file). */
  writeFiles?: string[];
  /**
   * The metarepo, which a refusal names paths relative to (else the first read root). ADR 0204's
   * second review: a find reads single files, so its first read root is no folder.
   */
  base?: string;
  /**
   * When set, the only atticus commands it may run, each by its first words (`verify`,
   * `catalog show`); none when empty: the step reads and writes files only (a find, ADR 0204 A.2).
   */
  commands?: readonly string[];
  /**
   * When set, its reads are narrowed to `readRoots` (single files, say), said in a refusal in these
   * words; and a search must say where, since an unnamed one searches the session's whole folder.
   */
  reads?: string;
}

/** The real path of p, or of its nearest folder that exists with the rest after it. */
function real(p: string): string {
  let cur = resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(cur), ...rest.reverse());
    } catch {
      const up = dirname(cur);
      if (up === cur) return resolve(p);
      rest.push(basename(cur));
      cur = up;
    }
  }
}

const sameOrUnder = (root: string, p: string) => {
  const r = relative(root, p);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};

const caseOf = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);

class Paths {
  private readonly reads: string[];
  private readonly writeDirs: string[];
  private readonly files: string[];
  constructor(private readonly p: AcpPolicy) {
    this.reads = p.readRoots.map((r) => caseOf(real(r)));
    this.writeDirs = p.writeRoots.map((r) => caseOf(real(r)));
    this.files = (p.writeFiles ?? []).map((f) => caseOf(real(f)));
  }
  readable(path: string): string | undefined {
    if (!path || !isAbsolute(path)) return `the path must be absolute (got ${short(path)})`;
    const r = caseOf(real(path));
    if (this.reads.some((x) => sameOrUnder(x, r))) return undefined;
    return this.p.reads !== undefined
      ? `Atticus lets this session read only ${this.p.reads}; ${short(this.rel(path))} is not one of them, so it is outside what it may read`
      : `Atticus lets this session read only under the metarepo and its clones; ${short(path)} is outside`;
  }
  /** A search that names no place searches the session's folder: refused when reads are narrowed. */
  searchable(): string | undefined {
    return this.p.reads !== undefined
      ? `Refused: a search must say where; this session reads only ${this.p.reads}`
      : undefined;
  }
  /** Whether the step lets the session run this atticus command (`commands`). */
  runnable(argv: readonly string[]): string | undefined {
    const allowed = this.p.commands;
    if (allowed === undefined) return undefined;
    if (!allowed.length)
      return "Atticus runs no command in this session: this step reads and writes files only. Read the files it names with your file tools.";
    const line = argv.join(" ");
    // The final review: by its words, each matched whole, never a text prefix of one argument.
    return allowed.some((c) => c.split(" ").every((w, i) => argv[i] === w))
      ? undefined
      : `Atticus runs only ${allowed.map((c) => `atticus ${c}`).join(", ")} in this session; atticus ${short(line)} is refused`;
  }
  /** A path as the agent names it: relative to the metarepo when under it. */
  rel(x: string): string {
    const base = this.p.base ?? this.p.readRoots[0] ?? "";
    const r = relative(base, x);
    return r && !r.startsWith("..") && !isAbsolute(r) ? r.split(sep).join("/") : x;
  }
  writable(path: string): string | undefined {
    if (!path || !isAbsolute(path)) return `the path must be absolute (got ${short(path)})`;
    const r = caseOf(real(path));
    if (r.split(sep).includes(".git"))
      return `Atticus never lets a session write in .git (${short(path)})`;
    // Final review: a name Windows would open as another (a trailing dot or space, a `:stream`)
    // is never written by a session, so no check can be passed by a name the file system rewrites.
    const parts = r.split(sep).slice(/^[A-Za-z]:$/.test(r.split(sep)[0] ?? "") ? 1 : 0);
    if (parts.some((x) => x !== "." && x !== ".." && (/[. ]$/.test(x) || x.includes(":"))))
      return `Atticus never lets a session write a name that ends in a dot or space or names a stream (${short(path)})`;
    // Review round 32: an audit's answers and a person's corrections are theirs to write.
    if (isPersonsFactsFile(basename(r)))
      return `Atticus never lets a session write a person's record (${short(path)}: an audit's answers or a person's corrections)`;
    if (this.files.includes(r) || this.writeDirs.some((x) => sameOrUnder(x, r))) return undefined;
    // Said relative to the metarepo, as the agent names its files.
    const dirs = this.p.writeRoots.map((d) => `${this.rel(d)}/`);
    const files = (this.p.writeFiles ?? []).map((f) => this.rel(f));
    const where = dirs.length
      ? `under ${[...dirs, ...files].join(", ")}`
      : files.length
        ? files.join(", ")
        : "nothing";
    return `Atticus lets this session write only its step's result: it writes only ${where}; ${short(this.p.base ? this.rel(path) : path)} is refused`;
  }
}

/** The read and write checks for a policy, as a session meets them. */
export const acpPathsOf = (p: AcpPolicy) => new Paths(p);

/** Under facts/ (the step's own result path), or only under it, as the message says. */
export const factsOnly = (root: string, factsDir: string): AcpPolicy => ({
  readRoots: readRootsOf(root),
  writeRoots: [factsDir],
});

/** Where a session may read: the metarepo and wherever its clones are. */
export function readRootsOf(root: string): string[] {
  const out = [root];
  const state = join(stateDirOf(root), "workspace");
  if (!sameOrUnder(resolve(root), resolve(state))) out.push(state);
  return out;
}

// ------------------------------------------------------------------ the server process

export interface AcpServer {
  transport: AcpTransport;
  stderr(): string;
  /** Ends the server: stdin closed, then killed if it lingers. */
  close(): Promise<void>;
  /** Rejects when the program couldn't be started at all. */
  started: Promise<void>;
  /** beta.28 review: how the process ended, once it has (its exit code or signal). */
  exited?(): { code: number | null; signal: string | null } | undefined;
  /**
   * beta.28.5: resolves once an ended process's last words are in `stderr()` (its pipes closed,
   * or a moment after it ended when something it started still holds them).
   */
  settled?(): Promise<void>;
}

/**
 * beta.28 review: whether a server ended the way Ctrl+C ends a process: by SIGINT, or on Windows
 * with STATUS_CONTROL_C_EXIT (0xC000013A, as an unsigned or a signed exit code). A console's
 * Ctrl+C reaches the server too, sometimes before Atticus hears its own: the person's stop.
 */
export function endedByCtrlC(e: { code: number | null; signal: string | null } | undefined) {
  return !!e && (e.signal === "SIGINT" || e.code === 0xc000013a || e.code === -1073741510);
}

/** Starts the server; tests can pass their own. */
export type AcpSpawner = (o: {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
}) => AcpServer;

/** On Windows a command that isn't an .exe or .com (npm's .cmd shims) runs only through cmd.exe. */
export const needsShell = (command: string, platform: NodeJS.Platform = process.platform) =>
  platform === "win32" && !/\.(exe|com)$/i.test(command);
export const quoteForCmd = (a: string) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);

/**
 * Ends a process and what it started. On Windows the server runs under cmd.exe (a .cmd shim):
 * killing cmd.exe would leave the language server running, so the whole tree goes, by taskkill.
 */
export function killTree(
  child: Pick<ChildProcess, "pid" | "kill">,
  platform: NodeJS.Platform = process.platform,
  run: typeof spawn = spawn,
): void {
  if (platform === "win32" && child.pid) {
    try {
      const k = run("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      k.on("error", () => child.kill());
      return;
    } catch {
      // No taskkill: the process itself, at least.
    }
  }
  child.kill();
}

/** The real server: the program with its words, stdio piped, no window; a shell only for a .cmd on Windows. */
export const spawnAcpServer: AcpSpawner = (o) => {
  const shell = needsShell(o.command);
  let child: ChildProcess;
  let err = "";
  let failed: (e: Error) => void = () => {};
  let ok: () => void = () => {};
  const started = new Promise<void>((res, rej) => {
    ok = res;
    failed = rej;
  });
  started.catch(() => undefined);
  try {
    child = spawn(
      shell ? quoteForCmd(o.command) : o.command,
      shell ? o.args.map(quoteForCmd) : o.args,
      { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell },
    );
  } catch (e) {
    failed(e as Error);
    const dead: AcpTransport = { send: () => {}, onLine: () => {}, onClose: (fn) => fn(String(e)) };
    return { transport: dead, stderr: () => "", close: async () => {}, started };
  }
  const lines: ((l: string) => void)[] = [];
  const closes: ((why: string) => void)[] = [];
  let closed: string | undefined;
  const close = (why: string) => {
    if (closed) return;
    closed = why;
    for (const f of closes) f(why);
  };
  child.on("spawn", () => ok());
  child.on("error", (e) => {
    failed(e);
    close(`the Copilot language server couldn't be run: ${e.message}`);
  });
  let exit: { code: number | null; signal: string | null } | undefined;
  let piped: () => void = () => {};
  const pipesClosed = new Promise<void>((res) => (piped = res));
  child.on("close", () => piped());
  child.on("exit", (code, signal) => {
    exit = { code, signal };
    close(`the Copilot language server ended (${code ?? signal ?? "no code"})`);
  });
  // beta.28.5: its output closed while it runs on: no answer can come. The exit, when that is
  // what closed it, is heard within the moment and named instead.
  child.stdout?.on("close", () => {
    const t = setTimeout(
      () => close("the Copilot language server closed its output and is still running"),
      500,
    );
    t.unref();
    closes.push(() => clearTimeout(t));
  });
  for (const s of [child.stdin, child.stdout, child.stderr]) s?.on("error", () => undefined);
  child.stderr?.setEncoding("utf8").on("data", (d: string) => {
    err = (err + d).slice(-64_000);
  });
  createInterface({ input: child.stdout! }).on("line", (l) => {
    for (const f of lines) f(l);
  });
  return {
    started,
    stderr: () => err,
    exited: () => exit,
    settled: () =>
      Promise.race([pipesClosed, new Promise<void>((res) => setTimeout(res, 400).unref())]),
    transport: {
      send: (t) => {
        if (!closed) child.stdin?.write(`${t}\n`);
      },
      onLine: (f) => lines.push(f),
      onClose: (f) => (closed ? f(closed) : closes.push(f)),
    },
    close: async () => {
      // Review of beta.28.5: only a process that has ended (or never ran) needs no ending. One
      // that closed its output and runs on is "closed" to the client and still has to go.
      if (exit || !child.pid) return;
      child.stdin?.end();
      await new Promise<void>((res) => {
        const t = setTimeout(() => {
          killTree(child);
          res();
        }, 2000);
        child.once("exit", () => {
          clearTimeout(t);
          res();
        });
      });
    },
  };
};

// ------------------------------------------------------------------ running atticus

/** Runs `atticus <argv>` for the session: no shell; what it prints comes back as it goes. */
export type AcpExec = (
  argv: string[],
  o: { cwd: string; signal: AbortSignal; onOutput?: (text: string) => void },
) => Promise<{ exitCode: number | null; output: string; signal?: string | null }>;

/**
 * The real one: the same Atticus that is running (node and its entry script), so the session runs
 * this version, with ATTICUS_ACP_SESSION set so a step it runs hands off instead of starting a
 * session of its own.
 */
export function atticusExec(entry: string, node = process.execPath): AcpExec {
  return (argv, o) =>
    new Promise((res) => {
      let output = "";
      const child = spawn(node, [entry, ...argv], {
        cwd: o.cwd,
        env: { ...process.env, ATTICUS_ACP_SESSION: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        signal: o.signal,
      });
      const take = (d: Buffer) => {
        const t = d.toString("utf8");
        output = (output + t).slice(-1_000_000);
        o.onOutput?.(t);
      };
      child.stdout.on("data", take);
      child.stderr.on("data", take);
      child.on("error", (e) => res({ exitCode: 1, output: `${output}${e.message}\n` }));
      child.on("close", (code, signal) => res({ exitCode: code, output, signal }));
    });
}

// ------------------------------------------------------------------ one session

export class AcpSignInError extends RuntimeError {
  constructor(message: string) {
    super(message);
    this.name = "AcpSignInError";
  }
}

/**
 * beta.17: the server didn't start, open a session or offer the model asked for: the same for
 * every part, so a run stops on it instead of trying each part twice.
 */
export class AcpSetupError extends RuntimeError {
  constructor(message: string) {
    super(message);
    this.name = "AcpSetupError";
  }
}

/**
 * beta.28: the server ended on its own while a session was under way (it crashed, or something
 * else ended it): no answer will come, so the run stops on it, saying so, rather than wait or try
 * the next part in a server that may end the same way.
 */
export class AcpServerGoneError extends RuntimeError {
  constructor(message: string) {
    super(message);
    this.name = "AcpServerGoneError";
  }
}

/** Why a session was cancelled when the person stopped it (Ctrl+C, or Stop in the app). */
export const STOPPED_BY_PERSON = "stopped (Ctrl+C)";

export interface AcpSessionOptions {
  /** runtime.yaml's copilotAcp.command. */
  command: string;
  /** The folder the session is rooted at: the metarepo. */
  cwd: string;
  prompt: string;
  policy: AcpPolicy;
  exec: AcpExec;
  model?: string;
  /** The most tool calls before the session is cancelled. */
  maxTurns?: number;
  timeoutMs?: number;
  /**
   * beta.28.5: how long the server has to start and answer `initialize`. Without it, the
   * environment's ATTICUS_COPILOT_START_TIMEOUT_MS, else 60 s (`startTimeoutOf`).
   */
  startTimeoutMs?: number;
  signal?: AbortSignal;
  /** Short progress lines for the console. */
  onProgress?: (line: string) => void;
  /** Where every message both ways is kept (JSON lines): the run's transcript. */
  transcript?: string;
  /** Extra environment for the server (tests). */
  env?: Record<string, string>;
  spawn?: AcpSpawner;
  clientVersion?: string;
  /**
   * beta.27: asked when the agent ends a turn of its own accord (not over a refusal, not
   * cancelled): text to send as its next prompt turn in the same session, or nothing to let the
   * session end. A read's run tells the session here what verify rejected and why. Asked at most
   * MAX_FOLLOW_UPS times.
   */
  followUp?: () => Promise<string | undefined>;
}

/** beta.27: how many follow-up turns (`followUp`) one session is given at most. */
export const MAX_FOLLOW_UPS = 2;

export interface AcpSessionResult {
  stopReason: string;
  /** Why Atticus cancelled it, when it did: "maxTurns 200", "timeout", "stopped". */
  stopped?: string;
  model?: string;
  assistant: RunAssistant;
  usage?: Usage;
  /** What the agent said, joined. */
  text: string;
  /** What Atticus did for the session, and what it refused. */
  toolCalls: ToolCallRecord[];
  refused: string[];
  /** The tool calls the agent reported. */
  agentToolCalls: number;
}

/** beta.16: how many times a session that ended right after a refusal is told to carry on. */
export const MAX_NUDGES = 3;

/**
 * beta.16: what a session that ended right after a refusal is told: what was refused and why,
 * and how to carry on without a shell.
 */
export function carryOnPrompt(
  refusals: readonly string[],
  o: { commands?: readonly string[] } = {},
): string {
  // ADR 0204's second review: a step that runs no command is never told one may be run.
  const commands =
    o.commands && !o.commands.length
      ? "Run no command: this step reads and writes files only. Read the files the step names with your own file tools; they need no shell."
      : "Use your own file tools to find, view and search files: they are allowed and need no shell. Don't run shell commands (cd, dir, Get-ChildItem, Select-String, Get-Content, grep, find); the only command Atticus runs is one `atticus ...` command at a time, with nothing piped or chained.";
  return [
    "Atticus refused this, and you are not finished yet:",
    ...refusals.slice(-3).map((r) => `- ${oneLine(r, 300)}`),
    "",
    `Carry on with the step. ${commands} The step says where its files are. Finish what the step asks for (the facts, or the result file it names), then stop.`,
  ].join("\n");
}

/** The usage of several prompts of one session, summed field by field where numeric. */
function sumUsage(us: readonly Record<string, unknown>[]): Record<string, unknown> | undefined {
  if (!us.length) return undefined;
  const out: Record<string, unknown> = {};
  for (const u of us)
    for (const [k, v] of Object.entries(u))
      out[k] = typeof v === "number" ? ((out[k] as number | undefined) ?? 0) + v : (out[k] ?? v);
  return out;
}

/** What the client offers, as kept in a run record's tools. */
export const ACP_OFFERED = [
  "fs/read_text_file",
  "fs/write_text_file",
  "terminal/create (atticus only)",
  "session/request_permission",
];

/** beta.28: what a wait raced against a cancel gives when the cancel came first. */
const CUT: unique symbol = Symbol("cut");

const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise<T>((res, rej) => {
    const t = setTimeout(
      () => rej(new RuntimeError(`${what} took over ${Math.round(ms / 1000)}s`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(t);
        res(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        rej(e);
      },
    );
  });

const oneLine = (s: string, n = 150) => short(s.replace(/\s+/g, " ").trim(), n);

/** The lines of the server's stderr worth showing a person signing in: links and codes. */
const signInLines = (stderr: string) =>
  stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /https?:\/\/|code|sign|log.?in|auth/i.test(l))
    .slice(-5);

// ------------------------------------------------------------------ starting the server

/** beta.28.5: the environment variable for how long the server has to start (milliseconds). */
export const START_TIMEOUT_ENV = "ATTICUS_COPILOT_START_TIMEOUT_MS";
export const START_TIMEOUT = { default: 60_000, min: 1_000, max: 30 * 60_000 } as const;

/**
 * beta.28.5: how long the server has to start and answer `initialize`: the environment's
 * ATTICUS_COPILOT_START_TIMEOUT_MS, else 60 s. A value that isn't a number of milliseconds within
 * the bounds is refused in words, rather than a run quietly waiting some other time.
 */
export function startTimeoutOf(env: Record<string, string | undefined> = process.env): number {
  const raw = env[START_TIMEOUT_ENV]?.trim();
  if (!raw) return START_TIMEOUT.default;
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(n >= START_TIMEOUT.min && n <= START_TIMEOUT.max))
    throw new AcpSetupError(
      `${START_TIMEOUT_ENV} is "${short(raw, 40)}": give it a whole number of milliseconds from ${START_TIMEOUT.min} to ${START_TIMEOUT.max} (how long the Copilot language server has to start; ${START_TIMEOUT.default} when it isn't set).`,
    );
  return n;
}

/** A line npm prints that is a warning or a notice: no error, but sometimes the only evidence. */
const isNpmWarning = (l: string) => /^npm (warn|notice)\b/i.test(l);
/** A line Node or npm prints that is no one's error: a warning, or where to trace it. */
const isWarningLine = (l: string) =>
  /^\(node:\d+\)\s.*Warning:/.test(l) ||
  /^\(Use `node --trace-[a-z-]+ \.\.\.` to show where/.test(l) ||
  isNpmWarning(l);

/**
 * beta.28.5: what the server printed on stderr, with Node's and npm's warnings set aside
 * (`(node:123) ExperimentalWarning: …` and its `(Use `node --trace-warnings ...` …)` line), so
 * the line that says what went wrong is the one a person is shown. Lines end \n or \r\n.
 */
export function serverWords(stderr: string): {
  lines: string[];
  warnings: number;
  /** npm's last warning or notice: quoted, as a warning, when nothing else was printed. */
  npmWarning?: string;
} {
  const all = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const lines = all.filter((l) => !isWarningLine(l));
  const npmWarning = all.findLast(isNpmWarning);
  return { lines, warnings: all.length - lines.length, ...(npmWarning ? { npmWarning } : {}) };
}

/** What a start that failed is told as: what happened, and what to do about it. */
export interface AcpStartProblem {
  /** What was seen, for a caller that must tell the cases apart (doctor): never the sentence. */
  kind: StartFailure["kind"];
  problem: string;
  advice: string;
}

const NPM_PACKAGE = "@github/copilot-language-server";
const INSTALL_ONCE = `install the server once (npm i -g ${NPM_PACKAGE}) and set command: copilot-language-server under copilotAcp in runtime.yaml`;
const isNpx = (command: string) =>
  /^npx(\.cmd|\.exe)?$/i.test(basename(command.replace(/\\/g, "/")));
const seconds = (ms: number) => `${Math.round(ms / 100) / 10}s`;
const shown = (a: string) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

/** What the server did as it failed to start. */
export type StartFailure =
  | { kind: "not-found"; why: string }
  | { kind: "spawn"; why: string }
  | { kind: "exited"; exit?: { code: number | null; signal: string | null }; why?: string }
  | { kind: "closed" }
  | { kind: "timeout"; ms: number }
  | { kind: "answered"; why: string };

/**
 * beta.28.5: a failed start in a person's words, from what was seen and nothing else: how the
 * process ended (or that it was still running), its own last words, and advice that fits, naming
 * the runtime.yaml line to change. `line` is copilotAcp.command as written; `command` and `args`
 * what was run.
 */
export function startProblemOf(o: {
  line: string;
  command: string;
  args: readonly string[];
  stderr: string;
  failure: StartFailure;
}): AcpStartProblem {
  const p = describeStart(o);
  return { kind: p.kind ?? o.failure.kind, problem: p.problem, advice: p.advice };
}

/** The program a shell said it didn't find, from cmd.exe's (English) or a shell's words. */
function programNotFound(text: string, exitCode: number | null | undefined): string | undefined {
  const cmd = /'([^']+)' is not recognized as an internal or external command/i.exec(text);
  if (cmd) return cmd[1];
  const sh = /(?:^|:\s)([^:\s]+): (command )?not found\s*$/im.exec(text);
  return sh && (sh[2] || exitCode === 127) ? sh[1] : undefined;
}
const programName = (p: string) =>
  basename(p.replace(/\\/g, "/"))
    .replace(/\.(cmd|exe|bat|com)$/i, "")
    .toLowerCase();

function describeStart(o: {
  line: string;
  command: string;
  args: readonly string[];
  stderr: string;
  failure: StartFailure;
}): { kind?: StartFailure["kind"]; problem: string; advice: string } {
  const { line, command, args } = o;
  // Review of beta.28.5: what is quoted reaches the run record and the app's events, so it is
  // redacted as the log is (a proxy's user:password@, tokens, the home folder).
  const f: StartFailure =
    "why" in o.failure && o.failure.why !== undefined
      ? ({ ...o.failure, why: redactText(o.failure.why) } as StartFailure)
      : o.failure;
  const heard = serverWords(redactText(o.stderr));
  const onlyWarnings = `printed nothing but warnings${heard.npmWarning ? `; its last warning was: ${short(heard.npmWarning, 300)}` : ""}`;
  const text = heard.lines.join("\n");
  const ran = [command, ...args].map(shown).join(" ");
  const check = `Check copilotAcp.command in runtime.yaml: run ${ran} yourself to see what it does.`;
  const notFound = (why: string) => ({
    kind: "not-found" as const,
    problem: `the program ${command} wasn't found on this machine (${why})`,
    advice: `Set copilotAcp.command in runtime.yaml to a program that is installed here, or to its full path (in double quotes when it has spaces).${isNpx(command) ? " npx comes with Node.js." : ""}`,
  });
  if (f.kind === "not-found") return notFound(f.why);
  if (f.kind === "spawn") return { problem: `it couldn't be run (${f.why})`, advice: check };
  if (f.kind === "answered")
    return { problem: `it answered initialize with an error: ${f.why}`, advice: check };
  if (f.kind === "timeout") {
    const had = heard.lines.length
      ? ` (it had said: ${short(heard.lines.slice(-3).join(" "), 300)})`
      : heard.warnings
        ? ` (it had ${onlyWarnings})`
        : "";
    const longer = `set the environment variable ${START_TIMEOUT_ENV} (milliseconds; 180000 is three minutes) and run again`;
    // The server may be waiting because it wants --stdio and didn't say so: only an exit that
    // asks for it is started again, so here it is said.
    const stdio = args.includes("--stdio")
      ? ""
      : ` If this server needs --stdio, add it to copilotAcp.command (command: ${line} --stdio).`;
    return {
      problem: `it was still running after ${seconds(f.ms)}, the limit for starting, and had not answered${had}`,
      advice: isNpx(command)
        ? `Atticus can't tell why from here. It may be npx fetching or checking the package on each start (slow through a proxy), or a slow first start. Either ${INSTALL_ONCE}, or give it longer: ${longer}. atticus doctor starts it the same way, without a session.${stdio}`
        : `Atticus can't tell why from here. It may be a slow first start, or it is waiting for something: run ${ran} yourself to see. To give it longer, ${longer}. Check copilotAcp.command in runtime.yaml; atticus doctor starts it the same way, without a session.${stdio}`,
    };
  }
  if (f.kind === "closed")
    return {
      problem: `it closed its output before it answered, and is still running${heard.lines.length ? ` (it said: ${short(heard.lines.slice(-3).join(" "), 300)})` : ""}`,
      advice: check,
    };
  // It ended. A shell that didn't find the program says so itself (cmd.exe exits 1, sh 127).
  // Review of beta.28.5: only when the program it names is copilotAcp.command's own: npx that
  // ran and didn't find what it runs is npx's failure, told in its words below.
  const absent = programNotFound(text, f.exit?.code);
  if (absent && programName(absent) === programName(command))
    return notFound(short(heard.lines[0] ?? "not found", 120));
  const how = f.exit
    ? f.exit.signal
      ? `ended by ${f.exit.signal}`
      : f.exit.code !== null
        ? `exit code ${f.exit.code}`
        : "no exit code"
    : (f.why ?? "no exit code");
  const npm = heard.lines.filter((l) => /^npm (error|ERR!)/i.test(l));
  // npm's last lines are where its log is: its first say what happened.
  const quoted = npm.length ? npm.slice(0, 2) : heard.lines.slice(-3);
  const said = quoted.length
    ? `said: ${short(quoted.join(" "), 300)}`
    : heard.warnings
      ? onlyWarnings
      : "printed nothing";
  const problem = `it ended before it answered (${how}) and ${said}`;
  const flagOf = (re: RegExp) => {
    const m = re.exec(text);
    return m
      ? { flag: /--[\w-]+/.exec(m[1]!)?.[0] ?? m[1]!.trim().split(/[\s,]+/)[0]!, raw: m[1]! }
      : undefined;
  };
  const required = flagOf(/required option\s+['"`]([^'"`]+)['"`]/i);
  if (required && !args.includes(required.flag))
    return {
      problem,
      advice: /[<[]/.test(required.raw)
        ? `It asks for the option ${required.flag}, with a value. Add it to copilotAcp.command in runtime.yaml.`
        : `It asks for the option ${required.flag}. Add it to copilotAcp.command in runtime.yaml (command: ${line} ${required.flag}).`,
    };
  const unknown = flagOf(/(?:unknown|unrecognized|bad) option:?\s+['"`]?(--?[\w-]+)/i);
  if (unknown?.flag === "--acp")
    return {
      problem,
      advice: `This program doesn't know --acp, the option that starts its Agent Client Protocol mode: it is a Copilot language server too old to have it, or another program. Check copilotAcp.command in runtime.yaml, and that ${shown(command)} --help lists --acp.`,
    };
  if (unknown) {
    const w = words(line.trim()).words;
    const without = line
      .trim()
      .split(/\s+/)
      .filter((x) => x !== unknown.flag)
      .join(" ");
    if (w.includes(unknown.flag))
      return {
        problem,
        advice: `It doesn't know the option ${unknown.flag}. Take it out of copilotAcp.command in runtime.yaml (command: ${without}).`,
      };
  }
  if (npm.length && isNpx(command))
    return {
      problem,
      advice: `npx couldn't fetch or run the package (npm's own error, above). Where this machine reaches npm through a proxy, ${INSTALL_ONCE}, so nothing is fetched at each start.`,
    };
  return { problem, advice: check };
}

/** beta.28.5: the server asked, in these words, for --stdio beside --acp. */
const asksForStdio = (stderr: string) =>
  /required option\s+['"`]--stdio['"`]/i.test(serverWords(stderr).lines.join("\n"));

export const STDIO_NOTE =
  "The Copilot language server asked for --stdio; started again with it. Add --stdio to copilotAcp.command in runtime.yaml to skip this.";

export const STDIO_FORGOT =
  "The Copilot language server, started with the --stdio it asked for earlier, ended; started again as copilotAcp.command has it.";

/**
 * beta.28.5: the commands that asked for --stdio and then answered with it, in this process, so
 * the next session of a run starts with it at once (a run starts the server once per part). Kept
 * per metarepo and command line, for as long as this process lives (a run, or the app's server),
 * and forgotten the moment a start that used it fails: what a server asked for once is not what
 * runtime.yaml says.
 */
const stdioAsked = new Set<string>();
const stdioKey = (cwd: string, line: string) => `${resolve(cwd)}\n${line.trim()}`;

/**
 * Review of beta.28.5: how long a new session has to open, for a run and for doctor alike: the
 * start limit, and never less than the two minutes a run always gave it.
 */
export const sessionOpenLimit = (startLimitMs: number) => Math.max(startLimitMs, 120_000);
/** Tests: what this process learned about starting servers is forgotten. */
export const forgetAcpStarts = () => stdioAsked.clear();

/** beta.28.5: a start that failed: an AcpSetupError that keeps what happened and what to do. */
export class AcpStartError extends AcpSetupError {
  constructor(
    line: string,
    readonly start: AcpStartProblem,
    readonly again?: string,
    /** It was started with the --stdio it asked for earlier in this process (now forgotten). */
    readonly remembered?: boolean,
  ) {
    super(
      `Atticus couldn't start the Copilot language server (${line}${again ? `, then with ${again} as it asked` : remembered ? ", with the --stdio it asked for earlier" : ""}): ${start.problem}. ${start.advice}`,
    );
    this.name = "AcpStartError";
  }
}

const TIMED_OUT: unique symbol = Symbol("timed out");

type AcpInit = Awaited<ReturnType<AcpClient["initialize"]>>;

/**
 * beta.28.5: the server started and `initialize` answered, for a run and for doctor alike. One
 * that ends, closes its output or can't be run fails at once with its own words; one still
 * running at the limit fails as slow. One that ended saying exactly that --stdio is required,
 * when the command hasn't it, is started once more with it (Atticus speaks to it over stdio
 * either way, and docs/guide/copilot-unattended.md says to add it): never a third time.
 */
async function startAcp(o: {
  line: string;
  cwd: string;
  env: Record<string, string | undefined>;
  spawn?: AcpSpawner | undefined;
  limitMs: number;
  /** A client for this server; called again for a second start. */
  connect: (server: AcpServer) => AcpClient;
  info: { name: string; version: string };
  /** Resolves when the person stopped it. */
  cut?: Promise<typeof CUT>;
  /** Whether the person has stopped it, asked before another server is started. */
  isCut?: () => boolean;
  say?: (line: string) => void;
}): Promise<
  | {
      server: AcpServer;
      client: AcpClient;
      init: AcpInit;
      command: string;
      args: string[];
      again?: string;
    }
  | typeof CUT
> {
  const parsed = commandLineOf(o.line);
  const command = parsed.command;
  let args = parsed.args;
  let again: string | undefined;
  const key = stdioKey(o.cwd, o.line);
  /** This start has the --stdio a server asked for earlier, which runtime.yaml doesn't. */
  let remembered = stdioAsked.has(key) && !args.includes("--stdio");
  /** A start with the remembered --stdio failed: it isn't added again in this call. */
  let dropped = false;
  if (remembered) args = [...args, "--stdio"];
  for (;;) {
    const server = (o.spawn ?? spawnAcpServer)({ command, args, cwd: o.cwd, env: o.env });
    const client = o.connect(server);
    let closed: string | undefined;
    server.transport.onClose((why) => (closed ??= why));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<typeof TIMED_OUT>((res) => {
      timer = setTimeout(() => res(TIMED_OUT), o.limitMs);
    });
    const hello = server.started.then(() => client.initialize(o.info));
    hello.catch(() => undefined);
    let failure: StartFailure;
    try {
      const r = await Promise.race([hello, limit, ...(o.cut ? [o.cut] : [])]);
      if (r === CUT) return CUT;
      if (r !== TIMED_OUT) {
        if (again) stdioAsked.add(key);
        return { server, client, init: r, command, args, ...(again ? { again } : {}) };
      }
      failure = { kind: "timeout", ms: o.limitMs };
    } catch (e) {
      await server.settled?.();
      const code = (e as NodeJS.ErrnoException)?.code;
      const exit = server.exited?.();
      if (code === "ENOENT") failure = { kind: "not-found", why: firstLine(e) };
      else if (exit) failure = { kind: "exited", exit };
      else if (closed !== undefined)
        failure = /still running/.test(closed)
          ? { kind: "closed" }
          : { kind: "exited", why: closed };
      else if (e instanceof AcpRpcError) failure = { kind: "answered", why: firstLine(e) };
      else failure = { kind: "spawn", why: firstLine(e) };
    } finally {
      clearTimeout(timer);
    }
    const stderr = server.stderr();
    await server.close().catch(() => undefined);
    // Review of beta.28.5: stopped while it failed: no other server is started for it.
    if (o.isCut?.()) return CUT;
    if (remembered) {
      // Whatever it asked for earlier, it didn't start with it now: forgotten, and when it
      // ended (rather than hung) it is started once as runtime.yaml has it.
      stdioAsked.delete(key);
      if (failure.kind === "exited") {
        remembered = false;
        dropped = true;
        args = parsed.args;
        o.say?.(STDIO_FORGOT);
        continue;
      }
    }
    if (
      failure.kind === "exited" &&
      !again &&
      !dropped &&
      !args.includes("--stdio") &&
      asksForStdio(stderr)
    ) {
      again = "--stdio";
      args = [...args, "--stdio"];
      o.say?.(STDIO_NOTE);
      continue;
    }
    throw new AcpStartError(
      o.line,
      startProblemOf({ line: o.line, command, args, stderr, failure }),
      again,
      remembered,
    );
  }
}

/**
 * One session, start to end: the server started, `initialize`, a new session rooted at `cwd`,
 * runtime.yaml's model asked for, the prompt sent, every request answered by the rules above, and
 * the server ended when the agent stops (or Atticus cancels it: maxTurns, the timeout, Ctrl+C).
 */
export async function runAcpSession(o: AcpSessionOptions): Promise<AcpSessionResult> {
  const { command } = commandLineOf(o.command);
  const named: RunAssistant = { name: basename(command).replace(/\.(cmd|exe)$/i, "") };
  // beta.28: stopped before it began: no server is started, nothing is asked.
  if (o.signal?.aborted) {
    o.onProgress?.(`  Stopping the session: ${STOPPED_BY_PERSON}.`);
    return {
      stopReason: "cancelled",
      stopped: STOPPED_BY_PERSON,
      assistant: named,
      text: "",
      toolCalls: [],
      refused: [],
      agentToolCalls: 0,
    };
  }
  // beta.17: set on the server too, so an atticus command Copilot runs in its own shell (not
  // through Atticus's terminal) knows it is inside a session and hands off instead of starting
  // a Copilot session of its own (a session within a session, waiting on itself).
  const env = { ...process.env, ...(o.env ?? {}), ATTICUS_ACP_SESSION: "1", ATTICUS_ROOT: o.cwd };
  // beta.28.5: read before anything is started, so a value that isn't one stops the run in words.
  const startLimit = o.startTimeoutMs ?? startTimeoutOf(env);
  /** The server now running: the second one, when the first asked for --stdio. */
  let running: AcpServer | undefined;
  const transcript: string[] = [];
  const paths = new Paths(o.policy);
  const calls: ToolCallRecord[] = [];
  const refused: string[] = [];
  const say = (l: string) => o.onProgress?.(short(l, 160));
  let text = "";
  let pendingText = "";
  let agentCalls = 0;
  /** beta.16: how much the agent had said when the last refusal came. */
  let textAtRefusal = 0;
  let cancelWhy: string | undefined;
  let sessionId: string | undefined;
  const abort = new AbortController();
  const flush = () => {
    if (pendingText.trim()) say(`  Copilot: ${oneLine(pendingText)}`);
    pendingText = "";
  };
  const record = (
    name: string,
    input: Record<string, unknown>,
    output: string,
    error?: boolean,
  ) => {
    calls.push({
      round: 1,
      name,
      input,
      output: short(output, 2000),
      tokens: estimateTokens(output),
      ...(error ? { error: true } : {}),
    });
    if (error) {
      textAtRefusal = text.length;
      refused.push(output);
      flush();
      say(`  Refused: ${oneLine(output, 140)}`);
    }
  };
  const refuse = (name: string, input: Record<string, unknown>, why: string): never => {
    record(name, input, why, true);
    throw new AcpRpcError(ACP_ERRORS.invalidParams, why);
  };

  // Terminals: one per atticus command the session runs.
  const terminals = new Map<
    string,
    {
      output: string;
      done: Promise<{ exitCode: number | null; signal: string | null }>;
      exit?: { exitCode: number | null; signal: string | null };
      kill: AbortController;
      limit?: number;
    }
  >();
  let tn = 0;

  const box: { client?: AcpClient } = {};
  // beta.28: what a wait for the server races, so a Stop while it starts (initialize, a new
  // session, the model) or between turns ends the session at once instead of after it.
  let heard: () => void = () => {};
  const cancelled = new Promise<typeof CUT>((r) => (heard = () => r(CUT)));
  const orCut = <T>(p: Promise<T>): Promise<T | typeof CUT> => {
    p.catch(() => undefined);
    return Promise.race([p, cancelled]);
  };
  // beta.28: the server ended (on its own, unless Atticus closed it after the session).
  let gone: string | undefined;
  const cancel = (why: string) => {
    if (cancelWhy) return;
    cancelWhy = why;
    heard();
    flush();
    say(`  Stopping the session: ${why}.`);
    if (sessionId) box.client?.cancel(sessionId);
    for (const t of terminals.values()) t.kill.abort();
  };

  const handlers: AcpClientHandlers = {
    async readTextFile(p) {
      const why = paths.readable(p.path);
      if (why) return refuse("fs/read_text_file", { path: p.path }, why);
      const all = await readFile(p.path, "utf8").catch((e: NodeJS.ErrnoException) => {
        throw new AcpRpcError(
          ACP_ERRORS.invalidParams,
          `${p.path} can't be read: ${e.code ?? e.message}`,
        );
      });
      let content = all;
      if (p.line !== undefined || p.limit !== undefined) {
        const lines = all.split("\n");
        const from = Math.max(0, (p.line ?? 1) - 1);
        content = lines.slice(from, p.limit !== undefined ? from + p.limit : undefined).join("\n");
      }
      record("fs/read_text_file", { path: p.path }, `${content.length} characters`);
      return { content };
    },
    async writeTextFile(p) {
      const why = paths.writable(p.path);
      if (why) return refuse("fs/write_text_file", { path: p.path }, why);
      await mkdir(dirname(p.path), { recursive: true });
      await writeFile(p.path, p.content, "utf8");
      record("fs/write_text_file", { path: p.path }, `${p.content.length} characters written`);
      return null;
    },
    async requestPermission(p) {
      const tc = p.toolCall;
      const why = permissionRefused(tc, paths);
      const pick = (kinds: string[]) =>
        kinds.map((k) => p.options.find((x: PermissionOption) => x.kind === k)).find(Boolean);
      const allow = why ? undefined : pick(["allow_once"]);
      const input = {
        kind: tc.kind ?? "",
        title: tc.title ?? "",
        ...(tc.locations?.length ? { locations: tc.locations.map((l) => l.path) } : {}),
      };
      if (allow) {
        record(`permission:${tc.kind ?? "other"}`, input, `allowed once: ${tc.title ?? ""}`);
        return { outcome: { outcome: "selected", optionId: allow.optionId } };
      }
      record(
        `permission:${tc.kind ?? "other"}`,
        input,
        why ?? "Refused: the server offered only to allow it always; Atticus allows once at a time",
        true,
      );
      const reject = pick(["reject_once", "reject_always"]);
      return reject
        ? { outcome: { outcome: "selected", optionId: reject.optionId } }
        : { outcome: { outcome: "cancelled" } };
    },
    async terminalCreate(p) {
      const a = atticusArgvOf(p.command, p.args ?? []);
      const input = { command: p.command, args: p.args ?? [] };
      if (a.refused !== undefined) return refuse("terminal/create", input, a.refused);
      const not = paths.runnable(a.argv);
      if (not !== undefined) return refuse("terminal/create", input, not);
      // beta.17: an atticus command runs in the metarepo whatever folder the session names (run
      // from a repo's checkout, it would find no metarepo there).
      const cwd = o.cwd;
      const id = `atticus-${++tn}`;
      const kill = new AbortController();
      flush();
      say(`  atticus ${oneLine(a.argv.join(" "), 140)}`);
      const t = {
        output: "",
        kill,
        ...(p.outputByteLimit ? { limit: p.outputByteLimit } : {}),
      } as {
        output: string;
        done: Promise<{ exitCode: number | null; signal: string | null }>;
        exit?: { exitCode: number | null; signal: string | null };
        kill: AbortController;
        limit?: number;
      };
      t.done = o
        .exec(a.argv, {
          cwd,
          signal: kill.signal,
          onOutput: (s) => {
            t.output += s;
            if (t.limit && Buffer.byteLength(t.output) > t.limit)
              t.output = t.output.slice(-t.limit);
          },
        })
        .then((r) => {
          // An exec that hands everything back at the end (tests) gives its output here.
          if (!t.output && r.output) t.output = r.output;
          t.exit = { exitCode: r.exitCode, signal: r.signal ?? null };
          record(
            "terminal/create",
            input,
            `exit ${r.exitCode ?? "none"}: ${short(t.output, 1500)}`,
          );
          return t.exit;
        });
      terminals.set(id, t);
      return { terminalId: id };
    },
    async terminalOutput(p) {
      const t = terminals.get(p.terminalId);
      if (!t) throw new AcpRpcError(ACP_ERRORS.invalidParams, `no terminal ${p.terminalId}`);
      return { output: t.output, truncated: false, ...(t.exit ? { exitStatus: t.exit } : {}) };
    },
    async terminalWaitForExit(p) {
      const t = terminals.get(p.terminalId);
      if (!t) throw new AcpRpcError(ACP_ERRORS.invalidParams, `no terminal ${p.terminalId}`);
      return t.done;
    },
    async terminalKill(p) {
      terminals.get(p.terminalId)?.kill.abort();
      return null;
    },
    async terminalRelease(p) {
      const t = terminals.get(p.terminalId);
      t?.kill.abort();
      terminals.delete(p.terminalId);
      return null;
    },
    update(u) {
      const kind = u.sessionUpdate;
      if (kind === UPDATE.message) {
        const t = chunkText(u);
        if (t) {
          text += t;
          pendingText += t;
        }
      } else if (kind === UPDATE.toolCall) {
        agentCalls++;
        flush();
        say(`  · ${oneLine(String(u.title ?? u.kind ?? "a tool"), 140)}`);
        if (o.maxTurns !== undefined && agentCalls > o.maxTurns) cancel(`maxTurns ${o.maxTurns}`);
      } else if (kind === UPDATE.plan) {
        const n = Array.isArray(u.entries) ? u.entries.length : 0;
        if (n) say(`  Plan: ${n} steps`);
      }
    },
  };
  const connect = (s: AcpServer) => {
    running = s;
    gone = undefined;
    s.transport.onClose((why) => {
      if (running === s) gone ??= why;
    });
    box.client = new AcpClient(s.transport, handlers, (dir, m) =>
      transcript.push(JSON.stringify({ dir, m })),
    );
    return box.client;
  };

  const onAbort = () => cancel(STOPPED_BY_PERSON);
  o.signal?.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** beta.28: the session cut before its prompt was answered: nothing more is asked. */
  const cut = (assistant: RunAssistant, model?: string): AcpSessionResult => {
    flush();
    return {
      stopReason: "cancelled",
      stopped: cancelWhy ?? STOPPED_BY_PERSON,
      ...(model ? { model } : {}),
      assistant,
      text,
      toolCalls: calls,
      refused,
      agentToolCalls: agentCalls,
    };
  };
  try {
    // beta.28.5: one that ends or can't be run fails at once, in its own words (startAcp).
    const up = await startAcp({
      line: o.command,
      cwd: o.cwd,
      env,
      spawn: o.spawn,
      limitMs: startLimit,
      connect,
      info: { name: "atticus", version: o.clientVersion ?? "2" },
      cut: cancelled,
      isCut: () => cancelWhy !== undefined,
      say: (l) => o.onProgress?.(l),
    });
    if (up === CUT) return cut(named);
    const { server, client, init } = up;
    const assistant: RunAssistant = {
      name: init.agentInfo?.name ?? basename(command).replace(/\.(cmd|exe)$/i, ""),
      ...(init.agentInfo?.version ? { version: init.agentInfo.version } : {}),
      ...(typeof init.protocolVersion === "number"
        ? { protocolVersion: init.protocolVersion }
        : {}),
    };
    let ns;
    try {
      const n = await orCut(
        withTimeout(
          client.newSession(o.cwd),
          sessionOpenLimit(startLimit),
          "Opening a Copilot session",
        ),
      );
      if (n === CUT) return cut(assistant);
      ns = n;
    } catch (e) {
      if (isAuthRequired(e)) {
        await new Promise((r) => setTimeout(r, 150));
        throw signInError(e, init, server.stderr());
      }
      throw new AcpSetupError(`The Copilot language server didn't open a session: ${firstLine(e)}`);
    }
    sessionId = ns.sessionId;
    let model = ns.models?.currentModelId;
    if (o.model && o.model !== model) {
      const offered = (ns.models?.availableModels ?? []).map((m) => m.modelId);
      if (!offered.includes(o.model))
        throw new AcpSetupError(
          `The Copilot language server doesn't offer the model ${o.model} (it offers ${offered.join(", ") || "no list"}): change copilotAcp.model in runtime.yaml, or leave it out for Copilot's own.`,
        );
      if ((await orCut(client.setModel(sessionId, o.model))) === CUT) return cut(assistant, model);
      model = o.model;
    }
    say(
      `  Copilot session open (${assistant.name}${assistant.version ? ` ${assistant.version}` : ""}${model ? `, ${model}` : ""}).`,
    );
    if (o.signal?.aborted) cancel(STOPPED_BY_PERSON);
    if (cancelWhy) return cut(assistant, model);
    timer = setTimeout(() => cancel("timeout"), o.timeoutMs ?? 30 * 60_000);
    // beta.16: Copilot ends its turn when a permission is refused ("Operation cancelled by
    // user"), often with the step half done. While it ended right after a refusal, it is told why
    // and how to go on (its own file tools, no shell), in the same session, a few times at most.
    let prompt = o.prompt;
    let answer: { stopReason: string; usage?: Record<string, unknown> } = {
      stopReason: "end_turn",
    };
    const usages: Record<string, unknown>[] = [];
    let followUps = 0;
    // Review of fix/b27-copilot: counted only when a nudge is sent, so a follow-up turn
    // (followUp) leaves a refusal its MAX_NUDGES.
    let nudge = 0;
    let turns = 0;
    for (;;) {
      // beta.28: cancelled between turns (while the step had more to say): nothing more is asked.
      if (cancelWhy) {
        answer = { stopReason: "cancelled" };
        break;
      }
      // beta.28 review: the server ended after a turn it answered: the session ended there, and
      // the step verifies what it wrote; there is no one left to tell more.
      if (gone && turns > 0) break;
      const before = refused.length;
      const asked = client.prompt(sessionId, prompt);
      turns++;
      try {
        answer = await new Promise((res, rej) => {
          asked.then(res, rej);
          // Once cancelled, the agent has a few seconds to say so before the server is ended:
          // five when the person stopped it, ten for the time or the tool calls.
          let grace: ReturnType<typeof setTimeout> | undefined;
          const watch = setInterval(() => {
            if (!cancelWhy) return;
            clearInterval(watch);
            grace = setTimeout(
              () => res({ stopReason: "cancelled" }),
              cancelWhy === STOPPED_BY_PERSON ? 5_000 : 10_000,
            );
          }, 50);
          asked
            .finally(() => {
              clearInterval(watch);
              clearTimeout(grace);
            })
            .catch(() => undefined);
        });
      } catch (e) {
        if (isAuthRequired(e)) throw signInError(e, init, server.stderr());
        // beta.28 review: a console's Ctrl+C reaches the server too, and may end it before the
        // signal is heard here: ended by Ctrl+C, or the signal heard a moment later, it is the
        // person's stop.
        if (gone && !cancelWhy) {
          if (endedByCtrlC(server.exited?.())) cancel(STOPPED_BY_PERSON);
          else {
            await new Promise((res) => setTimeout(res, 100));
            if (o.signal?.aborted) cancel(STOPPED_BY_PERSON);
          }
        }
        // Cancelled, and the server ended with it: the session was stopped, not failed.
        if (cancelWhy) {
          answer = { stopReason: "cancelled" };
          break;
        }
        if (gone && /still running/.test(gone))
          throw new AcpServerGoneError(
            `The Copilot language server closed its output during the session and is still running${tail(server.stderr())}. Nothing more can come from it, so Atticus ended it.`,
          );
        if (gone)
          throw new AcpServerGoneError(
            `The Copilot language server ended on its own during the session (${gone})${tail(server.stderr())}. Nothing more can come from it: Copilot may have crashed, been signed out or been ended by something else.`,
          );
        throw new RuntimeError(
          `The Copilot session failed: ${firstLine(e)}${tail(server.stderr())}`,
        );
      }
      flush();
      if (answer.usage) usages.push(answer.usage);
      const fresh = refused.slice(before);
      // Ended over the refusal: it was the session's last call, and all it said after was that
      // it was cancelled (or nothing).
      const after = text.slice(textAtRefusal);
      const overIt =
        fresh.length > 0 &&
        !!calls.at(-1)?.error &&
        (!after.trim() || /cancel|refused|not allowed|can'?t|cannot|couldn'?t|unable/i.test(after));
      // Ended by the agent (a refused permission can come back as its own "cancelled"), never by
      // Atticus (cancelWhy: Ctrl+C, the time or the tool calls ran out).
      if (!cancelWhy && !overIt && answer.stopReason === "end_turn" && followUps < MAX_FOLLOW_UPS) {
        // beta.27: the turn ended of the agent's accord: the step may have more to tell it (what
        // verify rejected and why), in the same session. The step says so in its own words.
        const more = await o.followUp?.().catch(() => undefined);
        if (more) {
          followUps++;
          prompt = more;
          continue;
        }
      }
      if (
        cancelWhy ||
        !overIt ||
        nudge >= MAX_NUDGES ||
        !["end_turn", "cancelled"].includes(answer.stopReason)
      )
        break;
      nudge++;
      say(
        `  Atticus: told Copilot why that was refused and to carry on (${nudge} of ${MAX_NUDGES}).`,
      );
      prompt = carryOnPrompt(fresh, {
        ...(o.policy.commands ? { commands: o.policy.commands } : {}),
      });
    }
    const usage = usageOf(sumUsage(usages));
    return {
      stopReason: cancelWhy ? "cancelled" : answer.stopReason,
      ...(cancelWhy ? { stopped: cancelWhy } : {}),
      ...(model ? { model } : {}),
      assistant,
      ...(usage ? { usage } : {}),
      text,
      toolCalls: calls,
      refused,
      agentToolCalls: agentCalls,
    };
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener("abort", onAbort);
    abort.abort();
    for (const t of terminals.values()) t.kill.abort();
    await running?.close().catch(() => undefined);
    if (o.transcript) {
      await mkdir(dirname(o.transcript), { recursive: true });
      await writeFile(
        o.transcript,
        transcript.join("\n") + (transcript.length ? "\n" : ""),
        "utf8",
      );
    }
  }
}

const firstLine = (e: unknown) => String((e as Error)?.message ?? e).split("\n")[0]!;
// beta.28.5: Node's warnings set aside, so a warning is never quoted as what went wrong.
const tail = (stderr: string) => {
  const l = serverWords(redactText(stderr)).lines.slice(-2).join(" ").trim();
  return l ? ` (it said: ${short(l, 300)})` : "";
};

function signInError(
  e: unknown,
  init: { authMethods?: { name?: string; description?: string | null }[] },
  stderr: string,
): AcpSignInError {
  const how = (init.authMethods ?? [])
    .map((m) => m.description || m.name)
    .filter(Boolean)
    .join("; ");
  const lines = signInLines(stderr);
  return new AcpSignInError(
    [
      `GitHub Copilot isn't signed in here, so the run stopped. The Copilot language server said: ${firstLine(e)}`,
      ...(lines.length ? [`It also said: ${lines.join(" ")}`] : []),
      ...(how ? [`Its ways to sign in: ${how}.`] : []),
      "Sign in yourself (Copilot's sign-in in your editor, or the link and code above), then run the command again. Atticus never enters or keeps your credentials.",
    ].join("\n"),
  );
}

/** Why a permission the agent asks for is refused, or undefined when the rules allow it. */
function permissionRefused(tc: AcpToolCall, paths: Paths): string | undefined {
  const locs = (tc.locations ?? []).map((l) => l.path);
  switch (tc.kind) {
    case "think":
      return undefined;
    case "read":
    case "search": {
      if (!locs.length)
        return tc.kind === "search"
          ? paths.searchable()
          : "Refused: a read must say which file (use fs/read_text_file)";
      for (const l of locs) {
        const why = paths.readable(l);
        if (why) return why;
      }
      return undefined;
    }
    case "edit": {
      if (!locs.length) return "Refused: an edit must say which file it changes";
      for (const l of locs) {
        const why = paths.writable(l);
        if (why) return why;
      }
      return undefined;
    }
    case "execute": {
      const raw = (tc.rawInput ?? {}) as {
        command?: unknown;
        args?: unknown;
        commandLine?: unknown;
      };
      const cmd =
        typeof raw.command === "string"
          ? raw.command
          : typeof raw.commandLine === "string"
            ? raw.commandLine
            : (tc.title ?? "");
      const args = Array.isArray(raw.args) ? raw.args.map(String) : [];
      const a = atticusArgvOf(cmd, args);
      return a.refused ?? paths.runnable(a.argv);
    }
    default:
      return `Refused: Atticus doesn't let this session ${tc.kind ?? "do"} ${short(tc.title ?? "that")} (it may read the metarepo, write its step's result and run atticus commands)`;
  }
}

// ------------------------------------------------------------------ atticus doctor

export interface CopilotAcpProbe {
  found: boolean;
  version?: string;
  /** Undefined when the server didn't say either way. */
  signedIn?: boolean;
  /** What the server said, when it isn't signed in or the handshake failed. */
  said?: string;
  /** beta.28.5: the server didn't start: what happened and what to do, in a run's own words. */
  start?: AcpStartProblem;
  /** beta.28.5: something a person should know of a start that worked (it asked for --stdio). */
  note?: string;
}

/**
 * `atticus doctor`'s look (ADR 0171): `<command> --version`, then the handshake alone
 * (initialize and a new session, no prompt, so nothing runs and no tokens are spent). The server
 * is started as a run starts it (startAcp: the same command, start limit and second start with
 * --stdio), so what stops a run is what doctor says.
 */
export async function copilotAcpProbe(o: {
  command: string;
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  spawn?: AcpSpawner;
}): Promise<CopilotAcpProbe> {
  const { command, args } = commandLineOf(o.command);
  const plain = args.filter((a) => a !== "--acp");
  const env = { ...process.env, ...(o.env ?? {}) };
  let limit: number;
  try {
    limit = o.timeoutMs ?? startTimeoutOf(env);
  } catch (e) {
    const said = firstLine(e);
    return {
      found: false,
      said,
      start: {
        kind: "spawn",
        problem: said,
        advice: `Set ${START_TIMEOUT_ENV} to a number of milliseconds, or unset it.`,
      },
    };
  }
  const failed = (failure: StartFailure, stderr: string) =>
    startProblemOf({ line: o.command, command, args: [...plain, "--version"], stderr, failure });
  const version = await new Promise<
    | { ok: true; text: string }
    | { ok: false; text: string; missing?: AcpStartProblem; slow?: AcpStartProblem }
  >((res) => {
    const shell = needsShell(command);
    let out = "";
    let err = "";
    let timedOut = false;
    let child: ChildProcess;
    try {
      child = spawn(
        shell ? quoteForCmd(command) : command,
        [...(shell ? plain.map(quoteForCmd) : plain), "--version"],
        {
          cwd: o.cwd,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          shell,
        },
      );
    } catch (e) {
      res({
        ok: false,
        text: (e as Error).message,
        missing: failed({ kind: "spawn", why: firstLine(e) }, ""),
      });
      return;
    }
    const t = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, limit);
    child.stdout?.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr?.on("data", (d: Buffer) => (err += d.toString("utf8")));
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(t);
      res({
        ok: false,
        text: e.message,
        ...(e.code === "ENOENT"
          ? { missing: failed({ kind: "not-found", why: firstLine(e) }, "") }
          : {}),
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(t);
      if (code === 0) return res({ ok: true, text: out.trim() });
      if (timedOut)
        return res({ ok: false, text: err, slow: failed({ kind: "timeout", ms: limit }, err) });
      // A shell says "not found" with exit 1 or 9009 rather than ENOENT.
      const p = failed({ kind: "exited", exit: { code, signal } }, err);
      res({
        ok: false,
        text: serverWords(`${out}\n${err}`).lines.join(" "),
        ...(p.kind === "not-found" ? { missing: p } : {}),
      });
    });
  });
  if (!version.ok && version.missing)
    return { found: false, said: version.missing.problem, start: version.missing };
  if (!version.ok && version.slow) return { found: true, start: version.slow };
  // beta.28.5: a --version that failed some other way says little: the handshake says more.
  const v = version.ok
    ? version.text
        .split(/\r?\n/)
        .find((l) => l.trim())
        ?.trim()
    : undefined;
  const handlers: AcpClientHandlers = {
    readTextFile: () =>
      Promise.reject(new AcpRpcError(ACP_ERRORS.invalidParams, "doctor reads nothing")),
    writeTextFile: () =>
      Promise.reject(new AcpRpcError(ACP_ERRORS.invalidParams, "doctor writes nothing")),
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    terminalCreate: () =>
      Promise.reject(new AcpRpcError(ACP_ERRORS.invalidParams, "doctor runs nothing")),
    terminalOutput: () => Promise.reject(new AcpRpcError(ACP_ERRORS.invalidParams, "no terminal")),
    terminalWaitForExit: () =>
      Promise.reject(new AcpRpcError(ACP_ERRORS.invalidParams, "no terminal")),
    terminalKill: async () => null,
    terminalRelease: async () => null,
    update: () => {},
  };
  const base = { found: true, ...(v ? { version: v } : {}) };
  let running: AcpServer | undefined;
  let note: string | undefined;
  try {
    const up = await startAcp({
      line: o.command,
      cwd: o.cwd,
      env,
      spawn: o.spawn,
      limitMs: limit,
      connect: (s) => {
        running = s;
        return new AcpClient(s.transport, handlers);
      },
      info: { name: "atticus-doctor", version: "2" },
      say: (l) => (note = l),
    });
    if (up === CUT) return base;
    const { server, client } = up;
    const noted = note ? { note } : {};
    try {
      await withTimeout(client.newSession(o.cwd), sessionOpenLimit(limit), "a new session");
      return { ...base, ...noted, signedIn: true };
    } catch (e) {
      if (isAuthRequired(e)) {
        await new Promise((r) => setTimeout(r, 150));
        const lines = signInLines(server.stderr());
        return { ...base, ...noted, signedIn: false, said: [firstLine(e), ...lines].join(" ") };
      }
      return { ...base, ...noted, said: firstLine(e) };
    }
  } catch (e) {
    if (e instanceof AcpStartError) {
      const missing = e.start.kind === "not-found";
      return { ...(missing ? { found: false } : base), said: e.start.problem, start: e.start };
    }
    return { ...base, said: `the --acp handshake failed: ${firstLine(e)}` };
  } finally {
    await running?.close().catch(() => undefined);
  }
}

// ------------------------------------------------------------------ the runtime (C5)

export interface CopilotAcpOptions {
  root: string;
  command: string;
  model?: string;
  maxTurns?: number;
  timeoutMs?: number;
  exec?: AcpExec;
  spawn?: AcpSpawner;
  env?: Record<string, string>;
  onProgress?: (line: string) => void;
  clientVersion?: string;
  now?: () => Date;
  validate?: (output: string, request: AiRequest) => Promise<string[]>;
}

/**
 * copilot-acp as a runtime (C5): a step's hand-off prompt, run in one new Copilot session rooted at
 * the metarepo. The session may write only the step's result file; the output is that file when
 * the session wrote it, else what the agent said. An agent that allows hand-off allows this mode
 * too (it runs what hand-off would hand to Copilot); one may also list copilot-acp itself.
 */
export class CopilotAcpRuntime extends OneShotRuntime {
  readonly kind: RuntimeKind = "copilot-acp";

  constructor(private readonly c: CopilotAcpOptions) {
    super({ ...(c.now ? { now: c.now } : {}), ...(c.validate ? { validate: c.validate } : {}) });
  }

  protected override allowedAs(agent: AgentDefinition): RuntimeKind {
    return agent.allowedRuntimes.includes("copilot-acp") ? "copilot-acp" : "hand-off";
  }

  protected override modelFor(): string | undefined {
    return this.c.model;
  }

  /** Review round 48: the run's folder is claimed, as a model run's is (claimRunDir). */
  protected override async newRunId(request: AiRequest, now: Date): Promise<string> {
    return claimRunDir(join(runsDirOf(this.c.root), request.change), () => this.nextRunId(now));
  }

  protected async produce(run: Run, signal?: AbortSignal) {
    const { request } = run;
    const root = this.c.root;
    const dir = join(runsDirOf(root), request.change, run.runId);
    await mkdir(dir, { recursive: true });
    const outRel = HandoffRuntime.outputRel(run, changesRelOf(root), runsRelOf(root));
    const prompt =
      HandoffRuntime.promptFor(run, changesRelOf(root), runsRelOf(root)).replace(
        /\nWhen the file is complete.*\n$/s,
        "\n",
      ) +
      (request.selfCheck
        ? `\nBefore you finish, check the file: run ${request.selfCheck.command} ${outRel}. Fix each problem it lists and run it again, until it says the file is clean (at most ${request.selfCheck.limit} times).\n`
        : "") +
      `\n${DATA_RULE}\n`;
    await writeFile(join(dir, "prompt.md"), prompt, "utf8");
    await writeFile(
      join(dir, "context-manifest.json"),
      JSON.stringify(request.pack.manifest, null, 2) + "\n",
      "utf8",
    );
    const outputFile =
      request.outputIn === "run"
        ? join(dir, request.outputPath)
        : join(changesDirOf(root), request.change, request.outputPath);
    const before = (await stat(outputFile).catch(() => undefined))?.mtimeMs;
    const r = await runAcpSession({
      command: this.c.command,
      cwd: root,
      prompt,
      policy: { readRoots: readRootsOf(root), writeRoots: [], writeFiles: [outputFile] },
      exec: this.c.exec ?? noExec,
      ...(this.c.model ? { model: this.c.model } : {}),
      ...(this.c.maxTurns ? { maxTurns: this.c.maxTurns } : {}),
      ...(this.c.timeoutMs ? { timeoutMs: this.c.timeoutMs } : {}),
      ...(signal ? { signal } : {}),
      ...(this.c.onProgress ? { onProgress: this.c.onProgress } : {}),
      ...(this.c.env ? { env: this.c.env } : {}),
      ...(this.c.spawn ? { spawn: this.c.spawn } : {}),
      ...(this.c.clientVersion ? { clientVersion: this.c.clientVersion } : {}),
      transcript: join(dir, "transcript.jsonl"),
    });
    const after = (await stat(outputFile).catch(() => undefined))?.mtimeMs;
    const written =
      after !== undefined && after !== before ? await readFile(outputFile, "utf8") : undefined;
    const tools: RunTools = {
      offered: ACP_OFFERED,
      calls: r.toolCalls,
      ...(r.stopped ? { stopped: r.stopped } : {}),
    };
    if (written === undefined && r.stopReason !== "end_turn")
      throw Object.assign(
        new RuntimeError(
          `The Copilot session ended (${r.stopped ?? r.stopReason}) without writing ${outRel}.`,
        ),
        { tools },
      );
    return {
      output: written ?? r.text,
      usage: r.usage ?? {
        inputTokens: request.pack.manifest.totalTokens,
        outputTokens: estimateTokens(r.text),
      },
      tools,
      ...(r.model ? { model: r.model } : {}),
      assistant: r.assistant,
    };
  }

  /** Kept as a hand-off run is: run.json beside the prompt, so Model runs shows it. */
  protected override async keep(run: Run): Promise<void> {
    const dir = join(runsDirOf(this.c.root), run.request.change, run.runId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "run.json"), JSON.stringify(run, null, 2) + "\n", "utf8");
  }
}

/** Without an atticus to run (an embedder that gave none), every command is refused plainly. */
const noExec: AcpExec = async (argv) => ({
  exitCode: 127,
  output: `atticus ${argv.join(" ")}: this program can't run atticus commands for the session; run the step with the atticus command line.\n`,
});

/**
 * A run record for a session that isn't a C5 request (a read's part in atticus map --all): the
 * prompt, the transcript beside it, and run.json as a hand-off run keeps it, so `atticus runs`
 * and the app's Model runs page show it with its model and the assistant's version.
 */
export async function keepAcpRun(o: {
  root: string;
  change: string;
  runId: string;
  agent: AgentDefinition;
  prompt: string;
  outputPath: string;
  startedAt: string;
  finishedAt: string;
  state: "validated" | "failed" | "cancelled";
  errors: string[];
  result?: AcpSessionResult;
  stepClass?: StepClass;
}): Promise<string> {
  const dir = join(runsDirOf(o.root), o.change, o.runId);
  await mkdir(dir, { recursive: true });
  if (!existsSync(join(dir, "prompt.md")))
    await writeFile(join(dir, "prompt.md"), o.prompt, "utf8");
  const r = o.result;
  const run = {
    runId: o.runId,
    request: { change: o.change, agent: o.agent, outputPath: o.outputPath },
    runtime: "copilot-acp",
    state: o.state,
    attempt: 1,
    startedAt: o.startedAt,
    finishedAt: o.finishedAt,
    errors: o.errors,
    ...(r?.usage ? { usage: r.usage } : {}),
    ...(r
      ? {
          tools: {
            offered: ACP_OFFERED,
            calls: r.toolCalls,
            ...(r.stopped ? { stopped: r.stopped } : {}),
          },
        }
      : {}),
    stepClass: o.stepClass ?? stepClassOf({ agent: o.agent } as AiRequest),
    ...(r?.model ? { model: r.model } : {}),
    ...(r ? { assistant: r.assistant } : {}),
  };
  await writeFile(join(dir, "run.json"), JSON.stringify(run, null, 2) + "\n", "utf8");
  return dir;
}
