import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CancelledError } from "./cancel.js";
import { hashFilesIn, statFilesIn, type FileHash } from "./file-pool.js";
import { ensureLocalIgnore, writeFileAtomic } from "./fs.js";
import { RACY_MS, recordCacheHooks } from "./record-cache.js";

/**
 * The text hashes of a folder's files, kept between runs (beta.28.5, the owner's field report of
 * beta.28.4: every build spent 20 to 34 s "reading the catalog's files to check the build" on a
 * Windows laptop with antivirus, 12,832 record files opened and hashed by each command of a run
 * of forty, although none had changed; an open is what such a machine makes slow, a stat is not).
 *
 * Each file's hash (`textShaOf`, what `hashFilesIn` gives) is kept in
 * `<cacheRoot>/.atticus/cache/`, by the file's path, size and modification time, under the rule
 * the kept parses go by (record-cache.ts, ADR 0119 with its addendum, Git's "racily clean"):
 *
 * - a file whose size, time or change time is another than the one its hash was kept by is read
 *   and hashed. The change time (ctime) is the system's own record of the last change to the
 *   file's bytes or its times, and no program sets it: an edit that puts the file's time back
 *   (a copy that keeps times, a restore) still moves it, which size and time alone would miss;
 * - so is a file whose time or change time is within `RACY_MS` of the moment its hash was kept
 *   (a same-size edit within the timestamp's grain could keep them), until a later read finds
 *   it older;
 * - any other file is not opened: any edit after its hash was kept has a later change time.
 *
 * So a hand edit of a record file is seen as it was before (the build's guards compare these
 * hashes with build.json's), a same-size edit included, and a run with nothing changed costs a
 * stat per file. The cache is derived, local to this machine and never committed; one that can't
 * be read costs the hashes, one that can't be written costs the next run's. A read that names no
 * `cacheRoot` keeps nothing and writes nothing (ADR 0038), and one with `keep: false` (a
 * preview) reads what is kept and writes nothing.
 */

/**
 * Tests hear how many files each call opened and hashed; with `off`, every file is read and
 * hashed and nothing is kept, as before there were kept hashes (an equivalence test's other side).
 */
export const hashCacheHooks: { onHashed?: (files: number) => void; off?: boolean } = {};

/** The shape of what is kept; another version is hashed again from the files. */
const VERSION = "1";

interface Kept {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  /** The clock (ms) before the bytes hashed were read. */
  at: number;
  sha: string;
}

interface Memo {
  v: string;
  dir: string;
  entries: Record<
    string,
    [size: number, mtimeMs: number, ctimeMs: number, at: number, sha: string]
  >;
}

const now = () => (recordCacheHooks.now ?? Date.now)();

function memoFileOf(cacheRoot: string, dir: string): { root: string; file: string } {
  const root = resolve(cacheRoot);
  const key = createHash("sha256").update(resolve(dir)).digest("hex").slice(0, 16);
  return { root, file: join(root, ".atticus", "cache", `hashes-${key}.json`) };
}

async function readMemo(file: string, dir: string): Promise<Map<string, Kept>> {
  const out = new Map<string, Kept>();
  try {
    const m = JSON.parse(await readFile(file, "utf8")) as Memo | null;
    if (!m || m.v !== VERSION || m.dir !== resolve(dir) || typeof m.entries !== "object")
      return out;
    for (const [rel, e] of Object.entries(m.entries)) {
      if (!Array.isArray(e) || e.length !== 5) return new Map();
      const [size, mtimeMs, ctimeMs, at, sha] = e;
      if (
        typeof size !== "number" ||
        typeof mtimeMs !== "number" ||
        typeof ctimeMs !== "number" ||
        typeof at !== "number" ||
        typeof sha !== "string"
      )
        return new Map();
      out.set(rel, { size, mtimeMs, ctimeMs, at, sha });
    }
    return out;
  } catch {
    // No cache yet, or one that doesn't read: the files are hashed instead.
    return new Map();
  }
}

/**
 * Every named file under `dir` with its text hash, size and time, in the order of `files`, as
 * `hashFilesIn` gives them: from the hashes kept under `cacheRoot` for the files that haven't
 * changed since, from the files for the rest. A file that can't be opened fails the call, as
 * there (ENOENT for one gone since it was listed).
 */
export async function hashFilesKept(o: {
  dir: string;
  /** Relative to `dir`, with forward slashes. */
  files: readonly string[];
  /** The metarepo this run is working in; none: every file is hashed and nothing is kept. */
  cacheRoot?: string;
  /** False: the kept hashes are read and nothing is written (a preview). */
  keep?: boolean;
  /** A job's Stop: ends the read with CancelledError; nothing is kept of a stopped read. */
  signal?: AbortSignal;
}): Promise<FileHash[]> {
  const stop = o.signal ? { signal: o.signal } : {};
  if (!o.cacheRoot || hashCacheHooks.off) {
    const all = await hashFilesIn(o.dir, o.files, stop);
    hashCacheHooks.onHashed?.(o.files.length);
    return all.map((h) => ({ sha: h.sha, size: h.size, mtimeMs: h.mtimeMs }));
  }
  const memo = memoFileOf(o.cacheRoot, o.dir);
  const had = await readMemo(memo.file, o.dir);
  const stats = had.size ? await statFilesIn(o.dir, o.files, { ...stop, ctime: true }) : [];
  const out = new Array<FileHash>(o.files.length);
  const fresh = new Map<string, Kept>();
  const toHash: number[] = [];
  o.files.forEach((rel, i) => {
    const s = stats[i];
    const hit = had.get(rel);
    if (
      s &&
      hit &&
      hit.size === s.size &&
      hit.mtimeMs === s.mtimeMs &&
      hit.ctimeMs === s.ctimeMs &&
      Math.max(hit.mtimeMs, hit.ctimeMs) < hit.at - RACY_MS
    ) {
      fresh.set(rel, hit);
      out[i] = { sha: hit.sha, size: hit.size, mtimeMs: hit.mtimeMs };
    } else toHash.push(i);
  });
  // Before any byte is read: an edit after this has a later time, less the grain.
  const at = now();
  if (toHash.length) {
    const hashed = await hashFilesIn(
      o.dir,
      toHash.map((i) => o.files[i]!),
      { ...stop, ctime: true },
    );
    toHash.forEach((i, k) => {
      const h = hashed[k]!;
      out[i] = { sha: h.sha, size: h.size, mtimeMs: h.mtimeMs };
      fresh.set(o.files[i]!, {
        size: h.size,
        mtimeMs: h.mtimeMs,
        ctimeMs: h.ctimeMs!,
        at,
        sha: h.sha,
      });
    });
  }
  if (o.signal?.aborted) throw new CancelledError();
  hashCacheHooks.onHashed?.(toHash.length);
  if (o.keep !== false && (toHash.length > 0 || fresh.size !== had.size)) {
    const m: Memo = {
      v: VERSION,
      dir: resolve(o.dir),
      entries: Object.fromEntries(
        [...fresh].map(([rel, e]) => [rel, [e.size, e.mtimeMs, e.ctimeMs, e.at, e.sha]]),
      ),
    };
    try {
      // The cache sits in .atticus/, which stays on this machine: make sure Git ignores it.
      await ensureLocalIgnore(memo.root);
      await writeFileAtomic(memo.file, JSON.stringify(m));
    } catch {
      // A read-only or full disk costs the next run its hashes, nothing else.
    }
  }
  return out;
}
