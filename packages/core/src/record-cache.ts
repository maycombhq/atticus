import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CancelledError } from "./cancel.js";
import { hashFilesIn, statFilesIn, type FileHash, type FileStat } from "./file-pool.js";
import { ensureLocalIgnore, writeFileAtomic } from "./fs.js";

/**
 * Record files read and parsed once, then kept between runs (ADR 0119, with its addendum of
 * 2026-10-26). A metarepo's catalog is about 1,500 files and its specs 400 more; reading and
 * parsing every one took seconds on every `atticus next` or `atticus change status`, and a
 * person runs those all day. So each parse is kept in `<cacheRoot>/.atticus/cache/`, keyed by
 * the file's path, size and modification time, the way the search index (packages/index) and the
 * manual step store already key theirs. A file whose size or time changed is read again; the
 * cache is derived, local-only and never committed, and a cache that can't be read or written
 * costs nothing but the parse.
 *
 * `cacheRoot` is the metarepo the command is working in, and the caller names it: nothing here
 * works out a root from the folder being read. A read with no `cacheRoot` keeps nothing and
 * writes nothing, which is what reading someone else's metarepo must be — absorb, federation, a
 * linked estate. Atticus never writes where it was only asked to read (hard rule 6, ADR 0038),
 * and that holds for its own cache as much as for anything else.
 *
 * Nothing here decides what a file means: the caller's `parse` does, and only its output (the
 * record, or the problem with the file) is kept.
 *
 * Racily clean files (the final review of beta.28.2, Git's rule of the same name). A file system
 * keeps a file's time to a grain (FAT 2 s, HFS+ 1 s, some SMB and NFS mounts 1 s or more), so a
 * same-size edit made within that grain of a read or a write can keep the time the parse was kept
 * by, and size and time alone would serve the old text. So each parse is kept with the clock as
 * it was taken (`at`: before the bytes parsed were read, or before a writer wrote them), and one
 * whose file's time is no more than `RACY_MS` before `at` is "racy": it keeps the sha256 of the
 * bytes parsed, and is reused only when the file still hashes to them (read in the file pool's
 * workers; cheaper than a parse), then kept again as of the hash's read when by then it is no
 * longer racy (the next command, seconds on: from then on its stat alone decides). A parse whose
 * file's time is more than `RACY_MS` before `at` is trusted by size and time, as before: any edit
 * after `at` has a time after `at` less the grain, so it can't keep that time. A parse kept with no `at` (an older cache) is racy, and with no hash it is
 * parsed again. The rule takes this machine's clock and the file system's to agree to within the
 * grain (a mount whose server runs more than `RACY_MS` behind can still serve a stale parse, as
 * Git can).
 */

/**
 * The widest timestamp grain allowed for (FAT's 2 s): a parse kept of a file whose time was
 * within this of the moment it was kept is checked by its hash before it is reused.
 */
export const RACY_MS = 2000;

/** Tests set the clock a parse is kept at (ms; default `Date.now`). */
export const recordCacheHooks: { now?: () => number } = {};
const now = () => (recordCacheHooks.now ?? Date.now)();

/** One file's parse: the value, or why the file isn't valid. Never both. */
export interface Parsed<T> {
  /** The file, relative to the folder, with forward slashes. */
  rel: string;
  value?: T;
  problem?: string;
  /** With `withStats`: the file's size and time (ms, floored) as this read found them (-1: none). */
  size?: number;
  mtimeMs?: number;
}

/** What a caller's parse says about one file. */
export type ParseOutcome<T> = { ok: true; value: T } | { ok: false; message: string };

interface Entry {
  size: number;
  mtimeMs: number;
  /** The clock (ms) as the parse was kept: before its bytes were read, or written. None: racy. */
  at?: number;
  /** A racy entry's sha256 of the bytes parsed (none once it isn't racy). */
  sha?: string;
  value?: unknown;
  problem?: string;
}

