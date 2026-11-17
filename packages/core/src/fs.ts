import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  copyFile,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { CancelledError, stoppableSignal } from "./cancel.js";
import { keptFilesMayHaveChanged } from "./kept-files.js";

/**
 * Write a file so a crash never leaves it half-written: write a temporary file beside it,
 * then rename it over the old one (a rename within a folder is atomic on every platform
 * Atticus supports). The temporary name is unique, so two writers never share it. On
 * Windows a rename can fail for a moment while a virus scanner or indexer holds the file:
 * it is retried a few times before giving up.
 */
export async function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
  o: {
    /**
     * Told the size and time (ms, floored) of the file as written (beta.28.2: a writer keeps its
     * parse by them): the temporary file's, taken on its handle before the rename (which keeps
     * them), when the file has the same once renamed; not told when they differ (the file was
     * changed meanwhile, or the system set another time on close). With them, the sha256 of the
     * bytes written and `writtenAt`, the clock (ms) as the write began: a parse kept by them is
     * checked by that hash while the file's time is within the timestamp's grain of `writtenAt`
     * (record-cache.ts, `RACY_MS`).
     */
    stat?: (s: { size: number; mtimeMs: number; sha: string; writtenAt: number }) => void;
    /**
     * Only the quick tries when the file is held (`HeldOptions`): a cache's write, which may
     * fail at no cost, never waits the long wait.
     */
    quick?: boolean;
  } = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const held: HeldOptions = o.quick ? { quick: true } : {};
  try {
    if (!o.stat) {
      await writeFile(tmp, data, typeof data === "string" ? "utf8" : undefined);
      await renameRetrying(tmp, path, held);
      return;
    }
    // Before the file is there to be edited by anyone else: any later edit has a later time.
    const writtenAt = Date.now();
    const fh = await open(tmp, "w");
    let mine: { size: number; mtimeMs: number; sha: string; writtenAt: number };
    try {
      await fh.writeFile(data, typeof data === "string" ? "utf8" : undefined);
      const s = await fh.stat();
      const sha = (
        typeof data === "string"
          ? createHash("sha256").update(data, "utf8")
          : createHash("sha256").update(data)
      ).digest("hex");
      mine = { size: s.size, mtimeMs: Math.floor(s.mtimeMs), sha, writtenAt };
    } finally {
      await fh.close();
    }
    await renameRetrying(tmp, path, held);
    const now = await stat(path).catch(() => undefined);
    if (now && now.size === mine.size && Math.floor(now.mtimeMs) === mine.mtimeMs) o.stat(mine);
  } catch (e) {
    await removeTmp(tmp);
    throw e;
  } finally {
    // beta.23: the files kept read (kept-files.ts) are checked again after any write.
    keptFilesMayHaveChanged(path);
  }
}

/**
 * Write a file unless it already holds exactly these bytes: then it is left alone, its time
 * too, and false is returned (beta.28.5: a run that works out a file's content again never
 * replaces the file with itself; on Windows each replacement is a chance to meet a program that
 * holds the file, and a time that moved for nothing makes every reader of it read it again).
 */
export async function writeFileIfDiffers(path: string, data: string): Promise<boolean> {
  const now = await readFile(path).catch(() => undefined);
  if (now !== undefined && now.equals(Buffer.from(data, "utf8"))) return false;
  await writeFileAtomic(path, data);
  return true;
}

/**
 * Copy a file the way `writeFileAtomic` writes one: to a temporary file beside the target, then
 * renamed over it. The copy is made by the system (a copy-on-write clone where the file system
 * has them, APFS, Btrfs or XFS; else a copy in the kernel), so the bytes never pass through
 * JavaScript (beta.28.1: a 60-repo estate's build.json is 180 MB).
 */
