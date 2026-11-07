import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * ADR 0174: one write at a time to a file this server appends to and rewrites (a repo's
 * corrections: Connect appends, Undo rewrites), so an append during an Undo is never lost.
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
 * (an editor that saves without a final newline), so two lines never run into one.
 */
export function appendLines(file: string, lines: readonly string[]): Promise<void> {
  return withFileLock(file, async () => {
    const now = await readFile(file, "utf8").catch(() => "");
    const eol = /\r\n/.test(now) ? "\r\n" : "\n";
    const lead = now && !now.endsWith("\n") ? eol : "";
    await appendFile(file, lead + lines.map((l) => `${l}${eol}`).join(""), "utf8");
  });
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
