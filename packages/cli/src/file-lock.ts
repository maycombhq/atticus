import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { withSharedFileLock } from "@maycombhq/core";

/**
 * ADR 0174: one write at a time, in this process, to a file or folder. It is no lock between
 * processes: a repo's corrections, which the app server and a CLI command both write, go through
 * core's `withSharedFileLock` instead (round 46).
 */
const chains = new Map<string, Promise<unknown>>();

export function withFileLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  const key = resolve(path);
  const before = chains.get(key) ?? Promise.resolve();
  const next = before.then(work, work);
  const tail = next.catch(() => undefined);
  chains.set(key, tail);
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return next;
}

/**
 * Append lines to a file a person may also edit by hand (a repo's corrections), one write at a
 * time: in the file's own line endings, and on a line of their own when its last line has none
 * (an editor that saves without a final newline), so two lines never run into one. One write at
 * a time across processes too (round 46): the app server appends while a CLI command may rewrite
 * the file, so it takes the file's shared lock (`withSharedFileLock`), as every rewrite does.
 */
export function appendLines(
  file: string,
  lines: readonly string[],
  /** How long to wait for a lock another process holds (the shared lock's own wait by default). */
  o: { waitMs?: number } = {},
): Promise<{ before: string | null }> {
  return withSharedFileLock(
    file,
    async () => {
      // Beta.28: what it started from, read under the lock (null: the file wasn't there).
      const was = await readFile(file, "utf8").catch(() => null);
      const now = was ?? "";
      const eol = /\r\n/.test(now) ? "\r\n" : "\n";
      const lead = now && !now.endsWith("\n") ? eol : "";
      await appendFile(file, lead + lines.map((l) => `${l}${eol}`).join(""), "utf8");
      return { before: was };
    },
    o,
  );
}

/**
 * A commit message safe to paste into a shell: only words, spaces and plain punctuation, so a
 * topic or a name a person typed never runs as `$(...)` or ends the quotes.
 */
export const safeMessage = (m: string) =>
  m
    .replace(/[^A-Za-z0-9 _.,:/@{}()#+-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);

/**
 * Where another team's copy came from, as a committed file says it: their clone's remote (with
 * no sign-in in it), else the folder's name. Never a path of this machine (no one's home folder).
 */
export async function originOf(
  dir: string,
  git: (args: string[]) => Promise<{ stdout: string }>,
): Promise<string> {
  const url = await git(["-C", dir, "remote", "get-url", "origin"])
    .then((r) => r.stdout.trim())
    .catch(() => "");
  // A remote: scheme://host/... (not file://) with no sign-in, query or fragment, or user@host:path.
  // The sign-in goes first (a password may hold # or ?), then any query or fragment.
  const clean = url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i, "$1").replace(/[?#].*$/, "");
  if (/^(https?|ssh|git):\/\/[^/]/i.test(clean)) return clean;
  if (/^[\w.-]+@[\w.-]+:[^\\]/.test(clean) && !/^[a-z]:[\\/]/i.test(clean)) return clean;
  // A local folder (a teammate's clone, file://) says no more than its name.
  return nameOf(url ? url.replace(/^file:\/*/i, "/").replace(/[?#].*$/, "") : dir);
}

const nameOf = (p: string) =>
  p
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() || p;