export async function copyFileAtomic(from: string, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await copyFile(from, tmp, fsConstants.COPYFILE_FICLONE);
    await renameRetrying(tmp, path);
  } catch (e) {
    await removeTmp(tmp);
    throw e;
  } finally {
    keptFilesMayHaveChanged(path);
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

/**
 * How long a write waits on Windows for a file another program holds (beta.28.5): the owner's
 * run over forty repos ended on a raw EPERM after the 5 s there were, a file of the facts folder
 * open in an editor or read by an assistant's session at that moment.
 */
export const HELD_WAIT_MS = 45_000;
/**
 * The wait once a file has stayed held in this process: a cause that doesn't go away (a
 * read-only folder, a program that keeps the folder open) costs the long wait once, not once a
 * file or once a repo of a run over forty.
 */
export const HELD_AGAIN_MS = 5_000;
/** From here on the wait is said, once. */
const HELD_SAID_MS = 1_000;
/** How often a held file is tried again once the quick tries are spent. */
const HELD_EVERY_MS = 500;

/**
 * Tests' Windows: a rename and a removal that fail, a wait that takes no time, the platform,
 * where the line that says a write is waiting goes (standard error by default), and the
 * temporary file's removal.
 */
export const fsHooks: {
  rename?: (from: string, to: string) => Promise<void>;
  /** `removeHeld`'s removal. */
  remove?: (path: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  platform?: NodeJS.Platform;
  say?: (line: string) => void;
  /** The removal of a failed write's temporary file. */
  rm?: (path: string) => Promise<void>;
} = {};

/**
 * A file stayed held by another program (Windows: open in an editor, read by an assistant's
 * session, scanned) for the whole wait: nothing was written, the file is as it was, and the
 * temporary file is removed. A run over several repos reports the repo and goes on.
 */
export class FileHeldError extends Error {
  readonly code = "ATTICUS_FILE_HELD";
  constructor(
    readonly path: string,
    readonly waitedMs: number,
    override readonly cause?: unknown,
  ) {
    super(
      `${path} is open in another program (an editor, an assistant's session or a virus scan) or can't be written, and it stayed so for ${Math.round(waitedMs / 1000)} s. Nothing was lost: the file is as it was. Close it there, then run the command again.`,
    );
    this.name = "FileHeldError";
  }
}

/**
 * Whether an error is the file system's (a file held, no room, no permission, too many open
 * files: Node's system errors, which name the call that failed) rather than a bug. A run over
 * several repos says such a repo is not applied and goes on; any other error is thrown on.
 */
export function isFileSystemError(e: unknown): boolean {
  if (e instanceof FileHeldError) return true;
  if (!(e instanceof Error)) return false;
  const x = e as NodeJS.ErrnoException;
  return (
    typeof x.code === "string" &&
    /^E[A-Z0-9]+$/.test(x.code) &&
    !x.code.startsWith("ERR_") &&
    typeof x.syscall === "string"
  );
}

/** A file stayed held in this process already: the next waits are `HELD_AGAIN_MS`. */
let heldBefore = false;
/** Tests: forget that a file stayed held. */
export function forgetHeld(): void {
  heldBefore = false;
}

/** A terminal's Ctrl+C for the waits of this process (a job's Stop is heard through its own). */
let waitSignal: AbortSignal | undefined;
/**
 * The signal that ends a wait for a held file besides the job's own (`currentSignal`): a
 * command run in a terminal sets its Ctrl+C here, and clears it when it ends.
 */
export function setHeldWaitSignal(signal: AbortSignal | undefined): void {
  waitSignal = signal;
}

/** How a held file is waited for. */
export interface HeldOptions {
  /**
   * Only the quick tries (about 5 s), then the system's error, as before beta.28.5: a cache's
   * write, which may fail at no cost, and a folder's rename.
   */
  quick?: boolean;
  /** Ends the wait too (CancelledError), besides the job's Stop and the terminal's Ctrl+C. */
  signal?: AbortSignal;
  /** The quick tries (9: about 5 s). */
  tries?: number;
}

/** The temporary file of a write that failed, removed; a removal that fails hides no error. */
async function removeTmp(tmp: string): Promise<void> {
  try {
    await (fsHooks.rm ?? ((p: string) => rm(p, { force: true, maxRetries: 3, retryDelay: 50 })))(
      tmp,
    );
  } catch {
    // Held too (a scanner reading what was just written): it stays, under a name no reader of
    // records, facts or specs takes for a file of theirs (it ends .tmp); `sweepStaleTmp`
    // removes the facts folder's on a later verify.
  }
}

/** The name `writeFileAtomic` gives a temporary file: `<file>.<pid>.<8 hex>.tmp`. */
const TMP_NAME = /\.\d+\.[0-9a-f]{8}\.tmp$/;
/** A temporary file younger than this may be a write in progress (another process's). */
const TMP_STALE_MS = 3_600_000;

/**
 * Remove the temporary files an earlier run left in `dir` for the files whose names start with
 * `prefix` (a write whose temporary file could not be removed, or a process that was killed):
 * those older than an hour, so a write in progress in another process is never touched. Says
 * which it removed; a folder that can't be listed or a file that can't be removed is no error.
 */
export async function sweepStaleTmp(dir: string, prefix: string): Promise<string[]> {
  const removed: string[] = [];
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const n of names.sort()) {
    if (!n.startsWith(prefix) || !TMP_NAME.test(n)) continue;
    const full = join(dir, n);
    const s = await stat(full).catch(() => undefined);
    if (!s?.isFile() || Date.now() - s.mtimeMs < TMP_STALE_MS) continue;
    try {
      await rm(full, { force: true });
      removed.push(n);
    } catch {
      // still held: the next sweep's
    }
  }
  return removed;
}

function sayHeld(line: string): void {
  try {
    if (fsHooks.say) fsHooks.say(line);
    else process.stderr.write(`${line}\n`);
  } catch {
    // saying it never fails the write
  }
}

/** A wait of `ms` that a stop ends at once (true: stopped). */
async function waitOrStop(ms: number, signals: readonly AbortSignal[]): Promise<boolean> {
  if (signals.some((s) => s.aborted)) return true;
  if (fsHooks.sleep) {
    await fsHooks.sleep(ms);
    return signals.some((s) => s.aborted);
  }
  return new Promise<boolean>((resolve) => {
    const done = (stopped: boolean) => {
      clearTimeout(timer);
      for (const s of signals) s.removeEventListener("abort", onStop);
      resolve(stopped);
    };
    const onStop = () => done(true);
    const timer = setTimeout(() => done(false), ms);
    for (const s of signals) s.addEventListener("abort", onStop, { once: true });
  });
}

/**
 * Run `op` on `target`, trying again while the system says the file is held (EPERM, EBUSY,
 * EACCES). Up to about 5 s (20 ms doubling) wherever it runs: on Windows an editor indexing a
 * folder it has just opened, or a virus scanner, can hold a file longer than half a second (seen
 * running atticus upgrade with VS Code opening the metarepo). It only waits when the file is
 * held. Beta.28.5, on Windows: past the first second the wait is said once, naming the file;
 * after the quick tries the file is tried twice a second until `HELD_WAIT_MS` in all
 * (`HELD_AGAIN_MS` once a file has stayed held in this process), and then the error is
 * FileHeldError, in plain words, not the system's EPERM of a temporary name. A Stop (the job's,
 * or the terminal's Ctrl+C) ends the wait with CancelledError: what it leaves is what the wait
 * running out leaves, the file as it was.
 */
async function retryHeld(
  op: () => Promise<void>,
  target: string,
  o: HeldOptions = {},
): Promise<void> {
  const tries = o.tries ?? 9;
  const windows = (fsHooks.platform ?? process.platform) === "win32";
  const long = windows && !o.quick;
  const limit = heldBefore ? HELD_AGAIN_MS : HELD_WAIT_MS;
  // What ends the wait: the job's Stop while its work may still be stopped (not once it says it
  // is writing: that write finishes), a signal given, the terminal's Ctrl+C. Each only once the
  // wait is a second in: a file held for a moment is still written, whatever was asked before
  // (a job's own last writes after a Stop among them).
  const stops = [stoppableSignal(), o.signal, waitSignal].filter(
    (s): s is AbortSignal => s !== undefined,
  );
  let waited = 0;
  let said = false;
  for (let i = 0; ; i++) {
    try {
      await op();
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (!BUSY.has(code)) throw e;
      const quick = i < tries - 1;
      if (!quick && (!long || waited >= limit)) {
        if (!long) throw e;
        heldBefore = true;
        throw new FileHeldError(target, waited, e);
      }
      if (long && !said && waited >= HELD_SAID_MS) {
        said = true;
        sayHeld(
          `${target} is open in another program (an editor, an assistant's session or a virus scan): waiting for it, up to ${Math.round(Math.max(limit, waited) / 1000)} s. Close it there to go on.`,
        );
      }
      const ms = quick ? 20 * 2 ** i : Math.min(HELD_EVERY_MS, limit - waited);
      if (await waitOrStop(ms, waited >= HELD_SAID_MS ? stops : [])) throw new CancelledError();
      waited += ms;
    }
  }
}

/**
 * Rename, waiting for a held target as `retryHeld` says. The third argument is the options, or
 * the number of quick tries (as before beta.28.5).
 */
export async function renameRetrying(
  from: string,
  to: string,
  o: HeldOptions | number = {},
): Promise<void> {
  const move = fsHooks.rename ?? rename;
  await retryHeld(() => move(from, to), to, typeof o === "number" ? { tries: o } : o);
}

/**
 * Remove a file, waiting for one another program holds as a write waits (beta.28.5, the
 * review: a plain `rm` of a held file threw the system's EPERM and ended a run over forty
 * repos, as the rename had). A file that isn't there is no error.
 */
export async function removeHeld(path: string, o: HeldOptions = {}): Promise<void> {
  const remove = fsHooks.remove ?? ((p: string) => rm(p, { force: true }));
  try {
    await retryHeld(() => remove(path), path, o);
  } finally {
    keptFilesMayHaveChanged(path);
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
 * Review of beta.23: the options of a lock that guards only a quick write (a stage's loop file,
 * its thread, the stories' numbers): older than two minutes, it is stale whoever holds it.
 */
export const QUICK_WRITE_LOCK = { maxAgeMs: 120_000 } as const;

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
  o: { staleMs?: number; waitMs?: number; what?: string; maxAgeMs?: number } = {},
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
  o: { staleMs?: number; waitMs?: number; what?: string; maxAgeMs?: number },
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
      if (await isStaleShared(file, held, staleMs, o.maxAgeMs)) {
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
  maxAgeMs?: number,
): Promise<boolean> {
  // Review of beta.23: a lock that guards only a quick write (a stage's loop file, a thread, the
  // stories' numbers) is stale once older than `maxAgeMs` whoever holds it: a crash's lock whose
  // process id Windows has given to another program would otherwise block those files for good.
  if (held && maxAgeMs !== undefined) {
    const since = Date.parse(held.startedAt);
    if (Number.isFinite(since) && Date.now() - since > maxAgeMs) return true;
  }
  // Another process on this machine: by whether it is alive, never by age. Its process is gone (a
  // crash, a closed terminal): taken over at once. Review round 50: alive, it is still working
  // (a clone of a big repo outlasts any stale time), so it is waited for.
  if (held && held.host === hostname() && held.pid !== process.pid) return !alive(held.pid);
  // Otherwise by its age (another machine's process, or this process's own left by a release
  // that failed); a lock file still being written (empty, or cut short) by the file's own time.
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
