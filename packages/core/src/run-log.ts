import { createHash, randomBytes } from "node:crypto";
import {
  accessSync,
  appendFileSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { hasSecretShape, hasTokenPrefix, keyIsSecret } from "./cite.js";
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
 *   (repo, change, run and task ids; beta.27 review: only in the places the command declares for
 *   them, each an id's strict shape and no secret's, titleWord; the rest `…`), the names of
 *   its flags (in `flags`, never their values; beta.27: the title keeps the value of a flag on
 *   an allow-list, TITLE_VALUE_FLAGS, when it is an id, a name or a date: titleValue), the process and a hash of the
 *   machine's name, when it
 *   started, and how it ended (its exit code), written again when it ends. While it runs it is
 *   written again every RUN_HEARTBEAT_MS (`beatAt`), and on Linux it keeps when its process
 *   started (`procStart`, from /proc): a process id used again by another process, or a run
 *   silent past RUN_SILENT_MS, is a run that ended without saying.
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
/** A running command writes its record again this often. */
export const RUN_HEARTBEAT_MS = 30_000;
/** A running record that beats, silent (record and log) for longer than this, has ended. */
export const RUN_SILENT_MS = 5 * 60 * 1000;
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
  /** When the process started, as the system says (Linux: /proc), to tell a reused pid. */
  procStart?: string;
  /** When a running command last wrote its record (every RUN_HEARTBEAT_MS). */
  beatAt?: string;
}

/** A record as read: `stale` when its process is gone though it never said it ended. */
export type TerminalRunView = TerminalRunRecord & { stale?: true };

/**
 * The commands that keep a run log: every one that writes (a file in the metarepo, the catalog,
 * an answer, a hand-off), and the long reads. Read-only, quick commands (help, list, show, status,
 * next, and the questions asked of them with `--json`) never make a file, being off this list; a
 * command that writes is kept with `--json` too (ADR 0187: `--json` is no flag that skips the log,
 * so `atticus scan --json` run in a terminal is in the Console). By the command's words: `true`
 * for every sub-command, a set for those named, `{ except }` for all but those named (a quick
 * look); a group with sub-commands needs one. Beta.26 review: `change`, `initiative`, `questions` and the rest of the
 * commands that write were missing, so a change started in a terminal never showed in the Console.
 */
type Rule = true | ReadonlySet<string> | { except: ReadonlySet<string> };
const all = true as const;
const only = (...c: string[]): Rule => new Set(c);
const but = (...c: string[]): Rule => ({ except: new Set(c) });
const RECORDED: Record<string, Rule> = {
  // The long ones.
  map: all,
  scan: all,
  verify: all,
  upgrade: all,
  reconcile: all,
  "run-ready": all,
  workspace: only("sync", "bring-in", "open", "prune"),
  task: but("context"),
  knowledge: only("scan", "find", "ask", "keep", "verify", "correct", "reject"),
  handoff: only("done"),
  index: only("rebuild", "embed"),
  // A change, from its start to its archive, and what it asks of people.
  change: but("status", "list", "knowledge", "similar", "impact", "conflicts", "estimate", "map"),
  initiative: but("status"),
  questions: but("list", "show", "proposed", "decisions"),
  critic: all,
  finding: all,
  plan: all,
  stories: all,
  needs: only("done", "skip", "reopen"),
  todo: only("done", "run"),
  ado: all,
  release: all,
  outcome: only("record"),
  tests: only("generate"),
  spec: only("draft", "seed", "accept", "hand-down", "hand-up"),
  feature: but("list", "show"),
  triage: only("decide"),
  alias: all,
  // The estate, the org pack and what Atticus learns.
  baseline: all,
  repo: all,
  "repo-type": only("new", "note", "rules"),
  rules: only("add", "activate", "off", "draft", "try", "import"),
  types: only("add"),
  skills: only("import", "write"),
  connect: all,
  join: all,
  estate: only("join", "measure", "shared", "contracts"),
  sources: only("sync", "tag", "refresh"),
  glossary: only("scan", "define", "link", "alias"),
  intake: only("add", "traffic"),
  patterns: only("scan"),
  defences: only("scan"),
  onboard: but("check"),
  frameworks: all,
  dialect: only("new", "kit"),
  plugin: all,
  absorb: all,
  orgpack: only("draft", "accept", "owner"),
  standards: all,
  openspec: only("setup"),
  templates: only("draft"),
  catalog: only("migrate"),
  diagram: all,
  "assistant-files": all,
  site: only("build"),
  init: all,
  adopt: all,
  unadopt: all,
  support: only("bundle"),
  probe: all,
  eval: only("run"),
  bench: all,
};
/** Never kept, whatever the command: a question about it, or a look at what it would do. */
const NOT_RECORDED_FLAGS = new Set(["help", "version", "check", "dry-run"]);
/** Sub-commands of a kept command that are a quick look. */
const QUICK = new Set(["map render", "verify audit", "scan review", "critic stats"]);

