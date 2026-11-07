import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import {
  changesDirOf,
  changesRelOf,
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
import { OneShotRuntime, RuntimeError, type AiRequest, type Run, type Usage } from "./runtime.js";
import { stepClassOf } from "./step-class.js";

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

/** The atticus commands a session may not run: what only a person does, and what loops. */
const PERSONS: { test: (a: string[]) => boolean; why: string }[] = [
  {
    test: (a) => a[0] === "questions" && a[1] === "answer",
    why: "a person answers questions (atticus questions answer is theirs to run)",
  },
  {
    test: (a) => a.includes("--approve"),
    why: "--approve is a person's: a human approves every write to shared systems",
  },
  {
    test: (a) => a.includes("--accept") || a.includes("--accept-proposal"),
    why: "a person accepts what is proposed (--accept is theirs)",
  },
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
  for (const p of PERSONS) if (p.test(argv)) return { refused: `Refused: ${p.why}.` };
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
    return this.reads.some((x) => sameOrUnder(x, r))
      ? undefined
      : `Atticus lets this session read only under the metarepo and its clones; ${short(path)} is outside`;
  }
  writable(path: string): string | undefined {
    if (!path || !isAbsolute(path)) return `the path must be absolute (got ${short(path)})`;
    const r = caseOf(real(path));
    if (r.split(sep).includes(".git"))
      return `Atticus never lets a session write in .git (${short(path)})`;
    if (this.files.includes(r) || this.writeDirs.some((x) => sameOrUnder(x, r))) return undefined;
    // Said relative to the metarepo, as the agent names its files.
    const base = this.p.readRoots[0] ?? "";
    const rel = (x: string) => {
      const r = relative(base, x);
      return r && !r.startsWith("..") && !isAbsolute(r) ? r.split(sep).join("/") : x;
    };
    const where = [
      ...this.p.writeRoots.map((d) => `${rel(d)}/`),
      ...(this.p.writeFiles ?? []).map(rel),
    ].join(", ");
    return `Atticus lets this session write only its step's result: it writes only under ${where || "nothing"}; ${short(path)} is refused`;
  }
}

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
}

/** Starts the server; tests can pass their own. */
export type AcpSpawner = (o: {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
}) => AcpServer;

const needsShell = (command: string) =>
  process.platform === "win32" && !/\.(exe|com)$/i.test(command);
