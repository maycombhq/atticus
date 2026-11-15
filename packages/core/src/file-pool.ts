import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

/**
 * Reading and hashing many small files (beta.28.2): a catalog's 100,000 record files took 10 to
 * 13 s to hash through the promise API, four calls each (open, stat, read, close) handed to
 * libuv's thread pool and back, and each text decoded, its line endings replaced and encoded again
 * to be hashed. Here a few worker threads read them with the synchronous calls, one file at a
 * time each (so no more than one open file a worker: no EMFILE, on Windows either), and hash the
 * bytes; the main thread stays free (a progress line, Stop between steps) and gets the results in
 * the order of the paths, whatever the order the workers finish in. Every byte of every file is
 * read: nothing is taken from a file's size and time. A small folder, or a process where a worker
 * can't start, is read in this thread instead, to the same results.
 */

/** A file's size and time (ms, floored), as `stat` gives them. */
export interface FileStat {
  size: number;
  mtimeMs: number;
}

/** A file's size and time, and the hash of its text with its line endings LF (`textShaOf`). */
export interface FileHash extends FileStat {
  sha: string;
}

/**
 * How the files are read: tests force a number of workers (0: this thread) and the smallest
 * folder read by workers. By default 2 to 4 workers (one fewer than the CPUs, at least 2), for
 * folders of `MIN_FILES` files or more.
 */
export const filePoolHooks: {
  workers?: number;
  minFiles?: number;
  /** A test's workers that fail as they start (as one that can't: ERR_WORKER_INIT_FAILED, OOM). */
  failStart?: boolean;
} = {};

/** Below this many files the workers' start costs more than they save. */
const MIN_FILES = 512;
/** Paths a worker is given at a time: few messages, and the work still shared out evenly. */
const BATCH = 256;
/** How many files this thread reads at once when no worker does (as before beta.28.2). */
const READ_AT_ONCE = 32;

const LF = (text: string) => text.replace(/\r\n?/g, "\n");

/**
 * The hash of a file's text, read as UTF-8, with its line endings LF: `sha256Of` of that text.
 * Bytes that are UTF-8 with no CR are that text's own bytes, so they are hashed as they are;
 * any other (a CR, a byte that isn't UTF-8, read as U+FFFD) are decoded first, as a read gives.
 */
export function textShaOf(bytes: Buffer): string {
  const h = createHash("sha256");
  if (!bytes.includes(13) && isUtf8(bytes)) h.update(bytes);
  else h.update(LF(bytes.toString("utf8")), "utf8");
  return h.digest("hex");
}

function workersFor(files: number): number {
  const forced = filePoolHooks.workers;
  if (files === 0) return 0;
  if (files < (filePoolHooks.minFiles ?? MIN_FILES)) return 0;
  if (forced !== undefined) return Math.max(0, Math.floor(forced));
  // At least 2, even on 1 or 2 CPUs: with the files not in the page cache each worker waits on
  // the disk one file at a time, and two halve that wait (measured on 2 CPUs: 48,000 files cold
  // 6.9 s with 1, 3.6 s with 2; warm 0.55 s and 0.8 s).
  return Math.min(4, Math.max(2, availableParallelism() - 1));
}

/**
 * The worker's code, as text (a worker of `eval`: no file to find beside a bundle). It is told a
 * folder and a batch of paths under it (forward slashes) and answers each file's size, time and,
 * for a hash, its text hash, computed as `textShaOf` does; a file that can't be read ends the
 * batch with its error (its code and message), as the promise API would have thrown it.
 */
const WORKER = `
const { parentPort } = require("node:worker_threads");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { isUtf8 } = require("node:buffer");
const at = (dir, rel) => path.join(dir, ...rel.split("/"));
parentPort.postMessage({ ready: true });
parentPort.on("message", ({ id, dir, rels, hash }) => {
  const out = new Array(rels.length);
  try {
    for (let k = 0; k < rels.length; k++) {
      if (!hash) {
        let s;
        try { s = fs.statSync(at(dir, rels[k])); } catch { s = undefined; }
        out[k] = s ? [s.size, Math.floor(s.mtimeMs)] : null;
        continue;
      }
      const fd = fs.openSync(at(dir, rels[k]), "r");
      try {
        const s = fs.fstatSync(fd);
        const bytes = fs.readFileSync(fd);
        // The same hash as textShaOf, written again here (a worker of eval can't import it).
        const h = createHash("sha256");
        if (!bytes.includes(13) && isUtf8(bytes)) h.update(bytes);
        else h.update(bytes.toString("utf8").replace(/\\r\\n?/g, "\\n"), "utf8");
        out[k] = [s.size, Math.floor(s.mtimeMs), h.digest("hex")];
      } finally {
        fs.closeSync(fd);
      }
    }
    parentPort.postMessage({ id, out });
  } catch (e) {
    parentPort.postMessage({ id, error: { message: String(e && e.message), code: e && e.code } });
  }
});
`;