/** Whether a file's time is within the grain of the moment its parse was kept (`RACY_MS`). */
const racy = (mtimeMs: number, at: number | undefined) =>
  at === undefined || mtimeMs >= at - RACY_MS;

/** An entry kept as of `at`, its hash kept only while it is racy. */
function entryAt(
  e: { size: number; mtimeMs: number; value?: unknown; problem?: string },
  at: number | undefined,
  sha: string | undefined,
): Entry {
  return {
    size: e.size,
    mtimeMs: e.mtimeMs,
    ...(at !== undefined ? { at } : {}),
    ...(sha !== undefined && racy(e.mtimeMs, at) ? { sha } : {}),
    ...(e.problem === undefined ? { value: e.value } : { problem: e.problem }),
  };
}

interface Memo {
  /** The shape of what is kept: a different version is read again from the files. */
  v: string;
  /** The folder the files are in, so a hash collision can't be read as another folder's. */
  dir: string;
  entries: Record<string, Entry>;
}

/** How many files are read at once: the reads are independent, and waiting in turn is the cost. */
const AT_ONCE = 64;

/**
 * Run `f` over the items, up to `AT_ONCE` at a time, keeping the order. With `signal`, a stop
 * ends it between two lots with CancelledError (beta.28.3).
 */
export async function mapAtOnce<I, O>(
  items: I[],
  f: (item: I) => Promise<O>,
  signal?: AbortSignal,
): Promise<O[]> {
  const out: O[] = [];
  for (let i = 0; i < items.length; i += AT_ONCE) {
    if (signal?.aborted) throw new CancelledError();
    out.push(...(await Promise.all(items.slice(i, i + AT_ONCE).map(f))));
  }
  return out;
}

/**
 * The file a folder's parses are kept in, under the root the caller named, or undefined when it
 * named none — and then nothing is read from a cache and nothing is written anywhere. The key is
 * the folder's absolute path, and the memo names that folder too, so two folders read into one
 * root can't be read as one.
 */
function memoFileOf(
  cacheRoot: string | undefined,
  dir: string,
  name: string,
): { root: string; file: string } | undefined {
  if (!cacheRoot) return undefined;
  const root = resolve(cacheRoot);
  const key = createHash("sha256").update(resolve(dir)).digest("hex").slice(0, 16);
  return { root, file: join(root, ".atticus", "cache", `${name}-${key}.json`) };
}

async function readMemo(file: string, v: string, dir: string): Promise<Map<string, Entry>> {
  try {
    const m = JSON.parse(await readFile(file, "utf8")) as Memo | null;
    if (!m || m.v !== v || m.dir !== resolve(dir) || typeof m.entries !== "object")
      return new Map();
    return new Map(Object.entries(m.entries));
  } catch {
    // No cache yet, or one this version doesn't read: the files are read instead.
    return new Map();
  }
}

/**
 * Read and parse every named file of a folder, reusing the parses kept from an earlier run for
 * the files that haven't changed. `name` names the kind of file (`catalog`, `spec`), `version`
 * the shape of what the parse gives back; `files` are relative to `dir`, with forward slashes.
 * `cacheRoot` is the metarepo this run is working in, and the only place a cache is ever
 * written; without it the read keeps nothing and writes nothing, and costs only the parse.
 */
