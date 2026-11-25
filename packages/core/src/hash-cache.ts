import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { CancelledError } from "./cancel.js";
import { hashFilesIn, statFilesIn, type FileHash } from "./file-pool.js";
import { ensureLocalIgnore } from "./fs.js";
import { cacheDirKey, RACY_MS, recordCacheHooks } from "./record-cache.js";

/**
 * The text hashes of a folder's files, kept between runs (beta.28.5, the owner's field report of
 * beta.28.4: every build spent 20 to 34 s "reading the catalog's files to check the build" on a
 * Windows laptop with antivirus, 12,832 record files opened and hashed by each command of a run
 * of forty, although none had changed; an open is what such a machine makes slow, a stat is not).
 *
 * Each file's hash (`textShaOf`, what `hashFilesIn` gives) is kept in
 * `<cacheRoot>/.atticus/cache/` (a new file each generation, item 11), by the file's path, size and modification time, under the rule
 * the kept parses go by (record-cache.ts, ADR 0119 with its addendum, Git's "racily clean"):
 *
 * - a file whose size, time, change time or identity (its inode, NTFS's file id; not compared
 *   where the platform reports none) is another than the one its hash was kept by is read
 *   and hashed. The change time (ctime) is the system's own record of the last change to the
 *   file's bytes or its times, and no program sets it: an edit that puts the file's time back
 *   (a copy that keeps times, a restore) still moves it, which size and time alone would miss;
 * - so is a file whose time is within `RACY_MS` of the moment its hash was kept, or its change
 *   time within the file system clock's lag of it (a same-size edit within the timestamp's grain
 *   could keep them), until a later read finds it older (`keptHolds`);
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
export const hashCacheHooks: {
  onHashed?: (files: number) => void;
  off?: boolean;
  /** Told the error code of a cache that couldn't be written (the next run reads every file). */
  onWriteFailed?: (code: string) => void;
} = {};

/** The shape of what is kept; another version is hashed again from the files. */
const VERSION = "2";

interface Kept {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  /** The file's identity (inode, NTFS's file id); 0: the platform reports none. */
  ino: number;
  /** The clock (ms) before the bytes hashed were read. */
  at: number;
  sha: string;
}

interface Memo {
  v: string;
  dir: string;
  entries: Record<
    string,
    [size: number, mtimeMs: number, ctimeMs: number, ino: number, at: number, sha: string]
  >;
}

const now = () => (recordCacheHooks.now ?? Date.now)();

function memoFileOf(cacheRoot: string, dir: string): { root: string; dir: string; name: string } {
  const root = resolve(cacheRoot);
  const key = createHash("sha256").update(cacheDirKey(dir)).digest("hex").slice(0, 16);
  return { root, dir: join(root, ".atticus", "cache"), name: `hashes-${key}` };
}

/** The cache's generations, newest first (`hashes-<key>.<n>.json`). */
async function generations(memo: { dir: string; name: string }): Promise<number[]> {
  const names = await readdir(memo.dir).catch(() => [] as string[]);
  return names
    .map((n) =>
      n.startsWith(`${memo.name}.`) ? /^\.(\d+)\.json$/.exec(n.slice(memo.name.length)) : null,
    )
    .flatMap((m) => (m ? [Number(m[1])] : []))
    .sort((a, b) => b - a);
}

async function readMemo(
  memo: { dir: string; name: string },
  dir: string,
): Promise<{ kept: Map<string, Kept>; top: number }> {
  const ns = await generations(memo);
  // The newest that reads: one cut short (a stopped write) leaves the one before it.
  for (const n of ns) {
    const kept = await readGeneration(join(memo.dir, `${memo.name}.${n}.json`), dir);
    if (kept) return { kept, top: ns[0]! };
  }
  return { kept: new Map(), top: ns[0] ?? 0 };
}

async function readGeneration(file: string, dir: string): Promise<Map<string, Kept> | undefined> {
  const out = new Map<string, Kept>();
  try {
    const m = JSON.parse(await readFile(file, "utf8")) as Memo | null;
    if (!m || m.v !== VERSION || m.dir !== cacheDirKey(dir) || typeof m.entries !== "object")
      return undefined;
    for (const [rel, e] of Object.entries(m.entries)) {
      if (!Array.isArray(e) || e.length !== 6) return undefined;
      const [size, mtimeMs, ctimeMs, ino, at, sha] = e;
      if (
        typeof size !== "number" ||
        typeof mtimeMs !== "number" ||
        typeof ctimeMs !== "number" ||
        typeof ino !== "number" ||
        typeof at !== "number" ||
        typeof sha !== "string"
      )
        return undefined;
      out.set(rel, { size, mtimeMs, ctimeMs, ino, at, sha });
    }
    return out;
  } catch {
    // Not there, or doesn't read: an older generation, or the files hashed instead.
    return undefined;
  }
}

