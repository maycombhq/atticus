import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Write a file so a crash never leaves it half-written: write a temporary file beside it,
 * then rename it over the old one (a rename within a folder is atomic on every platform
 * Atticus supports). The temporary name is unique, so two writers never share it. On
 * Windows a rename can fail for a moment while a virus scanner or indexer holds the file:
 * it is retried a few times before giving up.
 */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, data, typeof data === "string" ? "utf8" : undefined);
    await renameRetrying(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/** A file changed on disk between being read and being written back: nothing was written. */
export class FileChangedError extends Error {
  constructor(readonly path: string) {
    super(
      `${path} changed since it was read (another edit, or a person's): nothing was written. Read it again and redo the change.`,
    );
  }
}

// One write-back at a time per file in this process, so two edits read from one version
// can't both pass the check below.
const writing = new Map<string, Promise<unknown>>();

/**
 * Write a file back only when it still holds what the change was made from (`before`, the text
 * as read; undefined when it wasn't there), so an edit made meanwhile (another request, the CLI,
 * an editor) is never overwritten: that throws FileChangedError instead.
 */
export function writeFileIfUnchanged(
  path: string,
  before: string | undefined,
  data: string,
): Promise<void> {
  const key = resolve(path);
  const prev = writing.get(key) ?? Promise.resolve();
  const work = async () => {
    const now = await readFile(path, "utf8").catch(() => undefined);
    if (now !== before) throw new FileChangedError(path);
    await writeFileAtomic(path, data);
  };
  const next = prev.then(work, work);
  const tail = next.catch(() => undefined);
  writing.set(key, tail);
  void tail.then(() => {
    if (writing.get(key) === tail) writing.delete(key);
  });
  return next;
}

const BUSY = new Set(["EPERM", "EBUSY", "EACCES"]);

// Up to about 5 s in all (20 ms doubling): on Windows an editor indexing a folder it has just
// opened, or a virus scanner, can hold a file longer than half a second (seen running atticus
// upgrade with VS Code opening the metarepo). It only waits when the file is held.
export async function renameRetrying(from: string, to: string, tries = 9): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (!BUSY.has(code) || i >= tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 20 * 2 ** i));
    }
  }
}

// ------------------------------------------------------------------ locks

export interface LockInfo {
  pid: number;
  host: string;
  startedAt: string;
  what: string;
}

export class LockHeldError extends Error {
  constructor(
    readonly held: LockInfo,
    readonly file?: string,
  ) {
    super(
      `Another ${held.what} is running (process ${held.pid} on ${held.host}, since ${held.startedAt}). Wait for it to finish${
        file ? `; if nothing is running, delete ${file}` : ""
      }.`,
    );
    this.name = "LockHeldError";
  }
}

/** The locks this process took and still holds: one naming this process but not here is stale (a reused PID). */
const heldHere = new Set<string>();

/** Where a metarepo's locks live: .atticus/locks/, on this machine only (git-ignored). */
export const lockFileOf = (root: string, name: string) =>
  join(root, ".atticus", "locks", `${name}.json`);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Read a lock: undefined when free; `stale` when its process is gone (it was cut short). */
export async function readLock(
  root: string,
  name: string,
  o: { maxAgeMs?: number; now?: () => Date } = {},
): Promise<(LockInfo & { stale: boolean }) | undefined> {
  try {
    const file = lockFileOf(root, name);
    const info = JSON.parse(await readFile(file, "utf8")) as LockInfo;
    const here = info.host === hostname();
    const age = (o.now ?? (() => new Date()))().getTime() - Date.parse(info.startedAt);
    const stale =
      (here && (!alive(info.pid) || (info.pid === process.pid && !heldHere.has(file)))) ||
      (o.maxAgeMs !== undefined && Number.isFinite(age) && age > o.maxAgeMs);
    return { ...info, stale };
  } catch {
    return undefined;
  }
}

/**
 * Take a lock for a long write (a scan): one at a time per metarepo. A lock whose process is
 * gone was cut short (a crash, a closed terminal); it is taken over and reported as
 * `interrupted`, so the caller can say the last run didn't finish.
 */