export async function readParsedFiles<T>(o: {
  dir: string;
  files: string[];
  name: string;
  version: string;
  parse: (text: string, rel: string) => ParseOutcome<T>;
  /** The root of the metarepo this run is working in; none means no cache (read-only). */
  cacheRoot?: string;
  /**
   * False: the parses kept under `cacheRoot` are read, and nothing is written there (a preview,
   * which writes nothing: beta.28.1, it parsed a 100,000-record catalog from its files).
   */
  keep?: boolean;
  /** Each file's size and time with its parse (beta.28.1: a write matches them to its own read). */
  withStats?: boolean;
  /**
   * Told what this read keeps under `cacheRoot` (not called when it keeps nothing): a writer that
   * then writes some of the files adds their parses with `keepParses` (beta.28.2).
   */
  kept?: (k: KeptParses<T>) => void;
  /**
   * Beta.28.3: a job's Stop. A stop while the files' sizes and times are read, their bytes
   * hashed, or the files read and parsed (a first read of a large catalog) ends the read with
   * CancelledError; nothing is kept of a stopped read.
   */
  signal?: AbortSignal;
}): Promise<Parsed<T>[]> {
  const stop = o.signal ? { signal: o.signal } : {};
  const memo = memoFileOf(o.cacheRoot, o.dir, o.name);
  const had = memo ? await readMemo(memo.file, o.version, o.dir) : new Map<string, Entry>();
  const full = (rel: string) => join(o.dir, ...rel.split("/"));
  // beta.28.2: in a few worker threads for a big folder (file-pool.ts: 100,000 stats through the
  // promise API took a second and more), the same sizes and times.
  const stats = await statFilesIn(o.dir, o.files, stop);
  const fresh = new Map<string, Entry>();
  const toRead: number[] = [];
  const toCheck: number[] = [];
  o.files.forEach((rel, i) => {
    const s = stats[i];
    const hit = had.get(rel);
    if (!s || !hit || hit.size !== s.size || hit.mtimeMs !== s.mtimeMs) toRead.push(i);
    else if (!racy(hit.mtimeMs, hit.at)) fresh.set(rel, hit);
    else if (hit.sha !== undefined) toCheck.push(i);
    else toRead.push(i);
  });
  // A racy parse (its file's time within the grain of when it was kept): reused only when the
  // file's bytes still hash to the ones parsed, then kept again as of that hash's read.
  let rekept = 0;
  if (toCheck.length) {
    const at = now();
    const hashes: FileHash[] | undefined = await hashFilesIn(
      o.dir,
      toCheck.map((i) => o.files[i]!),
      { raw: true, ...stop },
    ).catch((e: unknown) => {
      if (e instanceof CancelledError) throw e;
      return undefined;
    });
    toCheck.forEach((i, k) => {
      const rel = o.files[i]!;
      const hit = had.get(rel)!;
      const h = hashes?.[k];
      if (h && h.sha === hit.sha && h.size === hit.size && h.mtimeMs === hit.mtimeMs) {
        // Kept again only when that ends its raciness (the next command, seconds on); still
        // racy (a read straight after), it stays as it was and the cache isn't written again.
        if (racy(hit.mtimeMs, at)) fresh.set(rel, hit);
        else {
          fresh.set(rel, entryAt(hit, at, h.sha));
          rekept++;
        }
      } else toRead.push(i);
    });
  }
  // Before any byte is read: an edit after this has a later time, less the grain.
  const at = now();
  const read = await mapAtOnce(
    toRead,
    async (i) => {
      const rel = o.files[i]!;
      const s = stats[i];
      try {
        const bytes = await readFile(full(rel));
        const r = o.parse(bytes.toString("utf8"), rel);
        const size = s?.size ?? -1;
        const mtimeMs = s?.mtimeMs ?? -1;
        const sha = racy(mtimeMs, at)
          ? createHash("sha256").update(bytes).digest("hex")
          : undefined;
        const e = entryAt(
          { size, mtimeMs, ...(r.ok ? { value: r.value } : { problem: r.message }) },
          at,
          sha,
        );
        return { rel, e };
      } catch (err) {
        // A file that can't be read at all: the problem is reported, and nothing is kept for it.
        return {
          rel,
          e: { size: -1, mtimeMs: -1, problem: (err as Error).message.split("\n")[0]! },
        };
      }
    },
    o.signal,
  );
  // Stopped as the last files were read: nothing is kept, as for a stop before them.
  if (o.signal?.aborted) throw new CancelledError();
  const changed = read.length > 0 || rekept > 0 || fresh.size !== had.size;
  for (const { rel, e } of read) fresh.set(rel, e);
  if (memo && changed && o.keep !== false) await writeMemo(memo, o.version, o.dir, fresh);
  if (memo && o.keep !== false && o.kept)
    o.kept({ memo, version: o.version, dir: o.dir, entries: new Map(fresh) } as KeptParses<T>);
  return o.files.map((rel, i) => {
    const e = fresh.get(rel)!;
    return {
      rel,
      ...(e.problem === undefined ? { value: e.value as T } : { problem: e.problem }),
      ...(o.withStats ? { size: stats[i]?.size ?? -1, mtimeMs: stats[i]?.mtimeMs ?? -1 } : {}),
    };
  });
}

