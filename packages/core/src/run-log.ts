import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { ignoreLocalSync, redactText } from "./log.js";

/**
 * ADR 0187: what a command run outside the app prints, for the app's Console. A long command
 * (`atticus map`, `verify`, `scan`, `workspace sync`, a task run, ...) run in a terminal, by an
 * editor or by a Copilot session keeps:
 *
 * - `.atticus/logs/runs/<runId>.log`: the lines it printed, each redacted as the local log is
 *   (ADR 0050's redactText: no secrets, tokens, credentials in URLs or home folder), with no
 *   colour codes; bounded (its last lines are kept past RUN_LOG_MAX_BYTES).
 * - `.atticus/logs/running/<runId>.json`: who and what — the command words, the ids it was given
 *   (repo, change, run and task ids: words that look like an id and nothing else), the names of
 *   its flags (never their values), the process and a hash of the machine's name, when it
 *   started, and how it ended (its exit code), written again when it ends.
 *
 * Only the last RUN_LOG_KEEP runs are kept. `.atticus/logs/` is this machine's own (never
 * committed). The names have no `:` (Windows). Nothing here loads a schema: the command line
 * starts a run before it knows anything else. Writing never throws: a run log that can't be
 * written is skipped, never failing the command it describes.
 */

export const RUN_LOG_KEEP = 50;
export const RUN_LOG_MAX_BYTES = 2 * 1024 * 1024;
/** A line longer than this is cut (a minified file printed whole). */
export const RUN_LOG_LINE_MAX = 4000;
/** The lines a read gives at most. */
export const RUN_LOG_READ_MAX = 5000;
/** `20261109-101530-4242-ab12`: when (UTC), the process, and a little randomness. */
export const TERMINAL_RUN_ID = /^\d{8}-\d{6}-\d{1,10}-[0-9a-f]{4}$/;

export const runLogsDirOf = (root: string) => join(root, ".atticus", "logs", "runs");
export const runningDirOf = (root: string) => join(root, ".atticus", "logs", "running");

export type StartedBy = "terminal" | "vscode" | "intellij" | "copilot";
export type TerminalRunState = "running" | "done" | "failed" | "cancelled";

export interface TerminalRunRecord {
  schemaVersion: 1;
  runId: string;
  pid: number;
  /** A hash of the machine's name: whether the process can be looked for here. */
  host: string;
  title: string;
  command: string[];
  flags: string[];
  startedBy: StartedBy;
  startedAt: string;
  state: TerminalRunState;
  finishedAt?: string;
  exitCode?: number;
  /** Lines printed so far (as of the last write of the record; the log has them all). */
  lines: number;
  /** Lines no longer in the log (the log keeps its last lines). */
  dropped: number;
}

/** A record as read: `stale` when its process is gone though it never said it ended. */
export type TerminalRunView = TerminalRunRecord & { stale?: true };

/**
 * The commands that keep a run log: long ones, or ones that write. Read-only, quick commands
 * (help, list, show, next, `--json` queries) never make a file. By the command's words.
 */
const RECORDED: Record<string, true | ReadonlySet<string>> = {
  map: true,
  scan: true,
  verify: true,
  upgrade: true,
  reconcile: true,
  "run-ready": true,
  workspace: new Set(["sync", "bring-in", "open"]),
  task: new Set(["run", "run-ready"]),
  knowledge: new Set(["scan"]),
  handoff: new Set(["done"]),
  index: new Set(["rebuild", "embed"]),
};
/** Never kept, whatever the command: a question about it, or a look at what it would do. */
const NOT_RECORDED_FLAGS = new Set(["help", "version", "check", "dry-run"]);
/** Sub-commands of a kept command that are a quick look. */
const QUICK = new Set(["map render", "verify audit", "scan review"]);

export function recordedCommand(positionals: readonly string[], flags: readonly string[]): boolean {
  const [group, command] = positionals;
  if (!group || flags.some((f) => NOT_RECORDED_FLAGS.has(f))) return false;
  if (command && QUICK.has(`${group} ${command}`)) return false;
  const rule = RECORDED[group];
  if (rule === true) return true;
  return !!rule && !!command && rule.has(command);
}