export async function acquireLock(
  root: string,
  name: string,
  what: string,
  now: () => Date = () => new Date(),
  /** A lock older than this is taken over (Windows reuses a dead process's PID). */
  o: { maxAgeMs?: number } = {},
): Promise<{ release: () => Promise<void>; interrupted?: LockInfo }> {
  const file = lockFileOf(root, name);
  await ensureLocalIgnore(root);
  await mkdir(dirname(file), { recursive: true });
  const info: LockInfo = {
    pid: process.pid,
    host: hostname(),
    startedAt: now().toISOString(),
    what,
  };
  let interrupted: LockInfo | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(file, JSON.stringify(info), { encoding: "utf8", flag: "wx" });
      heldHere.add(file);
      const release = async () => {
        const cur = await readLock(root, name);
        if (cur && cur.pid === info.pid && cur.startedAt === info.startedAt)
          await rm(file, { force: true });
        heldHere.delete(file);
      };
      return interrupted ? { release, interrupted } : { release };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const held = await readLock(root, name, { ...o, now });
      if (held && !held.stale) throw new LockHeldError(held, file);
      if (held) {
        const { stale: _s, ...rest } = held;
        interrupted = rest;
      }
      await rm(file, { force: true });
    }
  }
  throw new Error(`Couldn't take the ${name} lock at ${file}.`);
}

// ------------------------------------------------------- a file shared between processes

/** The lock file beside a file two processes write (`<file>.lock`): no facts-folder reader takes it for a file of its own. */
export const sharedLockFileOf = (path: string) => `${path}.lock`;

interface SharedLockInfo extends LockInfo {
  /** Which take of the lock this is, so a holder only ever removes its own. */
  token: string;
}

