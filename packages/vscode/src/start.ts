import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Starting from nothing, and adding repos without editing YAML (ADR 0098). No `vscode` here.
 */

/** `name` in `parent`, or `name-2`, `name-3`… when it is taken (a second practice run, ADR 0119). */
export function freeFolder(
  parent: string,
  name: string,
  exists: (path: string) => boolean = existsSync,
): string {
  let dir = join(parent, name);
  for (let n = 2; exists(dir); n++) dir = join(parent, `${name}-${n}`);
  return dir;
}

export interface Discovered {
  repos: { id: string; type: string; evidence?: string }[];
  questions: number;
}

/** What `atticus repos discover … --dry-run` found: each repo with the type it matched. */
export function discoveredFrom(out: string): Discovered {
  const repos: Discovered["repos"] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s{2}([a-z0-9][a-z0-9._-]*): ([a-z0-9][a-z0-9._-]*)(?: \((.+)\))?\s*$/.exec(line);
    if (m) repos.push({ id: m[1]!, type: m[2]!, ...(m[3] ? { evidence: m[3] } : {}) });
  }
  const q = /(\d+) questions? needs? a person/.exec(out);
  return { repos, questions: q ? Number(q[1]) : 0 };
}

/** A folder name a metarepo can take: lowercase letters, digits, dots, dashes, underscores. */
export const isMetarepoName = (n: string) => /^[a-z0-9][a-z0-9._-]*$/.test(n);