/** A word kept in a title: an id (repo, change, run, task), nothing that could be a value. */
const ID_WORD = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const MAX_WORDS = 8;
const safeWord = (w: string) =>
  ID_WORD.test(w) && !w.includes("//") && redactText(w, { home: "", user: "" }) === w ? w : "…";

/** The command words, ids and flag names of a run, and its title. */
export function runTitle(
  positionals: readonly string[],
  flags: readonly string[],
): { command: string[]; title: string } {
  const command = positionals.slice(0, MAX_WORDS).map(safeWord);
  const names = flags.filter((f) => /^[a-z][a-z0-9-]{0,40}$/.test(f)).map((f) => `--${f}`);
  return { command, title: ["atticus", ...command, ...names].join(" ") };
}

/** Where the run was started, as its environment says. */
export function startedByOf(env: NodeJS.ProcessEnv = process.env): StartedBy {
  if (env.ATTICUS_ACP_SESSION) return "copilot";
  const said = env.ATTICUS_STARTED_BY;
  if (said === "vscode" || said === "intellij" || said === "terminal") return said;
  if (env.TERM_PROGRAM === "vscode") return "vscode";
  if ((env.TERMINAL_EMULATOR ?? "").startsWith("JetBrains")) return "intellij";
  return "terminal";
}

