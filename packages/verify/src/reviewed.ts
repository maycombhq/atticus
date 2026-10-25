/**
 * Files the reader read and found no fact in (ADR 0124 addendum A-read): `<repo>.reviewed.jsonl`
 * beside the facts file, one `{ "path": "<file or glob>", "why": "..." }` per line. A pure
 * computation library has no entry, call, store, field, deploy or config to cite, so without this
 * its files stay `unknown` however carefully it was read.
 *
 * It is the reader's word, so it is kept apart from what a fact shows: coverage counts these
 * files as reviewed, never as read, and the verify report lists each line with its why and the
 * files it stands for, for a person to challenge. `verifyFacts` refuses a line whose path isn't
 * in the repo at the commit, or whose glob matches no file, and a reviewed file a kept fact cites
 * is simply read. This is the verifier's input, like the routed files: not a facts-file field.
 */

/** One line of `<repo>.reviewed.jsonl`, with its line number when read from the file. */
export interface ReviewedEntry {
  /** A repo-relative file, or a glob (`*` within a folder, `**` across folders). */
  path: string;
  /** Why the file holds nothing to record, in the reader's words. */
  why: string;
  line?: number;
}

/** A line of the file that isn't an entry, and why. */
export interface BadReviewedLine {
  line: number;
  raw: string;
  message: string;
}

const SHAPE = `{"path": "<file or glob>", "why": "..."}`;

/** The entries of `<repo>.reviewed.jsonl`; a line that isn't one is said, not fatal. */
export function parseReviewed(text: string): { entries: ReviewedEntry[]; bad: BadReviewedLine[] } {
  const entries: ReviewedEntry[] = [];
  const bad: BadReviewedLine[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    if (!raw.trim()) return;
    const line = i + 1;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (e) {
      bad.push({ line, raw, message: `line ${line} is not JSON: ${(e as Error).message}` });
      return;
    }
    const o = json as Record<string, unknown> | null;
    const issues: string[] = [];
    if (!o || typeof o !== "object" || Array.isArray(o)) issues.push("not an object");
    else {
      if (typeof o.path !== "string" || !o.path.trim()) issues.push("path: a file or glob");
      if (typeof o.why !== "string" || !o.why.trim()) issues.push("why: why it holds nothing");
      const extra = Object.keys(o).filter((k) => k !== "path" && k !== "why");
      if (extra.length) issues.push(`unknown keys: ${extra.join(", ")}`);
    }
    if (issues.length) {
      bad.push({ line, raw, message: `line ${line} isn't ${SHAPE}: ${issues.join("; ")}` });
      return;
    }
    entries.push({ line, path: (o!.path as string).trim(), why: (o!.why as string).trim() });
  });
  return { entries, bad };
}

/** Whether a reviewed path is a glob rather than one file. */
export const isGlob = (path: string) => /[*?]/.test(path);
