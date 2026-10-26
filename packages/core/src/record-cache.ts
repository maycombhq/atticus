import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { ensureLocalIgnore, writeFileAtomic } from "./fs.js";

/**
 * Record files read and parsed once, then kept between runs (ADR 0119). A metarepo's catalog is
 * about 1,500 files and its specs 400 more; reading and parsing every one took seconds on every
 * `atticus next` or `atticus change status`, and a person runs those all day. So each parse is
 * kept in `.atticus/cache/`, keyed by the file's path, size and modification time, the way the
 * search index (packages/index) and the manual step store already key theirs. A file whose size
 * or time changed is read again; the cache is derived, local-only and never committed, and a
 * cache that can't be read or written costs nothing but the parse.
 *
 * Nothing here decides what a file means: the caller's `parse` does, and only its output (the
 * record, or the problem with the file) is kept.
 */

/** One file's parse: the value, or why the file isn't valid. Never both. */
export interface Parsed<T> {
  /** The file, relative to the folder, with forward slashes. */
  rel: string;
  value?: T;
  problem?: string;
}

/** What a caller's parse says about one file. */
export type ParseOutcome<T> = { ok: true; value: T } | { ok: false; message: string };

interface Entry {
  size: number;
  mtimeMs: number;
  value?: unknown;
  problem?: string;
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

/** Run `f` over the items, up to `AT_ONCE` at a time, keeping the order. */
export async function mapAtOnce<I, O>(items: I[], f: (item: I) => Promise<O>): Promise<O[]> {
  const out: O[] = [];
  for (let i = 0; i < items.length; i += AT_ONCE)
    out.push(...(await Promise.all(items.slice(i, i + AT_ONCE).map(f))));
  return out;
}

/**
 * The metarepo root a path is inside: the nearest folder above it holding `org-pack/` or
 * `.atticus/org-pack/` (a repo adopted in place), or undefined outside one — a unit test's
 * temporary folder, say, which then keeps no cache.
 */
export function metarepoRootOf(path: string): string | undefined {
  let dir = resolve(path);
  for (;;) {
    if (existsSync(join(dir, "org-pack")) || existsSync(join(dir, ".atticus", "org-pack")))
      return dir;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/** The metarepo and the file its parses are kept in, or undefined outside a metarepo. */
function memoFileOf(dir: string, name: string): { root: string; file: string } | undefined {
  const root = metarepoRootOf(dir);
  if (!root) return undefined;
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
 */
export async function readParsedFiles<T>(o: {
  dir: string;
  files: string[];
  name: string;
  version: string;
  parse: (text: string, rel: string) => ParseOutcome<T>;
}): Promise<Parsed<T>[]> {
  const memo = memoFileOf(o.dir, o.name);
  const had = memo ? await readMemo(memo.file, o.version, o.dir) : new Map<string, Entry>();
  const full = (rel: string) => join(o.dir, ...rel.split("/"));
  const stats = await mapAtOnce(o.files, (rel) =>
    stat(full(rel)).then(
      (s) => ({ size: s.size, mtimeMs: Math.floor(s.mtimeMs) }),
      () => undefined,
    ),
  );
  const fresh = new Map<string, Entry>();
  const toRead: number[] = [];
  o.files.forEach((rel, i) => {
    const s = stats[i];
    const hit = had.get(rel);
    if (s && hit && hit.size === s.size && hit.mtimeMs === s.mtimeMs) fresh.set(rel, hit);
    else toRead.push(i);
  });
  const read = await mapAtOnce(toRead, async (i) => {
    const rel = o.files[i]!;
    const s = stats[i];
    try {
      const r = o.parse(await readFile(full(rel), "utf8"), rel);
      const e: Entry = {
        size: s?.size ?? -1,
        mtimeMs: s?.mtimeMs ?? -1,
        ...(r.ok ? { value: r.value } : { problem: r.message }),
      };
      return { rel, e };
    } catch (err) {
      // A file that can't be read at all: the problem is reported, and nothing is kept for it.
      return { rel, e: { size: -1, mtimeMs: -1, problem: (err as Error).message.split("\n")[0]! } };
    }
  });
  const changed = read.length > 0 || fresh.size !== had.size;
  for (const { rel, e } of read) fresh.set(rel, e);
  if (memo && changed) await writeMemo(memo, o.version, o.dir, fresh);
  return o.files.map((rel) => {
    const e = fresh.get(rel)!;
    return {
      rel,
      ...(e.problem === undefined ? { value: e.value as T } : { problem: e.problem }),
    };
  });
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
