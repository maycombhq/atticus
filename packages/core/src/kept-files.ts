import { readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

/**
 * beta.23 ("Home loads fast"): what a small file says, worked out once per process and kept
 * until the file changes (its size or modification time). The app's server asks the same
 * questions of the same few thousand small files on every page (each question file, the org
 * pack's files, each record's schema version, each repo's facts); opening, reading and parsing
 * them each time was most of the time a page took, and on Windows, where every file opened is
 * scanned, far more. A file that changed is read again, alone; one that isn't there is not kept.
 *
 * Only this process keeps anything, in memory, and nothing is written. `kind` names the question
 * asked of the file (two parses of one file are kept apart). What is kept is given back as it was
 * worked out, so a caller that changes it asks for a copy (`copy: true`); the parses kept here are
 * plain data (YAML, JSON), which structuredClone copies.
 */

interface Entry {
  size: number;
  mtimeMs: number;
  ino: number;
  value: unknown;
  /** The change count when the file's stamp was last checked, and when. */
  checked: number;
  at: number;
}

const kept = new Map<string, Entry>();

/**
 * The app's server follows the metarepo's files and hears every change (ADR 0119): while it says
 * nothing can be writing (`quiet`), a file checked since the last change it heard isn't checked
 * again (on Windows, a stat of each of thousands of files on each page cost most of the time).
 * Every change it hears, and every write through writeFileAtomic or writeFileIfUnchanged, counts.
 */
let quiet: (() => boolean) | undefined;
let changes = 0;

/** While `isQuiet()` says so, files checked since the last change aren't checked again; none to stop. */
export function trustKeptFiles(isQuiet?: () => boolean): void {
  quiet = isQuiet;
  changes++;
}

/**
 * A file may have changed: each kept file is checked again when next asked; with `path` (a
 * file or a folder), only those at or under it.
 */
export function keptFilesMayHaveChanged(path?: string): void {
  if (path === undefined) {
    changes++;
    return;
  }
  const p = resolve(path);
  for (const [key, e] of kept) {
    const f = key.slice(key.indexOf("\u0000") + 1);
    if (f === p || f.startsWith(p + sep)) e.checked = -1;
  }
}
/** Enough for a large estate's small files; past it the oldest go first. */
const MAX = 50_000;
const TRUST_MS = 30_000;

/** The file's stamp now, or undefined when it isn't there (or isn't a file). */
async function stampOf(
  path: string,
): Promise<{ size: number; mtimeMs: number; ino: number } | undefined> {
  try {
    const s = await stat(path);
    return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs, ino: s.ino } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What `parse` makes of the file's text, from the last read while the file is unchanged.
 * Undefined when there is no such file. A parse that throws is not kept: the error goes to the
 * caller, as a fresh read's would.
 */
export async function keptParse<T>(
  path: string,
  kind: string,
  parse: (text: string) => T,
  o: { copy?: boolean } = {},
): Promise<T | undefined> {
  const key = `${kind}\u0000${resolve(path)}`;
  const at = changes;
  const had = kept.get(key);
  const give = (v: unknown) => (o.copy ? structuredClone(v) : v) as T;
  // A watcher can miss a change (Windows drops one after an error): checked again after 30 s.
  if (had && had.checked === at && Date.now() - had.at < TRUST_MS && quiet?.())
    return give(had.value);
  // Asks of one file at once (a page's requests together) check and read it once.
  const ask = `${at}\u0000${key}`;
  let on = asking.get(ask);
  if (!on) {
    on = look(path, key, at, parse);
    asking.set(ask, on);
    void on.then(
      () => asking.delete(ask),
      () => asking.delete(ask),
    );
  }
  const r = await on;
  return r ? give(r.value) : undefined;
}

const asking = new Map<string, Promise<{ value: unknown } | undefined>>();

async function look(
  path: string,
  key: string,
  at: number,
  parse: (text: string) => unknown,
): Promise<{ value: unknown } | undefined> {
  const s = await stampOf(path);
  if (!s) {
    kept.delete(key);
    return undefined;
  }
  const hit = kept.get(key);
  if (hit && hit.size === s.size && hit.mtimeMs === s.mtimeMs && hit.ino === s.ino) {
    // The newest asked last: the oldest go first when there are too many.
    kept.delete(key);
    kept.set(key, hit);
    hit.checked = at;
    hit.at = Date.now();
    return { value: hit.value };
  }
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    kept.delete(key);
    return undefined;
  }
  const value = parse(text);
  // Stamped as it was before the read: a write meanwhile changes the stamp, so it is read again.
  kept.set(key, { ...s, value, checked: at, at: Date.now() });
  if (kept.size > MAX) kept.delete(kept.keys().next().value!);
  return { value };
}

/** For tests: forget every file kept. */
export function forgetKeptFiles(): void {
  kept.clear();
}