/**
 * Whether what was kept of a file at `kept.at` still stands for it, by its stat now (here and in
 * intake's kept reads). The size, time and identity must match, and the change time too: any
 * write moves it, and no program sets it, so a same-size edit that put the file's time back is
 * still read (the change time differs from the one kept), and only a change of the change time
 * alone (OneDrive, a backup, Git's autocrlf on NTFS) costs a read, once: what is kept again has
 * the new change time. The modification time is racy within `RACY_MS` of `at` (FAT's 2 s grain);
 * the change time within `CTIME_RACY_MS`, the lag of a file system's clock behind this one's,
 * unless it is a whole second (a file system that keeps seconds only: `RACY_MS` then).
 */
export function keptHolds(
  kept: { size: number; mtimeMs: number; ctimeMs: number; ino: number; at: number },
  s: { size: number; mtimeMs: number; ctimeMs?: number; ino?: number } | undefined,
): boolean {
  if (!s || kept.size !== s.size || kept.mtimeMs !== s.mtimeMs || kept.ctimeMs !== s.ctimeMs)
    return false;
  // Another file at this path (one moved over it with its times kept); not compared where
  // either side has no identity to tell.
  if (kept.ino !== 0 && s.ino && kept.ino !== s.ino) return false;
  const ctimeGrain = kept.ctimeMs % 1000 === 0 ? RACY_MS : CTIME_RACY_MS;
  return kept.mtimeMs < kept.at - RACY_MS && kept.ctimeMs < kept.at - ctimeGrain;
}

/** How far a file system's clock may lag this one's (a jiffy, NTFS's 15.6 ms tick), with room. */
const CTIME_RACY_MS = 100;

/**
 * Why the hashes under `cacheRoot` couldn't be kept now (the error's code), by a file made and
 * removed in the cache's folder; none when one can, or when nothing was ever kept there
 * (`atticus selfcheck --timing`, which otherwise writes nothing).
 */
export async function hashCacheWriteProblem(cacheRoot: string): Promise<string | undefined> {
  const probe = join(resolve(cacheRoot), ".atticus", "cache", `hashes-probe-${process.pid}.tmp`);
  try {
    await writeFile(probe, "", { flag: "wx" });
    await unlink(probe);
    return undefined;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "EIO";
    if (code !== "ENOENT") return code;
    // Windows says ENOENT where a file stands in the folder's place; POSIX says ENOTDIR.
    const at = await stat(dirname(probe)).catch(() => undefined);
    return at && !at.isDirectory() ? "ENOTDIR" : undefined;
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
  const { kept: had, top } = await readMemo(memo, o.dir);
  const stats = had.size ? await statFilesIn(o.dir, o.files, { ...stop, ctime: true }) : [];
  const out = new Array<FileHash>(o.files.length);
  const fresh = new Map<string, Kept>();
  const toHash: number[] = [];
  o.files.forEach((rel, i) => {
    const s = stats[i];
    const hit = had.get(rel);
    if (hit && keptHolds(hit, s)) {
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
        ino: h.ino ?? 0,
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
      dir: cacheDirKey(o.dir),
      entries: Object.fromEntries(
        [...fresh].map(([rel, e]) => [rel, [e.size, e.mtimeMs, e.ctimeMs, e.ino, e.at, e.sha]]),
      ),
    };
    try {
      // The cache sits in .atticus/, which stays on this machine: make sure Git ignores it.
      await ensureLocalIgnore(memo.root);
      await mkdir(memo.dir, { recursive: true });
      // Item 11 of beta.33: a new file each generation, never a rename over the last (which
      // antivirus can hold, so the cache was never written and every Apply read every file).
      await writeFile(join(memo.dir, `${memo.name}.${top + 1}.json`), JSON.stringify(m), {
        flag: "wx",
      });
      for (const old of await generations(memo))
        if (old <= top) await unlink(join(memo.dir, `${memo.name}.${old}.json`)).catch(() => {});
      // The single file of before.
      await unlink(join(memo.dir, `${memo.name}.json`)).catch(() => {});
    } catch (e) {
      // A read-only or full disk costs the next run its hashes, and is said.
      hashCacheHooks.onWriteFailed?.((e as NodeJS.ErrnoException).code ?? "EIO");
    }
  }
  return out;
}
