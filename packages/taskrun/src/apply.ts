import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * How a one-shot runtime (model, mock, replay) hands back code: whole files in blocks, so
 * applying them is exact and reviewable. Headless Claude Code edits the worktree itself and
 * needs none of this.
 *
 *   === file: src/main/java/forge/ledger/TransferLimits.java
 *   ...the whole new content...
 *   === end file
 *   === delete: src/old/Thing.java
 *
 * Text outside the blocks is the run's report.
 */
export interface FileChange {
  path: string;
  /** Undefined for a deletion. */
  content?: string;
}

export interface ParsedAnswer {
  changes: FileChange[];
  report: string;
  problems: string[];
}

export const FILE_FORMAT = `Give every file you change whole, in this form, and nothing else for code:

=== file: <path from the repo root>
<the whole new content>
=== end file

Delete a file with a line "=== delete: <path>". Write a short report of what you changed, and why, outside the blocks.`;

/** Paths an AI answer may not touch: outside the repo, Git's own files, generated constitution. */
export function refusedPath(path: string): string | undefined {
  if (!path || path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.includes("\\"))
    return `${path || "(empty)"} is not a relative path inside the repo`;
  const parts = path.split("/");
  if (parts.includes("..") || parts.includes(".")) return `${path} leaves the repo`;
  if (parts[0] === ".git") return `${path} is Git's own data`;
  if (path === ".specify/memory/constitution.md") return `${path} is generated from the org pack`;
  return undefined;
}

export function parseAnswer(output: string): ParsedAnswer {
  const lines = output.replace(/\r\n/g, "\n").split("\n");
  const changes: FileChange[] = [];
  const report: string[] = [];
  const problems: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const del = /^=== delete:\s*(.+?)\s*$/.exec(lines[i]!);
    if (del) {
      changes.push({ path: del[1]! });
      continue;
    }
    const open = /^=== file:\s*(.+?)\s*$/.exec(lines[i]!);
    if (!open) {
      report.push(lines[i]!);
      continue;
    }
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length && lines[j] !== "=== end file"; j++) body.push(lines[j]!);
    if (j >= lines.length) problems.push(`the block for ${open[1]} has no "=== end file" line`);
    changes.push({ path: open[1]!, content: body.join("\n") + "\n" });
    i = j;
  }
  for (const c of changes) {
    const why = refusedPath(c.path);
    if (why) problems.push(why);
  }
  return { changes, report: report.join("\n").trim(), problems };
}

/** Apply parsed changes inside the worktree. Refuses the whole answer if any path is refused. */
export async function applyChanges(worktree: string, changes: FileChange[]): Promise<string[]> {
  for (const c of changes) {
    const why = refusedPath(c.path);
    if (why) throw new Error(why);
  }
  for (const c of changes) {
    const full = join(worktree, c.path);
    if (c.content === undefined) await rm(full, { force: true });
    else {
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, c.content, "utf8");
    }
  }
  return changes.map((c) => c.path);
}
