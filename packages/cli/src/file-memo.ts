import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * beta.21: a value worked out from some files, kept until one of them changes (its size or
 * time), so a page asked for again reads nothing new. A file that isn't there counts as its own
 * state. Keyed by the caller's key; the newest value per key only.
 */
const kept = new Map<string, { stamp: string; value: Promise<unknown> }>();

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

export async function memoByFiles<T>(
  key: string,
  paths: readonly string[],
  work: () => Promise<T>,
): Promise<T> {
  const stamp = await stampOf(paths);
  const hit = kept.get(key);
  if (hit && hit.stamp === stamp) return hit.value as Promise<T>;
  const value = work();
  kept.set(key, { stamp, value });
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
}
