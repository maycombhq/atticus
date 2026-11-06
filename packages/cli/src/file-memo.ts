import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * beta.21: a value worked out from some files, kept until one of them changes (its size or
 * time), so a page asked for again reads nothing new. A file that isn't there counts as its own
 * state. Keyed by the caller's key; the newest value per key only.
 */
const kept = new Map<string, { stamp: string; value: Promise<unknown>; checked: number }>();

export async function stampOf(paths: readonly string[]): Promise<string> {
  const parts = await Promise.all(
    paths.map((p) =>
      stat(p).then(
        (s) => `${s.size}:${s.mtimeMs}`,
        () => "-",
      ),
    ),
  );
  return parts.join("|");
}

const asking = new Map<string, Promise<unknown>>();

export function memoByFiles<T>(
  key: string,
  paths: readonly string[] | (() => Promise<readonly string[]>),
  work: () => Promise<T>,
  o: { recheckAfterMs?: number } = {},
): Promise<T> {
  // Asks that arrive while one is checking the files share its answer.
  const on = asking.get(key);
  if (on) return on as Promise<T>;
  const p = memoOnce(key, paths, work, o).finally(() => {
    if (asking.get(key) === p) asking.delete(key);
  });
  asking.set(key, p);
  return p;
}

async function memoOnce<T>(
  key: string,
  paths: readonly string[] | (() => Promise<readonly string[]>),
  work: () => Promise<T>,
  o: { recheckAfterMs?: number },
): Promise<T> {
  const hit = kept.get(key);
  // A burst of asks (a canvas opening several boxes at once) checks the files once, not each time.
  if (hit && o.recheckAfterMs && Date.now() - hit.checked < o.recheckAfterMs)
    return hit.value as Promise<T>;
  const stamp = await stampOf(typeof paths === "function" ? await paths() : paths);
  if (hit && hit.stamp === stamp) {
    hit.checked = Date.now();
    return hit.value as Promise<T>;
  }
  const value = work();
  kept.set(key, { stamp, value, checked: Date.now() });
  // A failed piece of work isn't kept: the next ask tries again.
  value.catch(() => {
    if (kept.get(key)?.value === value) kept.delete(key);
  });
  return value;
}

/** The files directly in a folder (none when it isn't there), for a stamp over all of them. */
export async function filesIn(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  return [dir, ...names.sort().map((n) => join(dir, n))];
}

/** For tests: forget everything kept. */
export function forgetMemo(): void {
  kept.clear();
  asking.clear();
}

/** Every file under a folder, at any depth (none when it isn't there), folders included. */
export async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [dir];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await filesUnder(p)));
    else out.push(p);
  }
  return out;
}

/** Check the files on the next ask, even inside the recheck window (a file was seen to change). */
export function recheckNow(key: string): void {
  const hit = kept.get(key);
  if (hit) hit.checked = 0;
}