export function recordedCommand(positionals: readonly string[], flags: readonly string[]): boolean {
  const [group, command] = positionals;
  if (!group || flags.some((f) => NOT_RECORDED_FLAGS.has(f))) return false;
  if (command && QUICK.has(`${group} ${command}`)) return false;
  const rule = RECORDED[group];
  if (rule === undefined) return false;
  if (rule === true) return true;
  if (!command) return false;
  return rule instanceof Set
    ? rule.has(command)
    : !(rule as { except: ReadonlySet<string> }).except.has(command);
}

const MAX_WORDS = 8;
/** The flags that say where a command ran, left out of its title. */
const WHERE_FLAGS = new Set(["root", "metarepo"]);
type Redaction = { home?: string; user?: string };

/**
 * Beta.27 review: the flags whose value a run's title keeps — an allow-list, never a deny-list.
 * Each is a string option the command line declares (cli-options' OPTIONS; a test holds the two
 * together) whose value, by its name and what it means, is an id, a name, a handle, a date or a
 * small number: a repo, a change, a run, a stage's kind, a lens, a person (`--by @bao`). Free text
 * (`--note`, `--answer`, `--with`, `--value`), a file, a folder, a host or a URL (`--from`,
 * `--path`, `--host`), a key (`--key`), anything an organisation's secret could be typed into and
 * every flag the command line doesn't know (`--pass=hunter2`) keep their name only.
 */
export const TITLE_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "area",
  "audience",
  "base",
  "by",
  "change",
  "component",
  "depth",
  "epic",
  "estate",
  "format",
  "framework",
  "gate",
  "group",
  "hops",
  "iteration",
  "journey",
  "kind",
  "language",
  "lens",
  "level",
  "limit",
  "mode",
  "model",
  "models",
  "owner",
  "platform",
  "pr",
  "release",
  "repo",
  "repos",
  "round",
  "run",
  "scope",
  "state",
  "step",
  "story",
  "system",
  "tag",
  "target",
  "task",
  "team",
  "template",
  "type",
]);
/** A value kept is cut to this many characters. */
export const TITLE_VALUE_MAX = 48;
/** A handle: `@bao`, never `bao@bank.example`. */
const HANDLE = /^@[\w.-]+$/;
/**
 * Long runs of hex or of digits (a digest, a random id, a card or account number), a card number
 * written in fours, a national id number.
 */
const LONG_RUN = /[0-9a-f]{16,}|[0-9A-F]{16,}|\d{9,}|\d{4}(?:[ -]?\d{4}){3}|\b\d{3}-\d{2}-\d{4}\b/;
/**
 * Beta.27 re-review: a work item's reference, by the trackers C1's ExternalRef names (a test
 * holds the two together) and nothing else: `pin:1234`, `pass:1234` or `otp:123456` is no id.
 */
export const WORK_ITEM_SYSTEMS = ["ado", "jira"] as const;
const WORK_ITEM_REF = new RegExp(
  `^(?:${WORK_ITEM_SYSTEMS.join("|")}):(?:\\d{1,7}|[A-Z][A-Z0-9]{1,9}-\\d{1,7})$`,
);
/**
 * The ids a title knows by their whole form, whatever their digits: a date, a version, a task's
 * label (1.2), a question (q- and up to 12 hex), a run (Atticus's own two kinds), a change's or a
 * model's slug of words and small numbers (`fix-limits-2027-q1`, `sonnet-4-5`) and a work item's
 * reference (`ado:1234`, `jira:PAY-12`: WORK_ITEM_REF). Each is still checked for a token's
 * prefix first.
 */
