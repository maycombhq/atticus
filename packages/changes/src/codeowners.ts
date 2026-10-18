import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * CODEOWNERS, read the way Git hosts read it: gitignore-style patterns, and the last
 * matching line wins. Atticus uses it only to name reviewers on hand-off PRs; the host
 * itself enforces code-owner approval.
 */
export interface CodeownersRule {
  pattern: string;
  regex: RegExp;
  /** Handles without the leading "@" (teams keep their "org/team" form). */
  owners: string[];
}

/** Where Git hosts look for the file, in their order. */
export const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

function toRegex(pattern: string): RegExp {
  let p = pattern;
  const dirOnly = p.endsWith("/");
  if (dirOnly) p = p.slice(0, -1);
  let anchored = p.includes("/");
  if (p.startsWith("/")) {
    anchored = true;
    p = p.slice(1);
  }
  let body = "";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]!;
    if (p.startsWith("**/", i)) {
      body += "(?:.*/)?";
      i += 2;
    } else if (p.startsWith("/**", i) && i + 3 === p.length) {
      body += "(?:/.*)?";
      i += 2;
    } else if (p.startsWith("**", i)) {
      body += ".*";
      i += 1;
    } else if (ch === "*") body += "[^/]*";
    else if (ch === "?") body += "[^/]";
    else body += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${anchored ? "^" : "^(?:.*/)?"}${body}${dirOnly ? "/.*$" : "(?:/.*)?$"}`);
}

export function parseCodeowners(text: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    rules.push({
      pattern: pattern!,
      regex: toRegex(pattern!),
      owners: owners.map((o) => (o.startsWith("@") ? o.slice(1) : o)),
    });
  }
  return rules;
}

/** Owners of one path (relative to the repo root, forward slashes). */
export function ownersFor(rules: readonly CodeownersRule[], path: string): string[] {
  for (let i = rules.length - 1; i >= 0; i--) {
    if (rules[i]!.regex.test(path)) return [...rules[i]!.owners];
  }
  return [];
}

/** The metarepo's CODEOWNERS rules, or none when it has no such file. */
export async function readCodeowners(root: string): Promise<CodeownersRule[]> {
  for (const p of CODEOWNERS_PATHS) {
    try {
      return parseCodeowners(await readFile(join(root, p), "utf8"));
    } catch {
      // try the next location
    }
  }
  return [];
}
