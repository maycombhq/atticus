import { stat } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * beta.23 ("Home loads fast"): a page's answer kept while the app's server follows the
 * metarepo's files (ADR 0119), until it hears that something changed: a live event (a file the
 * watcher saw, a job that finished, the index rebuilt) or a call to the API that may have
 * written. Home asks about twenty of these at once on every load and again after every change it
 * hears; each read thousands of small files (every question, every record's version, the org
 * pack), and on Windows each file read costs far more. Asked again with nothing changed, the
 * answer is the one already worked out, and asks that come while it is being worked out share it.
 *
 * Only an answer that depends on nothing but the files the server follows is kept here (not the
 * base clones, not Git); and only while the server says it follows them. A change the watcher
 * missed (one Windows drops after an error) is read anyway within a minute.
 */

const MAX_AGE_MS = 60_000;

let watched: { root: string; following: () => boolean } | undefined;
let generation = 0;
const kept = new Map<
  string,
  { generation: number; at: number; value: Promise<unknown>; stamp: string }
>();

/** A stamp of files (size and time each; "-" for one that isn't there), for keptAnswer. */
export async function stampOfFiles(paths: readonly string[]): Promise<string> {
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

/** The server for `root` follows its files while `following()` says so; the returned function stops it. */
export function keepAnswersWhileWatched(root: string, following: () => boolean): () => void {
  const me = { root: resolve(root), following };
  watched = me;
  kept.clear();
  return () => {
    if (watched === me) watched = undefined;
    kept.clear();
  };
}

/** Something may have changed: every answer kept is worked out again when next asked. */
export function answersMayHaveChanged(): void {
  generation++;
  kept.clear();
}

/**
 * The answer `work` gives, kept until a change is heard (see above); `key` names the question.
 * `stamp`, when given, says the state of files the server doesn't follow that the answer reads
 * too (a base clone's Git files): a different stamp works the answer out again.
 */
export async function keptAnswer<T>(
  root: string,
  key: string,
  work: () => Promise<T>,
  stamp?: () => Promise<string>,
): Promise<T> {
  if (!watched || watched.root !== resolve(root) || !watched.following()) return work();
  const at = generation;
  const s = stamp ? await stamp() : "";
  const hit = kept.get(key);
  if (hit && hit.generation === generation && hit.stamp === s && Date.now() - hit.at < MAX_AGE_MS)
    return hit.value as Promise<T>;
  // A change heard while the stamp was read: work it out from the files as they are now.
  if (at !== generation) return work();
  const value = work();
  const entry = { generation, at: Date.now(), value, stamp: s };
  kept.set(key, entry);
  // A failed answer isn't kept: the next ask works it out again.
  value.catch(() => {
    if (kept.get(key) === entry) kept.delete(key);
  });
  return value;
}