// One holder at a time per file in this process, before the lock file is tried.
const sharing = new Map<string, Promise<unknown>>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Review round 46: run `work` holding a file that another process may append to or rewrite at
 * the same time (a repo's corrections: the app server appends, a CLI command rewrites it), so a
 * read, change and write never loses what the other wrote meanwhile. In this process the writers
 * of one file queue; between processes `<file>.lock` is created with `wx` (which fails when it is
 * there), retried with a short backoff. A lock whose process is gone, or older than `staleMs`, is
 * taken over; after `waitMs` it gives up with LockHeldError naming the holder. No `flock`, so it
 * works the same on Windows, where a lock file being deleted can refuse for a moment (EPERM,
 * EBUSY): those are retried.
 */
export function withSharedFileLock<T>(
  path: string,
  work: () => Promise<T>,
  o: { staleMs?: number; waitMs?: number; what?: string } = {},
): Promise<T> {
  const key = resolve(path);
  const prev = sharing.get(key) ?? Promise.resolve();
  const run = async () => {
    const release = await takeSharedLock(key, o);
    try {
      return await work();
    } finally {
      await release();
    }
  };
  const next = prev.then(run, run);
  const tail = next.catch(() => undefined);
  sharing.set(key, tail);
  void tail.then(() => {
    if (sharing.get(key) === tail) sharing.delete(key);
  });
  return next;
}

async function takeSharedLock(
  path: string,
  o: { staleMs?: number; waitMs?: number; what?: string },
): Promise<() => Promise<void>> {
  const file = sharedLockFileOf(path);
  const staleMs = o.staleMs ?? 10_000;
  const waitMs = o.waitMs ?? 15_000;
  const info: SharedLockInfo = {
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
    what: o.what ?? `write of ${basename(path)}`,
    token: randomBytes(8).toString("hex"),
  };
  await mkdir(dirname(file), { recursive: true });
  const start = Date.now();
  let delay = 5;
  for (;;) {
    let code: string;
    try {
      await writeFile(file, JSON.stringify(info), { encoding: "utf8", flag: "wx" });
      return () => releaseShared(file, info.token);
    } catch (e) {
      code = (e as NodeJS.ErrnoException).code ?? "";
      if (code !== "EEXIST" && !BUSY.has(code)) throw e;
    }
    let held: LockInfo | undefined;
    if (code === "EEXIST") {
      const seen = await readFile(file, "utf8").catch(() => undefined);
      // Let go meanwhile: try again at once.
      if (seen === undefined) continue;
      held = parseLockInfo(seen);
      if (await isStaleShared(file, held, staleMs)) {
        await takeOver(file, seen, info.token);
        continue;
      }
    }
    if (Date.now() - start > waitMs)
      throw new LockHeldError(
        held ?? { pid: 0, host: "?", startedAt: "?", what: `write of ${basename(path)}` },
        file,
      );
    await sleep(delay + Math.floor(Math.random() * delay));
    delay = Math.min(delay * 2, 100);
  }
}

function parseLockInfo(text: string): LockInfo | undefined {
  try {
    const j = JSON.parse(text) as Partial<LockInfo>;
    return typeof j.pid === "number" && typeof j.startedAt === "string"
      ? {
          pid: j.pid,
          host: String(j.host ?? ""),
          startedAt: j.startedAt,
          what: String(j.what ?? ""),
        }
      : undefined;
  } catch {
    return undefined;
  }
}

async function isStaleShared(
  file: string,
  held: LockInfo | undefined,
  staleMs: number,
): Promise<boolean> {
  // Its process is gone (a crash, a closed terminal): taken over at once.
  if (held && held.host === hostname() && held.pid !== process.pid && !alive(held.pid)) return true;
  // Otherwise by its age (another machine's process, a reused PID); a lock file still being
  // written (empty, or cut short) by the file's own time.
  const since = held
    ? Date.parse(held.startedAt)
    : await stat(file).then(
        (s) => s.mtimeMs,
        () => NaN,
      );
  return Number.isFinite(since) && Date.now() - since > staleMs;
}

/** Move a stale lock aside, and keep it gone only when it is the one judged stale. */
async function takeOver(file: string, seen: string, token: string): Promise<void> {
  const aside = `${file}.${token}.stale`;
  try {
    await rename(file, aside);
  } catch {
    // Another process took it over first, or it was let go.
    return;
  }
  const moved = await readFile(aside, "utf8").catch(() => undefined);
  // A fresh lock taken meanwhile went aside instead: put it back, unless a lock is there again.
  if (moved !== undefined && moved !== seen) await link(aside, file).catch(() => undefined);
  await rmRetrying(aside);
}

async function releaseShared(file: string, token: string): Promise<void> {
  const now = await readFile(file, "utf8").catch(() => undefined);
  if (now === undefined) return;
  try {
    if ((JSON.parse(now) as { token?: string }).token !== token) return;
  } catch {
    return;
  }
  await rmRetrying(file);
}

async function rmRetrying(file: string, tries = 9): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await rm(file, { force: true });
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (!BUSY.has(code) || i >= tries - 1) throw e;
      await sleep(20 * 2 ** i);
    }
  }
}

/**
 * What stays on this machine inside .atticus/: the person's settings, the log, locks, upgrade
 * backups, the prompt and response history (ADR 0110), what `atticus probe` measured of the
 * person's assistant (ADR 0124 addendum A-probe) and the parses kept between runs
 * (`cache/`, record-cache.ts).
 */
export const LOCAL_ONLY = [
  "me.yaml",
  "logs/",
  "locks/",
  "backups/",
  "history/",
  "probe/",
  "cache/",
  // ADR 0161: where `atticus map --all` is in the estate, so running it again resumes.
  "map-all/",
] as const;

/**
 * Make sure .atticus/.gitignore keeps this machine's files out of Git. It lives inside
 * .atticus/, so it works the same in a metarepo and in a repo adopted in place (where Atticus
 * writes nothing outside .atticus/).
 */
export async function ensureLocalIgnore(root: string): Promise<void> {
  const file = join(root, ".atticus", ".gitignore");
  const text = await readFile(file, "utf8").catch(() => "");
  const have = new Set(text.split(/\r?\n/).map((l) => l.trim()));
  const missing = LOCAL_ONLY.filter((l) => !have.has(l));
  if (!missing.length) return;
  const prefix = text && !text.endsWith("\n") ? `${text}\n` : text;
  await writeFileAtomic(
    file,
    `${prefix}${prefix ? "" : "# This machine's own files: never committed.\n"}${missing.join("\n")}\n`,
  );
}