const ID_FORMS: readonly RegExp[] = [
  /^\d{4}-\d{2}-\d{2}$/,
  /^v?\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[a-z]{1,12}(?:\.\d{1,3})?)?$/,
  /^\d{1,3}(?:\.\d{1,3}){1,2}$/,
  /^q-[0-9a-f]{1,12}$/,
  /^run-\d{14}-(?:\d{4}|[0-9a-f]{6})$/,
  TERMINAL_RUN_ID,
  /^[a-z]{1,24}(?:[-.](?:[a-z]{1,24}\d{0,3}|\d{1,4}))+$/,
  WORK_ITEM_REF,
];
/** `link:<repo>:<call>`: a link's id, each part an id-like word (idShaped). */
const LINK_REF = /^link:([^:]+):([^:]+)$/;
/**
 * One part of an id-like word (split at `-`, `.`, `_` and `/`): a lowercase word with a small
 * number after it (`v2`, `beta27`), a capitalised word, an acronym, or a number.
 */
const PART = /^(?:[a-z]{1,24}\d{0,3}|[A-Z][a-z]{1,23}|[A-Z]{1,8}|\d{1,6})$/;

/**
 * Beta.27 review: the strict shape a title's word must have, past every check for a secret: an
 * id-like word, parts (PART) joined by `-`, `.`, `_` or `/`, with at most one run of digits. A
 * random-looking string (mixed case and digits, `Zx9Kq2Lm…`, `Summer2026`) has none of these
 * shapes, so it is dropped whatever its length; a harmless word dropped is the price.
 */
function idShaped(w: string): boolean {
  if (!w || w.length > 100) return false;
  if (!w.split(/[-._/]/).every((p) => PART.test(p))) return false;
  return (w.match(/\d+/g) ?? []).length <= 1;
}

/**
 * Beta.27 review: whether a word may show in a run's title, as a positional word or as one item
 * of an allowed flag's value (titleValue). Never: a word with an `@` but a leading handle's, a
 * `\`, a `//`, a space, one of core's token prefixes (cite.ts's TOKEN_PREFIXES) or shapes
 * (hasSecretShape), or anything the log's redaction (with this machine's home folder and user
 * name) would change. Then one of the ids it knows by their form (ID_FORMS, a link's), or no `:`,
 * no long run of hex or digits, no key-like shape (keyIsSecret) and an id's strict shape
 * (idShaped). The word as given, or undefined.
 */
export function titleWord(word: string | undefined, redact: Redaction = {}): string | undefined {
  if (!word || word.length > 100 || /[\s\\]/.test(word) || word.includes("//")) return undefined;
  const handle = HANDLE.test(word);
  if (word.includes("@") && !handle) return undefined;
  if (hasTokenPrefix(word) || hasSecretShape(word)) return undefined;
  if (redactText(word, redact) !== word) return undefined;
  const bare = handle ? word.slice(1) : word;
  if (ID_FORMS.some((re) => re.test(bare))) return word;
  const link = LINK_REF.exec(bare);
  if (link) return idShaped(link[1]!) && idShaped(link[2]!) ? word : undefined;
  if (bare.includes(":") || LONG_RUN.test(bare) || keyIsSecret(bare)) return undefined;
  return idShaped(bare) ? word : undefined;
}

/**
 * Beta.27: a flag's value kept in a title, as typed (`--target 2027-03-31`, `--by @bao`,
 * `--repos forge-ledger,forge-teller`). Beta.27 review: only for a flag of TITLE_VALUE_FLAGS;
 * never a value with a `:` (a host's path, a user and password, a reference to a variable) or
 * starting with `-` (the next flag, read as this one's value); a list (`a,b`) only when each of
 * its items is a title's word (titleWord); one kept is cut to TITLE_VALUE_MAX.
 */
export function titleValue(
  flag: string,
  value: string | undefined,
  redact: Redaction = {},
): string | undefined {
  if (value === undefined || !value || !TITLE_VALUE_FLAGS.has(flag)) return undefined;
  if (value.includes(":") || value.startsWith("-") || value.length > 400) return undefined;
  if (!value.split(",").every((i) => titleWord(i, redact) !== undefined)) return undefined;
  if (hasSecretShape(value) || keyIsSecret(value)) return undefined;
  return value.length > TITLE_VALUE_MAX ? `${value.slice(0, TITLE_VALUE_MAX)}…` : value;
}

