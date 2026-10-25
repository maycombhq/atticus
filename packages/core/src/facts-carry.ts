import type { Cite, Fact } from "./schema/facts.js";

/**
 * A changed file invalidates only what cites it (CLAUDE.md rule 4; ADR 0124 §3 and addendum
 * A-incremental). When a repo's checkout moves to a new commit, a fact whose every cited file is
 * unchanged still rests on the same lines and is carried to the new commit; a fact citing a file
 * that was edited, renamed or deleted is read again. Pure: the diff comes from the git adapter
 * (`changedFiles` in @maycombhq/workspace), so the same facts and the same diff split the same way.
 */

/** One file changed between two commits, as `git diff --name-status -M` says it. */
export interface FileChange {
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "type-changed";
  /** The path at the newer commit (a deleted file's path at the older one). */
  path: string;
  /** A rename's or copy's path at the older commit. */
  from?: string;
}

/** Why a fact must be read again: the first file it cites that changed, and how. */
export interface StaleCite {
  /** The cited path, as the fact names it (at the fact's commit). */
  file: string;
  how: "edited" | "renamed" | "deleted";
  /** A renamed file's path at the newer commit. */
  to?: string;
}

const filesOfCite = (c: Cite): string[] => [c.file, ...(c.with ?? []).map((p) => p.file)];

/**
 * The files a fact rests on: its cite and the cite's `with` parts, and for a flow every step's
 * and error path's cite and parts. Unique and sorted, except that a fact's own cited file comes
 * first for a non-flow fact.
 */
export function citedFiles(f: Fact): string[] {
  if (f.kind !== "flow") return [...new Set(filesOfCite(f.cite))];
  const all = new Set<string>(filesOfCite(f.cite));
  for (const s of f.steps) for (const p of filesOfCite(s.cite)) all.add(p);
  for (const e of f.errors) for (const p of filesOfCite(e.cite)) all.add(p);
  return [...all].sort();
}

/**
 * Whether a diff touches a file the fact cites: the first such file (in `citedFiles` order) and
 * how it changed, or undefined when every cited file is as it was. A file added or copied beside
 * a cited one leaves it as it was; a cited file renamed is followed to its new path.
 */
export function staleCite(f: Fact, changes: readonly FileChange[]): StaleCite | undefined {
  const at = new Map<string, StaleCite>();
  for (const c of changes) {
    if (c.status === "copied") continue;
    if (c.status === "renamed" && c.from !== undefined)
      at.set(c.from, { file: c.from, how: "renamed", to: c.path });
    else if (c.status === "deleted") at.set(c.path, { file: c.path, how: "deleted" });
    else if (c.status !== "added" || !at.has(c.path))
      at.set(c.path, { file: c.path, how: "edited" });
  }
  for (const file of citedFiles(f)) {
    const s = at.get(file);
    if (s) return s;
  }
  return undefined;
}