const hostHash = () => {
  try {
    return createHash("sha256").update(hostname()).digest("hex").slice(0, 12);
  } catch {
    return "unknown";
  }
};

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const idAt = (d: Date, pid: number) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}-${pid}-${randomBytes(2).toString("hex")}`;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

/** A printed text as the lines the log keeps: no colour codes, no \r, each redacted and cut. */
export function runLogLines(text: string, o: { home?: string; user?: string } = {}): string[] {
  return text
    .replace(ANSI, "")
    .split(/\r?\n|\r/)
    .map((l) => {
      const r = redactText(l, o);
      return r.length > RUN_LOG_LINE_MAX ? `${r.slice(0, RUN_LOG_LINE_MAX)}…` : r;
    });
}

export interface TerminalRunRecorder {
  readonly runId: string;
  /** Print a line (or several, split at newlines) to the run's log. */
  line(text: string): void;
  /** Record how it ended: 0 done, 130 or 143 (Ctrl+C, a stop) cancelled, else failed. */
  end(code: number, how?: "crash"): void;
}

export interface StartRunOptions {
  positionals: readonly string[];
  flags: readonly string[];
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  pid?: number;
  keep?: number;
  maxBytes?: number;
  redact?: { home?: string; user?: string };
  /**
   * Record the end on the process's exit, Ctrl+C and SIGTERM too, when nothing else did (the
   * command line passes true; a test doesn't).
   */
  hookProcess?: boolean;
}

const writeJson = (file: string, v: unknown) => {
  const text = `${JSON.stringify(v, null, 2)}\n`;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, file);
  } catch {
    // Windows may hold the file a moment while the app reads it: written in place instead.
    rmSync(tmp, { force: true });
    writeFileSync(file, text, "utf8");
  }
};

/** Older runs past `keep` (the newest first by their id, which starts with the time) removed. */
function prune(root: string, keep: number) {
  let names: string[];
  try {
    names = readdirSync(runningDirOf(root))
      .filter((n) => n.endsWith(".json") && TERMINAL_RUN_ID.test(n.slice(0, -5)))
      .sort();
  } catch {
    return;
  }
  for (const n of names.slice(0, Math.max(names.length - keep, 0))) {
    const id = n.slice(0, -5);
    rmSync(join(runningDirOf(root), n), { force: true });
    rmSync(join(runLogsDirOf(root), `${id}.log`), { force: true });
  }
  // A log left without its record (a record removed by hand) goes too.
  try {
    const kept = new Set(names.slice(-keep).map((n) => n.slice(0, -5)));
    for (const n of readdirSync(runLogsDirOf(root)))
      if (n.endsWith(".log") && TERMINAL_RUN_ID.test(n.slice(0, -4)) && !kept.has(n.slice(0, -4)))
        rmSync(join(runLogsDirOf(root), n), { force: true });
  } catch {
    // no logs yet
  }
}

/**
 * Start a run's files. Undefined when they can't be written (the run goes on without them).
 * The caller checks `recordedCommand` first.
 */
export function startTerminalRun(
  root: string,
  o: StartRunOptions,
): TerminalRunRecorder | undefined {
  const now = o.now ?? (() => new Date());
  const pid = o.pid ?? process.pid;
  const keep = Math.max(o.keep ?? RUN_LOG_KEEP, 1);
  const maxBytes = Math.max(o.maxBytes ?? RUN_LOG_MAX_BYTES, 256);
  const started = now();
  const runId = idAt(started, pid);
  const { command, title } = runTitle(o.positionals, o.flags);
  const rec: TerminalRunRecord = {
    schemaVersion: 1,
    runId,
    pid,
    host: hostHash(),
    title,
    command,
    flags: o.flags.filter((f) => /^[a-z][a-z0-9-]{0,40}$/.test(f)),
    startedBy: startedByOf(o.env),
    startedAt: started.toISOString(),
    state: "running",
    lines: 0,
    dropped: 0,
  };
  const jsonFile = join(runningDirOf(root), `${runId}.json`);
  const logFile = join(runLogsDirOf(root), `${runId}.log`);
  try {
    mkdirSync(runningDirOf(root), { recursive: true });
    mkdirSync(runLogsDirOf(root), { recursive: true });
    ignoreLocalSync(root);
    prune(root, keep - 1);
    writeFileSync(logFile, "", "utf8");
    writeJson(jsonFile, rec);
  } catch {
    return undefined;
  }
  let bytes = 0;
  let inFile = 0;
  let ended = false;
  let broken = false;

  const save = () => {
    try {
      writeJson(jsonFile, { ...rec, lines: rec.dropped + inFile });
    } catch {
      // never fail a command over its run log
    }
  };
  /** The log past its size keeps its last lines, about half of it. */
  const trim = () => {
    const all = readFileSync(logFile, "utf8").split("\n");
    if (all.at(-1) === "") all.pop();
    let size = 0;
    let at = all.length;
    while (at > 0 && size + Buffer.byteLength(all[at - 1]!) + 1 <= maxBytes / 2) {
      size += Buffer.byteLength(all[at - 1]!) + 1;
      at--;
    }
    const kept = all.slice(at);
    writeFileSync(logFile, kept.length ? `${kept.join("\n")}\n` : "", "utf8");
    rec.dropped += at;
    inFile = kept.length;
    bytes = size;
    save();
  };

  const unhook: (() => void)[] = [];
  const recorder: TerminalRunRecorder = {
    runId,
    line(text) {
      if (ended || broken) return;
      try {
        for (const l of runLogLines(text, o.redact)) {
          const s = `${l}\n`;
          const n = Buffer.byteLength(s);
          if (bytes + n > maxBytes) trim();
          appendFileSync(logFile, s, "utf8");
          bytes += n;
          inFile++;
        }
      } catch {
        broken = true;
      }
    },
    end(code, how) {
      if (ended) return;
      ended = true;
      for (const u of unhook) u();
      rec.state =
        how === "crash"
          ? "failed"
          : code === 0
            ? "done"
            : code === 130 || code === 143
              ? "cancelled"
              : "failed";
      rec.exitCode = code;
      rec.finishedAt = now().toISOString();
      save();
    },
  };

  if (o.hookProcess) {
    const onExit = (code: number) => recorder.end(typeof code === "number" ? code : 1);
    process.once("exit", onExit);
    unhook.push(() => process.off("exit", onExit));
    for (const [sig, code] of [
      ["SIGINT", 130],
      ["SIGTERM", 143],
    ] as const) {
      const on = () => {
        // Another handler (map --all's: stop after the step under way) has the signal: it ends
        // the command, and the end is recorded then. Alone, this ends it as the default would.
        if (process.listenerCount(sig) > 1) return;
        recorder.end(code);
        process.exit(code);
      };
      process.on(sig, on);
      unhook.push(() => process.off(sig, on));
    }
  }
  return recorder;
}

/** Whether a process is there: signal 0 asks without sending anything. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const DAY = 24 * 60 * 60 * 1000;

function readRecord(root: string, runId: string): TerminalRunRecord | undefined {
  if (!TERMINAL_RUN_ID.test(runId)) return undefined;
  try {
    const r = JSON.parse(
      readFileSync(join(runningDirOf(root), `${runId}.json`), "utf8"),
    ) as Partial<TerminalRunRecord>;
    if (
      r.schemaVersion !== 1 ||
      r.runId !== runId ||
      typeof r.title !== "string" ||
      typeof r.startedAt !== "string" ||
      typeof r.pid !== "number" ||
      !["running", "done", "failed", "cancelled"].includes(r.state as string)
    )
      return undefined;
    return {
      ...(r as TerminalRunRecord),
      command: Array.isArray(r.command) ? r.command.map(String) : [],
      flags: Array.isArray(r.flags) ? r.flags.map(String) : [],
      lines: Number(r.lines) || 0,
      dropped: Number(r.dropped) || 0,
    };
  } catch {
    return undefined;
  }
}

/**
 * The runs kept, newest first. A run still `running` whose process is gone on this machine (or
 * that started days ago elsewhere) is `stale`: it ended without saying (closed terminal, a crash).
 */
export function readTerminalRuns(
  root: string,
  o: { alive?: (pid: number) => boolean; now?: () => Date } = {},
): TerminalRunView[] {
  let names: string[];
  try {
    names = readdirSync(runningDirOf(root));
  } catch {
    return [];
  }
  const here = hostHash();
  const alive = o.alive ?? pidAlive;
  const now = (o.now ?? (() => new Date()))().getTime();
  const out: TerminalRunView[] = [];
  for (const n of names.sort().reverse()) {
    if (!n.endsWith(".json")) continue;
    const r = readRecord(root, n.slice(0, -5));
    if (!r) continue;
    if (r.state === "running") {
      const age = now - Date.parse(r.startedAt);
      const gone = r.host === here ? !alive(r.pid) || age > 7 * DAY : age > 2 * DAY;
      if (gone) {
        out.push({ ...r, stale: true });
        continue;
      }
    }
    out.push(r);
  }
  return out;
}

/** One run as read now, or undefined. */
export const readTerminalRun = (
  root: string,
  runId: string,
  o: { alive?: (pid: number) => boolean; now?: () => Date } = {},
): TerminalRunView | undefined =>
  TERMINAL_RUN_ID.test(runId)
    ? readTerminalRuns(root, o).find((r) => r.runId === runId)
    : undefined;

/**
 * A run's lines from a line on (`from`, counted from its first line ever), at most `max`; without
 * `from`, its last `max`. `total` is how many it has printed. Undefined for no such run.
 */
export function readTerminalRunLines(
  root: string,
  runId: string,
  from?: number,
  max = RUN_LOG_READ_MAX,
): { from: number; lines: string[]; total: number } | undefined {
  const r = readRecord(root, runId);
  if (!r) return undefined;
  let text: string;
  try {
    text = readFileSync(join(runLogsDirOf(root), `${runId}.log`), "utf8");
  } catch {
    text = "";
  }
  const all = text.split("\n");
  // A line being written (no newline yet) waits for its end.
  all.pop();
  const total = r.dropped + all.length;
  const start =
    from === undefined
      ? Math.max(total - max, r.dropped)
      : Math.max(Math.min(from, total), r.dropped);
  const lines = all.slice(start - r.dropped, start - r.dropped + max);
  return { from: start, lines, total };
}