/**
 * The command words, ids and flag names of a run, and its title. Beta.27: with the flags'
 * values (`values`, by flag name; a boolean flag has none), each kept when titleValue keeps it, so
 * the title reads as the command was typed; beta.26 dropped them all ("--target --by"). Beta.27
 * review: each word is a title's word (titleWord) or `…` (words dropped one after another are one
 * `…`); the command line gives only the words a command declares (its words and its arguments'
 * places, by the help), the rest as `…`. The words and values are redacted as the log is
 * (`redact`: this machine's home folder and user name by default; a test gives its own).
 */
export function runTitle(
  positionals: readonly string[],
  flags: readonly string[],
  values: Readonly<Record<string, string | undefined>> = {},
  redact: Redaction = {},
): { command: string[]; title: string } {
  const command: string[] = [];
  const add = (w: string) => {
    if (w !== "…" || command.at(-1) !== "…") command.push(w);
  };
  for (const w of positionals.slice(0, MAX_WORDS)) add(titleWord(w, redact) ?? "…");
  if (positionals.length > MAX_WORDS) add("…");
  // Where it ran (the metarepo's folder) isn't what ran (beta.26 review).
  const names = flags
    .filter((f) => /^[a-z][a-z0-9-]{0,40}$/.test(f) && !WHERE_FLAGS.has(f))
    .map((f) => {
      const v = Object.hasOwn(values, f) ? titleValue(f, values[f], redact) : undefined;
      return v === undefined ? `--${f}` : `--${f} ${v}`;
    });
  // Beta.27 re-review: a flag the command line doesn't declare is given as `…` (its name may be
  // a secret: `--correct-horse-battery-staple`), and shows as one `--…` after the others.
  if (flags.includes("…")) names.push("--…");
  return { command, title: ["atticus", ...command, ...names].join(" ") };
}

/** Beside the records: the first run of beta.27 re-titled the runs kept before it. */
export const RETITLED_MARK = ".retitled-beta27";
/** A record bigger than this is no record beta.26 wrote: left as it is, never read. */
export const RETITLE_MAX_BYTES = 1024 * 1024;
/** The most records the migration reads: beta.26 kept RUN_LOG_KEEP. */
const RETITLE_MAX_RECORDS = 1000;
/** The folders whose mark couldn't be written: not tried again by this process. */
const retitleTried = new Set<string>();

/**
 * A small regular file's text, never through a link (O_NOFOLLOW where there is one), never a
 * FIFO or a device (opened without waiting, then checked by its own descriptor), never one
 * bigger than `max`. Undefined otherwise.
 */
function readSmallFile(file: string, max: number): string | undefined {
  const before = lstatSync(file, { throwIfNoEntry: false });
  if (!before?.isFile() || before.size > max) return undefined;
  const fd = openSync(
    file,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
  );
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max) return undefined;
    const buf = Buffer.alloc(st.size);
    let at = 0;
    while (at < buf.length) {
      const n = readSync(fd, buf, at, buf.length - at, at);
      if (n <= 0) break;
      at += n;
    }
    return buf.subarray(0, at).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Beta.27 review: beta.26 kept every word that looked like an id in a run's title and words, a
 * key typed after `secret set` among them. The first command of beta.27 at a metarepo writes each
 * record kept again with the title, words and flag names the new rules give (`retitle`, the
 * command line's: it knows each command's arguments and options), and nothing else of it (its
 * log, state and times stay); RETITLED_MARK says it was done. How many it wrote again or removed.
 *
 * Beta.27 re-review: a run of `secret` is removed, record and log (beta.26 printed a mistyped
 * key back into its log). Only a regular file of at most RETITLE_MAX_BYTES is read (never a link,
 * a FIFO or a folder), a record whose process is still running is left to it (and the mark
 * waits, so the next command tries again; a run killed under beta.26 is titled again), a removal
 * that fails is tried again the same way, and a record is written
 * beside itself and put in place, never through a link. A folder that can't be written is left
 * alone (nothing could change), and one whose mark can't be written isn't tried again by this
 * process. Never throws: a record that can't be read or written is left as it is.
 */