const quoteForCmd = (a: string) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);

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
  child.on("exit", (code, signal) =>
    close(`the Copilot language server ended (${code ?? signal ?? "no code"})`),
  );
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
    transport: {
      send: (t) => {
        if (!closed) child.stdin?.write(`${t}\n`);
      },
      onLine: (f) => lines.push(f),
      onClose: (f) => (closed ? f(closed) : closes.push(f)),
    },
    close: async () => {
      if (closed) return;
      child.stdin?.end();
      await new Promise<void>((res) => {
        const t = setTimeout(() => {
          killTree(child);
          res();
        }, 2000);
        closes.push(() => {
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
  signal?: AbortSignal;
  /** Short progress lines for the console. */
  onProgress?: (line: string) => void;
  /** Where every message both ways is kept (JSON lines): the run's transcript. */
  transcript?: string;
  /** Extra environment for the server (tests). */
  env?: Record<string, string>;
  spawn?: AcpSpawner;
  clientVersion?: string;
}

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
export function carryOnPrompt(refusals: readonly string[]): string {
  return [
    "Atticus refused this, and you are not finished yet:",
    ...refusals.slice(-3).map((r) => `- ${oneLine(r, 300)}`),
    "",
    "Carry on with the step. Use your own file tools to find, view and search files: they are allowed and need no shell. Don't run shell commands (cd, dir, Get-ChildItem, Select-String, Get-Content, grep, find); the only command Atticus runs is one `atticus ...` command at a time, with nothing piped or chained. The step says where its files are. Finish what the step asks for (the facts, or the result file it names), then stop.",
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

/**
 * One session, start to end: the server started, `initialize`, a new session rooted at `cwd`,
 * runtime.yaml's model asked for, the prompt sent, every request answered by the rules above, and
 * the server ended when the agent stops (or Atticus cancels it: maxTurns, the timeout, Ctrl+C).
 */
export async function runAcpSession(o: AcpSessionOptions): Promise<AcpSessionResult> {
  const { command, args } = commandLineOf(o.command);
  const server = (o.spawn ?? spawnAcpServer)({
    command,
    args,
    cwd: o.cwd,
    // beta.17: set on the server too, so an atticus command Copilot runs in its own shell (not
    // through Atticus's terminal) knows it is inside a session and hands off instead of starting
    // a Copilot session of its own (a session within a session, waiting on itself).
    env: { ...process.env, ...(o.env ?? {}), ATTICUS_ACP_SESSION: "1", ATTICUS_ROOT: o.cwd },
  });
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
  const cancel = (why: string) => {
    if (cancelWhy) return;
    cancelWhy = why;
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
  const client = new AcpClient(server.transport, handlers, (dir, m) =>
    transcript.push(JSON.stringify({ dir, m })),
  );
  box.client = client;

  const onAbort = () => cancel("stopped (Ctrl+C)");
  o.signal?.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    let init;
    try {
      await server.started;
      init = await withTimeout(
        client.initialize({ name: "atticus", version: o.clientVersion ?? "2" }),
        60_000,
        "The Copilot language server's initialize",
      );
    } catch (e) {
      throw new AcpSetupError(
        `Atticus couldn't start the Copilot language server (${o.command}): ${firstLine(e)}${tail(server.stderr())}. Check copilotAcp.command in runtime.yaml, and that ${command} --help lists --acp.`,
      );
    }
    const assistant: RunAssistant = {
      name: init.agentInfo?.name ?? basename(command).replace(/\.(cmd|exe)$/i, ""),
      ...(init.agentInfo?.version ? { version: init.agentInfo.version } : {}),
      ...(typeof init.protocolVersion === "number"
        ? { protocolVersion: init.protocolVersion }
        : {}),
    };
    let ns;
    try {
      ns = await withTimeout(client.newSession(o.cwd), 120_000, "Opening a Copilot session");
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
      await client.setModel(sessionId, o.model);
      model = o.model;
    }
    say(
      `  Copilot session open (${assistant.name}${assistant.version ? ` ${assistant.version}` : ""}${model ? `, ${model}` : ""}).`,
    );
    if (o.signal?.aborted) cancel("stopped (Ctrl+C)");
    timer = setTimeout(() => cancel("timeout"), o.timeoutMs ?? 30 * 60_000);
    // beta.16: Copilot ends its turn when a permission is refused ("Operation cancelled by
    // user"), often with the step half done. While it ended right after a refusal, it is told why
    // and how to go on (its own file tools, no shell), in the same session, a few times at most.
    let prompt = o.prompt;
    let answer: { stopReason: string; usage?: Record<string, unknown> } = {
      stopReason: "end_turn",
    };
    const usages: Record<string, unknown>[] = [];
    for (let nudge = 0; ; nudge++) {
      const before = refused.length;
      const asked = client.prompt(sessionId, prompt);
      try {
        answer = await new Promise((res, rej) => {
          asked.then(res, rej);
          // Once cancelled, the agent has ten seconds to say so before the server is ended.
          const watch = setInterval(() => {
            if (!cancelWhy) return;
            clearInterval(watch);
            setTimeout(() => res({ stopReason: "cancelled" }), 10_000);
          }, 50);
          asked.finally(() => clearInterval(watch)).catch(() => undefined);
        });
      } catch (e) {
        if (isAuthRequired(e)) throw signInError(e, init, server.stderr());
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
      if (
        cancelWhy ||
        !overIt ||
        nudge >= MAX_NUDGES ||
        !["end_turn", "cancelled"].includes(answer.stopReason)
      )
        break;
      say(
        `  Atticus: told Copilot why that was refused and to carry on (${nudge + 1} of ${MAX_NUDGES}).`,
      );
      prompt = carryOnPrompt(fresh);
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
    await server.close().catch(() => undefined);
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
const tail = (stderr: string) => {
  const l = stderr.trim().split(/\r?\n/).slice(-2).join(" ").trim();
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
          ? undefined
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
      return a.refused;
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
}

/**
 * `atticus doctor`'s look (ADR 0171): `<command> --version`, then the handshake alone
 * (initialize and a new session, no prompt, so nothing runs and no tokens are spent).
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
  const version = await new Promise<{ ok: boolean; text: string }>((res) => {
    const shell = needsShell(command);
    let out = "";
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
      res({ ok: false, text: (e as Error).message });
      return;
    }
    const t = setTimeout(() => killTree(child), o.timeoutMs ?? 60_000);
    child.stdout?.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr?.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.on("error", (e) => {
      clearTimeout(t);
      res({ ok: false, text: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(t);
      // A shell says "not found" with exit 1 or 9009 rather than ENOENT.
      res({ ok: code === 0, text: out.trim() });
    });
  });
  if (!version.ok) return { found: false, said: oneLine(version.text, 200) };
  const v = version.text
    .split(/\r?\n/)
    .find((l) => l.trim())
    ?.trim();
  const server = (o.spawn ?? spawnAcpServer)({ command, args, cwd: o.cwd, env });
  const client = new AcpClient(server.transport, {
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
  });
  const base = { found: true, ...(v ? { version: v } : {}) };
  try {
    await server.started;
    await withTimeout(
      client.initialize({ name: "atticus-doctor", version: "2" }),
      o.timeoutMs ?? 60_000,
      "initialize",
    );
    try {
      await withTimeout(client.newSession(o.cwd), o.timeoutMs ?? 60_000, "a new session");
      return { ...base, signedIn: true };
    } catch (e) {
      if (isAuthRequired(e)) {
        await new Promise((r) => setTimeout(r, 150));
        const lines = signInLines(server.stderr());
        return { ...base, signedIn: false, said: [firstLine(e), ...lines].join(" ") };
      }
      return { ...base, said: firstLine(e) };
    }
  } catch (e) {
    return { ...base, said: `the --acp handshake failed: ${firstLine(e)}` };
  } finally {
    await server.close().catch(() => undefined);
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