/** What a read kept of a folder's parses (`readParsedFiles`'s `kept`), for `keepParses`. */
export interface KeptParses<T> {
  readonly memo: { root: string; file: string };
  readonly version: string;
  readonly dir: string;
  /** The kept parses by path, as that read left them. */
  readonly entries: ReadonlyMap<string, Entry>;
  /** Only to tie the type to the parse's value. */
  readonly _value?: T;
}

/**
 * Add the parses of files a writer wrote since its read (`k`) to what that read kept, and forget
 * the files it removed (beta.28.2: a catalog write rewrites its features and glossary terms,
 * megabytes of YAML, and the next read parsed them again). Each file is kept by the size and time
 * it had as it was written, with the parse of the text the writer wrote there, which is what a
 * read of it would parse; a file whose size or time is another now (changed since), or gone, isn't
 * kept. A file written moments ago is racy (its time is within `RACY_MS` of the write): it is kept
 * with the hash of the bytes written (`writeFileAtomic`'s `stat` gives it, and the clock as the
 * write began), so the next read reuses it only when the file still hashes to them; one with no
 * hash is parsed again by the next read. A cache that can't be written costs the next read its
 * parses.
 */
export async function keepParses<T>(
  k: KeptParses<T>,
  o: {
    /**
     * Each file written, with the size and time it had as it was written (`writeFileAtomic`'s
     * `stat`): it is kept only while it still has exactly those, so an edit made since (of the
     * same size too: its time differs, or within the grain its hash does) is parsed by the next
     * read, never served the writer's text. `sha` and `writtenAt` as `writeFileAtomic` gives them.
     */
    files: readonly {
      rel: string;
      value?: T;
      problem?: string;
      at: FileStat & { sha?: string; writtenAt?: number };
    }[];
    removed: readonly string[];
  },
): Promise<void> {
  const entries = new Map(k.entries);
  for (const rel of o.removed) entries.delete(rel);
  const stats = await statFilesIn(
    k.dir,
    o.files.map((f) => f.rel),
  );
  o.files.forEach((f, i) => {
    const s = stats[i];
    if (!s || s.size !== f.at.size || s.mtimeMs !== f.at.mtimeMs) {
      entries.delete(f.rel);
      return;
    }
    entries.set(
      f.rel,
      entryAt(
        {
          size: s.size,
          mtimeMs: s.mtimeMs,
          ...(f.problem === undefined ? { value: f.value } : { problem: f.problem }),
        },
        f.at.writtenAt,
        f.at.sha,
      ),
    );
  });
  await writeMemo(k.memo, k.version, k.dir, entries);
}

async function writeMemo(
  at: { root: string; file: string },
  v: string,
  dir: string,
  entries: Map<string, Entry>,
): Promise<void> {
  const memo: Memo = { v, dir: resolve(dir), entries: Object.fromEntries(entries) };
  try {
    // The cache sits in .atticus/, which stays on this machine: make sure Git ignores it.
    await ensureLocalIgnore(at.root);
    await writeFileAtomic(at.file, JSON.stringify(memo));
  } catch {
    // A read-only or full disk costs the next run its parses, nothing else.
  }
}