export function retitleTerminalRuns(
  root: string,
  retitle: (r: { command: string[]; flags: string[] }) => {
    command: string[];
    title: string;
    flags?: string[];
  },
): number {
  const dir = runningDirOf(root);
  const mark = join(dir, RETITLED_MARK);
  if (retitleTried.has(dir)) return 0;
  let names: string[];
  try {
    if (lstatSync(mark, { throwIfNoEntry: false })) return 0;
    if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return 0;
    // A metarepo that can't be written (read-only): nothing here could change, now or later.
    accessSync(dir, fsConstants.W_OK);
    names = readdirSync(dir)
      .filter((n) => n.endsWith(".json") && TERMINAL_RUN_ID.test(n.slice(0, -5)))
      .sort()
      .slice(-RETITLE_MAX_RECORDS);
  } catch {
    // no runs kept, or none that could be written: nothing to do
    return 0;
  }
  let changed = 0;
  // A record left for later (its run is still alive, or its removal failed): no mark is written,
  // so the next command tries again. A run that never ends is gone after goneRun's 7 days.
  let later = false;
  const here = hostHash();
  const now = Date.now();
  for (const n of names) {
    const file = join(dir, n);
    const id = n.slice(0, -5);
    try {
      const text = readSmallFile(file, RETITLE_MAX_BYTES);
      if (text === undefined) continue;
      const raw = JSON.parse(text) as Record<string, unknown> | null;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      if (raw.state === "running") {
        // Beta.27 re-review 4: only a run whose process is still there is left to it; a run
        // killed under beta.26 (Ctrl-C, a closed terminal) stays "running" for ever and is
        // titled again like any other.
        const r = readRecord(root, id);
        if (r && !goneRun(r, here, pidAlive, now, root)) {
          later = true;
          continue;
        }
      }
      const words = Array.isArray(raw.command) ? raw.command.map((w) => `${w}`) : [];
      // A run of `secret` (beta.26 kept them): its record and its log go, whatever its title.
      // The log first, then the record, so a failed removal leaves the record to try again with.
      if (words[0] === "secret" || (words[0] === "legacy" && words[1] === "secret")) {
        try {
          rmSync(join(runLogsDirOf(root), `${id}.log`), { force: true });
          rmSync(file, { force: true });
          changed++;
        } catch {
          later = true;
        }
        continue;
      }
      if (typeof raw.title !== "string") continue;
      const flags = Array.isArray(raw.flags) ? raw.flags.map((f) => `${f}`) : [];
      const got = retitle({ command: words, flags });
      const next: Record<string, unknown> = { ...raw, title: got.title, command: got.command };
      if (got.flags) next.flags = got.flags;
      if (JSON.stringify(next) === JSON.stringify(raw)) continue;
      writeJson(file, next);
      changed++;
    } catch {
      // left as it is
    }
  }
  if (later) return changed;
  try {
    // Made new, never written through a link or over a file put there.
    writeFileSync(mark, `${new Date().toISOString()}\n`, { encoding: "utf8", flag: "wx" });
  } catch {
    retitleTried.add(dir);
  }
  return changed;
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

/**
 * When a process started, as Linux keeps it (/proc/<pid>/stat's starttime, in ticks since boot):
 * one file read, no command run. Undefined elsewhere, or when it can't be read.
 */
export function procStartOf(pid: number): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The name, in brackets, may hold spaces: the fields after its last ")" start at the 3rd.
    const v = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    return v && /^\d+$/.test(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

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
  /** Beta.27: the flags' values, by name, for the title (runTitle keeps the safe ones). */
  values?: Readonly<Record<string, string | undefined>>;
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
  /** Write the record again this often while it runs. Default RUN_HEARTBEAT_MS with hookProcess. */
  heartbeatMs?: number;
  /** When this process started (procStartOf, for its own pid only). */
  procStart?: () => string | undefined;
  /** Whether a process is there (pidAlive), for the runs pruned as this one starts. */
  alive?: (pid: number) => boolean;
}

const writeJson = (file: string, v: unknown) => {
  const text = `${JSON.stringify(v, null, 2)}\n`;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    // Made new (a link left at its name is removed, never written through).
    rmSync(tmp, { force: true });
    writeFileSync(tmp, text, { encoding: "utf8", flag: "wx" });
    renameSync(tmp, file);
  } catch {
    // Windows may hold the file a moment while the app reads it: written in place instead,
    // never through a link (beta.27 re-review).
    rmSync(tmp, { force: true });
    if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) return;
    writeFileSync(file, text, "utf8");
  }
};