type Row = [number, number] | [number, number, string] | null;

/** The folder's files through `n` workers, each given a batch at a time; rows in the paths' order. */
async function throughWorkers(
  n: number,
  dir: string,
  rels: readonly string[],
  hash: boolean,
): Promise<Row[]> {
  const rows = new Array<Row>(rels.length);
  const workers: Worker[] = [];
  const code = filePoolHooks.failStart
    ? `throw new Error("a test's worker fails to start");`
    : WORKER;
  // A process where a worker can't start (a sandbox, a host without them, a worker out of memory
  // or failing as it starts, before its first answer): this thread reads.
  let started: boolean;
  try {
    for (let i = 0; i < n; i++) workers.push(new Worker(code, { eval: true }));
    started = (
      await Promise.all(
        workers.map(
          (w) =>
            new Promise<boolean>((resolve) => {
              w.once("message", (m: { ready?: boolean }) => resolve(m.ready === true));
              w.once("error", () => resolve(false));
              w.once("exit", () => resolve(false));
            }),
        ),
      )
    ).every(Boolean);
  } catch {
    started = false;
  }
  if (!started) {
    await Promise.all(workers.map((w) => w.terminate()));
    return inThread(dir, rels, hash);
  }
  let next = 0;
  try {
    await Promise.all(
      workers.map(
        (w) =>
          new Promise<void>((resolve, reject) => {
            const give = () => {
              if (next >= rels.length) return resolve();
              const from = next;
              next = Math.min(rels.length, next + BATCH);
              w.postMessage({ id: from, dir, rels: rels.slice(from, next), hash });
            };
            w.on(
              "message",
              (m: { id: number; out?: Row[]; error?: { message: string; code?: string } }) => {
                if (m.error) {
                  next = rels.length;
                  const e = new Error(m.error.message) as NodeJS.ErrnoException;
                  if (m.error.code) e.code = m.error.code;
                  return reject(e);
                }
                m.out!.forEach((r, k) => (rows[m.id + k] = r));
                give();
              },
            );
            w.on("error", reject);
            w.on("exit", (code) => {
              if (next < rels.length || code !== 0)
                reject(new Error(`a file reader stopped (${code})`));
            });
            give();
          }),
      ),
    );
  } finally {
    await Promise.all(workers.map((w) => w.terminate()));
  }
  return rows;
}

/** The folder's files in this thread, a few dozen at once (a small folder, or no workers). */
async function inThread(dir: string, rels: readonly string[], hash: boolean): Promise<Row[]> {
  const rows = new Array<Row>(rels.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(READ_AT_ONCE, rels.length) }, async () => {
      for (let k = next++; k < rels.length; k = next++) {
        const full = join(dir, ...rels[k]!.split("/"));
        if (!hash) {
          const s = await stat(full).catch(() => undefined);
          rows[k] = s ? [s.size, Math.floor(s.mtimeMs)] : null;
          continue;
        }
        // Its size and time from the open file, as readFile itself looks them up.
        const fh = await open(full, "r");
        try {
          const s = await fh.stat();
          rows[k] = [s.size, Math.floor(s.mtimeMs), textShaOf(await fh.readFile())];
        } finally {
          await fh.close();
        }
      }
    }),
  );
  return rows;
}

function rowsOf(dir: string, rels: readonly string[], hash: boolean): Promise<Row[]> {
  const n = workersFor(rels.length);
  return n > 0 ? throughWorkers(n, dir, rels, hash) : inThread(dir, rels, hash);
}

/**
 * Every named file under `dir` (paths with forward slashes), read whole and hashed: its text hash
 * (`textShaOf`), size and time, in the order of `rels`. A file that can't be opened or read fails
 * the call with that error (its `code`: ENOENT for one gone since it was listed).
 */
export async function hashFilesIn(dir: string, rels: readonly string[]): Promise<FileHash[]> {
  return (await rowsOf(dir, rels, true)).map((r) => ({ sha: r![2]!, size: r![0], mtimeMs: r![1] }));
}

/** Every named file's size and time (ms, floored), in the order of `rels`; none for one not there. */
export async function statFilesIn(
  dir: string,
  rels: readonly string[],
): Promise<(FileStat | undefined)[]> {
  return (await rowsOf(dir, rels, false)).map((r) =>
    r ? { size: r[0], mtimeMs: r[1] } : undefined,
  );
}
