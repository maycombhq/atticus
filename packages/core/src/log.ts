import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { LOCAL_ONLY } from "./fs.js";

/**
 * The local log (ADR 0050): one JSON object per line in `.atticus/logs/atticus.log`,
 * kept on this machine. It records what ran (command and flag names, never their values),
 * how it ended, how long it took and, on a crash, the error with its stack. Every entry is
 * redacted before it is written: secrets, credentials in URLs, tokens and the person's home
 * folder never reach the file.
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "off";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, off: 100 };

export interface LogEntry {
  at: string;
  level: Exclude<LogLevel, "off">;
  event: string;
  [field: string]: unknown;
}

export interface Log {
  readonly file: string;
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, err: unknown, fields?: Record<string, unknown>): void;
}

export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export const LOG_KEEP = 3;

/** Where the log of a metarepo lives. */
export const logFileOf = (root: string) => join(root, ".atticus", "logs", "atticus.log");

const SECRET_KEY =
  /(token|password|passwd|pwd|secret|api[-_]?key|private[-_]?key|credential|authorization|cookie|session)/i;

/** Strings with anything that looks like a secret replaced by "***", and home folders by "~". */
export function redactText(s: string, o: { home?: string; user?: string } = {}): string {
  let out = s
    // user:password@ in URLs
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s:]+:[^/@\s]+@/gi, "$1***@")
    // Authorization: Bearer xyz, Basic xyz
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ***")
    // token=..., "password": "...", api_key: ...
    .replace(
      new RegExp(`(${SECRET_KEY.source})(["']?\\s*[:=]\\s*["']?)([^\\s"',;&]+)`, "gi"),
      "$1$3***",
    )
    // JWTs, and long opaque keys: mixed case with digits. Ids are lower-case words and a sha256
    // Atticus prints is lower-case hex, so both stay readable.
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, "***")
    .replace(
      /\b(?=[A-Za-z0-9+_-]*\d)(?=[A-Za-z0-9+_-]*[A-Z])(?=[A-Za-z0-9+_-]*[a-z])[A-Za-z0-9+_-]{32,}={0,2}/g,
      "***",
    );
  const home = o.home ?? safeHome();
  if (home && home.length > 3) out = out.split(home).join("~");
  const user = o.user ?? safeUser();
  if (user && user.length > 2)
    out = out.replace(new RegExp(`([\\\\/])${escapeRe(user)}(?=[\\\\/])`, "g"), "$1<user>");
  return out;
}

/** A value with secret-named keys masked and every string redacted. */
export function redact(v: unknown, o: { home?: string; user?: string } = {}): unknown {
  if (typeof v === "string") return redactText(v, o);
  if (Array.isArray(v)) return v.map((x) => redact(x, o));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEY.test(k) ? "***" : redact(x, o);
    return out;
  }
  return v;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function safeHome() {
  try {
    return homedir();
  } catch {
    return undefined;
  }
}
function safeUser() {
  try {
    return userInfo().username;
  } catch {
    return undefined;
  }
}

function rotate(file: string, max: number, keep: number) {
  try {
    if (statSync(file).size < max) return;
  } catch {
    return;
  }
  rmSync(`${file}.${keep}`, { force: true });
  for (let i = keep - 1; i >= 1; i--) {
    try {
      renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    } catch {
      // that generation doesn't exist yet
    }
  }
  try {
    renameSync(file, `${file}.1`);
  } catch {
    // another process rotated it first
  }
}

/** The level from ATTICUS_LOG (debug, info, warn, error or off); info by default. */
export function logLevelFrom(env: NodeJS.ProcessEnv = process.env): LogLevel {
  const v = (env.ATTICUS_LOG ?? "").toLowerCase();
  return v in ORDER ? (v as LogLevel) : "info";
}

/**
 * A log for a metarepo. Writing never throws: a log that can't be written (a read-only folder,
 * a full disk) is skipped rather than failing the command it describes.
 */
export function createLog(
  root: string,
  o: { level?: LogLevel; now?: () => Date; maxBytes?: number; keep?: number } = {},
): Log {
  const file = logFileOf(root);
  const level = o.level ?? logLevelFrom();
  const now = o.now ?? (() => new Date());
  const write = (lvl: Exclude<LogLevel, "off">, event: string, fields: Record<string, unknown>) => {
    if (ORDER[lvl] < ORDER[level]) return;
    try {
      mkdirSync(join(file, ".."), { recursive: true });
      ignoreLocalSync(root);
      rotate(file, o.maxBytes ?? LOG_MAX_BYTES, o.keep ?? LOG_KEEP);
      const entry = redact({ at: now().toISOString(), level: lvl, event, ...fields });
      appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
    } catch {
      // never fail a command over its log
    }
  };
  return {
    file,
    debug: (e, f = {}) => write("debug", e, f),
    info: (e, f = {}) => write("info", e, f),
    warn: (e, f = {}) => write("warn", e, f),
    error: (e, err, f = {}) =>
      write("error", e, {
        ...f,
        error:
          err instanceof Error
            ? { name: err.name, message: err.message, stack: err.stack?.split("\n").slice(0, 25) }
            : { message: String(err) },
      }),
  };
}

/** ensureLocalIgnore, for the log's synchronous writes. */
function ignoreLocalSync(root: string) {
  const f = join(root, ".atticus", ".gitignore");
  const text = existsSync(f) ? readFileSync(f, "utf8") : "";
  const have = new Set(text.split(/\r?\n/).map((l) => l.trim()));
  const missing = LOCAL_ONLY.filter((l) => !have.has(l));
  if (!missing.length) return;
  const prefix = text && !text.endsWith("\n") ? `${text}\n` : text;
  const head = prefix ? "" : "# This machine's own files: never committed.\n";
  writeFileSync(f, `${prefix}${head}${missing.join("\n")}\n`, "utf8");
}

/** A log that writes nothing (tests, and commands run with no metarepo). */
export const NO_LOG: Log = {
  file: "",
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