/**
 * Older runs past `keep` (the newest first by their id, which starts with the time) removed,
 * never one still running (its process there): a long `map --all` outlives fifty quick runs.
 */
function prune(root: string, keep: number, live: (id: string) => boolean) {
  let names: string[];
  try {
    names = readdirSync(runningDirOf(root))
      .filter((n) => n.endsWith(".json") && TERMINAL_RUN_ID.test(n.slice(0, -5)))
      .sort();
  } catch {
    return;
  }
  const removed = new Set<string>();
  let over = names.length - keep;
  for (const n of names) {
    if (over <= 0) break;
    const id = n.slice(0, -5);
    if (live(id)) continue;
    rmSync(join(runningDirOf(root), n), { force: true });
    rmSync(join(runLogsDirOf(root), `${id}.log`), { force: true });
    removed.add(id);
    over--;
  }
  // A log left without its record (a record removed by hand) goes too.
  try {
    const kept = new Set(names.map((n) => n.slice(0, -5)).filter((id) => !removed.has(id)));
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
  const heartbeatMs = o.heartbeatMs ?? (o.hookProcess ? RUN_HEARTBEAT_MS : undefined);
  // When this process started: only for its own pid (a test's made-up pid has none).
  const procStart = o.procStart
    ? o.procStart()
    : pid === process.pid
      ? procStartOf(pid)
      : undefined;
  const { command, title } = runTitle(o.positionals, o.flags, o.values, o.redact);
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
    ...(procStart ? { procStart } : {}),
    ...(heartbeatMs ? { beatAt: started.toISOString() } : {}),
  };
  const jsonFile = join(runningDirOf(root), `${runId}.json`);
  const logFile = join(runLogsDirOf(root), `${runId}.log`);
  try {
    mkdirSync(runningDirOf(root), { recursive: true });
    mkdirSync(runLogsDirOf(root), { recursive: true });
    ignoreLocalSync(root);
    const alive = o.alive ?? pidAlive;
    prune(root, keep - 1, (id) => {
      const r = readRecord(root, id);
      return !!r && r.state === "running" && !goneRun(r, rec.host, alive, now().getTime(), root);
    });
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
      if (heartbeatMs && !ended) rec.beatAt = now().toISOString();
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
    // Written beside it and put in place: a reader that followed the old file by its offset
    // sees another file (its inode), and reads again from the record's count.
    const tmp = `${logFile}.${process.pid}.tmp`;
    const text = kept.length ? `${kept.join("\n")}\n` : "";
    try {
      writeFileSync(tmp, text, "utf8");
      renameSync(tmp, logFile);
    } catch {
      rmSync(tmp, { force: true });
      writeFileSync(logFile, text, "utf8");
    }
    rec.dropped += at;
    inFile = kept.length;
    bytes = size;
    save();
  };

  const unhook: (() => void)[] = [];
  if (heartbeatMs) {
    const beat = setInterval(() => {
      if (!ended) save();
    }, heartbeatMs);
    beat.unref?.();
    unhook.push(() => clearInterval(beat));
  }
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

const mtimeOf = (file: string) => {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
};

/**
 * Whether a run said `running` has ended without saying: its process is gone on this machine,
 * its pid is another process's now (that started at another time), it beats and has been silent
 * past RUN_SILENT_MS, or it started days ago (elsewhere: its process can't be looked for).
 */
function goneRun(
  r: TerminalRunRecord,
  here: string,
  alive: (pid: number) => boolean,
  now: number,
  root: string,
  startOf: (pid: number) => string | undefined = procStartOf,
): boolean {
  const age = now - Date.parse(r.startedAt);
  if (r.host !== here) return age > 2 * DAY;
  if (!alive(r.pid) || age > 7 * DAY) return true;
  const started = r.procStart ? startOf(r.pid) : undefined;
  // The system says when the process with this pid started: it is the run's, or another's.
  if (started !== undefined) return started !== r.procStart;
  if (r.beatAt) {
    const last = Math.max(
      Date.parse(r.beatAt) || 0,
      mtimeOf(join(runLogsDirOf(root), `${r.runId}.log`)),
    );
    return now - last > RUN_SILENT_MS;
  }
  return false;
}

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
      ...(typeof r.procStart === "string" ? { procStart: r.procStart } : {}),
      ...(typeof r.beatAt === "string" ? { beatAt: r.beatAt } : {}),
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
  o: {
    alive?: (pid: number) => boolean;
    now?: () => Date;
    /** When a process started (procStartOf). */
    startOf?: (pid: number) => string | undefined;
  } = {},
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
      if (goneRun(r, here, alive, now, root, o.startOf)) {
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
  o: {
    alive?: (pid: number) => boolean;
    now?: () => Date;
    startOf?: (pid: number) => string | undefined;
  } = {},
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

/** Where a tail of a run's log has read to: the next line's number and its byte in the file. */
export interface RunLogTail {
  line: number;
  bytes: number;
  /** The record's dropped count and the file (its inode) when read: either changing is a cut. */
  dropped: number;
  ino: number;
}

/** The complete lines of `buf` from line `skip` on, at most `max`, and the byte after them. */
function linesIn(
  buf: Buffer,
  skip: number,
  max: number,
): { lines: string[]; end: number; more: boolean } {
  const lines: string[] = [];
  let at = 0;
  let n = 0;
  while (at < buf.length) {
    const nl = buf.indexOf(10, at);
    // A line being written (no newline yet) waits for its end.
    if (nl < 0) break;
    if (n >= skip) {
      if (lines.length >= max) return { lines, end: at, more: true };
      lines.push(buf.toString("utf8", at, nl));
    }
    n++;
    at = nl + 1;
  }
  return { lines, end: at, more: false };
}

/** The bytes of a file from `from` to `size`. */
function readFrom(file: string, from: number, size: number): Buffer {
  const buf = Buffer.alloc(Math.max(size - from, 0));
  if (!buf.length) return buf;
  const fd = openSync(file, "r");
  try {
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, from + got);
      if (n <= 0) break;
      got += n;
    }
    return got < buf.length ? buf.subarray(0, got) : buf;
  } finally {
    closeSync(fd);
  }
}

