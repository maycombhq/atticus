import { createHash } from "node:crypto";

/**
 * What a person's edit of a stage's file is (review round 50): the one hash every edit check
 * uses (the stage loop's `written`, stage/drafted.yaml, `atticus critic act` edit-and-apply).
 * Line endings aside: a Windows checkout (core.autocrlf) is not an edit. In tasks.md the boxes
 * aside: ticking a task done (`atticus task`, hand-up, the Task board) is progress, not an edit of
 * the draft, so a tick never makes the stories stage take tasks.md for a person's draft.
 */
export function editText(file: string, text: string): string {
  const lf = text.replace(/\r\n?/g, "\n");
  return isTasks(file) ? lf.replace(/^(\s*[-*]\s+\[)[ xX]?(\])/gm, "$1 $2") : lf;
}

/** The sha-256 of a stage file's text as edit checks compare it (`editText`). */
export function editSha(file: string, text: string | Buffer): string {
  const h = createHash("sha256");
  // A file's bytes as they are when there is nothing to set aside (the hashes kept before).
  if (typeof text !== "string" && !text.includes(13) && !isTasks(file))
    return h.update(text).digest("hex");
  const t = typeof text === "string" ? text : text.toString("utf8");
  return h.update(editText(file, t), "utf8").digest("hex");
}

/**
 * Whether a file's text is still what a stage wrote, by the hash it recorded: the edit hash
 * (`editSha`), or the text's own hash with LF line endings (a hash recorded before review round
 * 50, when tasks.md was hashed with its boxes).
 */
export function wroteThis(file: string, text: string | Buffer, hash: string | undefined): boolean {
  if (hash === undefined) return false;
  if (editSha(file, text) === hash) return true;
  const t = typeof text === "string" ? text : text.toString("utf8");
  return createHash("sha256").update(t.replace(/\r\n?/g, "\n"), "utf8").digest("hex") === hash;
}

const isTasks = (file: string) => file.split(/[\\/]/).at(-1) === "tasks.md";