/**
 * A run's new lines since `at` (where the last tail read to), at most `max`: only the bytes
 * added are read. Without `at`, or when the log was cut meanwhile, the whole log is read once:
 * its last `max` lines without `at`, else from `at.line` (or the first line kept, when those were
 * dropped). `more` says lines past `max` wait for the next read. Undefined for no such run.
 */
export function tailTerminalRunLines(
  root: string,
  runId: string,
  at: RunLogTail | undefined,
  max = RUN_LOG_READ_MAX,
): { from: number; lines: string[]; at: RunLogTail; more: boolean } | undefined {
  const file = join(runLogsDirOf(root), `${runId}.log`);
  for (let tries = 0; ; tries++) {
    const r = readRecord(root, runId);
    if (!r) return undefined;
    let size = 0;
    let ino = 0;
    try {
      const st = statSync(file);
      size = st.size;
      ino = st.ino;
    } catch {
      // no log yet: no lines
    }
    if (at && at.dropped === r.dropped && at.ino === ino && size >= at.bytes) {
      let buf: Buffer;
      try {
        buf = readFrom(file, at.bytes, size);
      } catch {
        buf = Buffer.alloc(0);
      }
      const got = linesIn(buf, 0, max);
      return {
        from: at.line,
        lines: got.lines,
        at: {
          line: at.line + got.lines.length,
          bytes: at.bytes + got.end,
          dropped: r.dropped,
          ino,
        },
        more: got.more,
      };
    }
    let buf: Buffer;
    try {
      buf = readFileSync(file);
    } catch {
      buf = Buffer.alloc(0);
    }
    // Cut as it was read (the record says another count now): read again, once.
    const again = readRecord(root, runId);
    if (again && again.dropped !== r.dropped && tries < 1) continue;
    let count = 0;
    for (let i = buf.indexOf(10); i >= 0; i = buf.indexOf(10, i + 1)) count++;
    const total = r.dropped + count;
    const start =
      at === undefined
        ? Math.max(total - max, r.dropped)
        : Math.max(Math.min(at.line, total), r.dropped);
    const got = linesIn(buf, start - r.dropped, max);
    return {
      from: start,
      lines: got.lines,
      at: { line: start + got.lines.length, bytes: got.end, dropped: r.dropped, ino },
      more: got.more,
    };
  }
}
