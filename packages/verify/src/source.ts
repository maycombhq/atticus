import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative, sep } from "node:path";

/**
 * Where the verifier reads a repo's files from. Paths are repo-relative with forward slashes.
 * `read` returns undefined for a file that isn't there (or isn't inside the repo).
 */
export interface FileSource {
  list(): string[];
  read(path: string): string | undefined;
}

/** Folders never walked: version control, dependencies, build output, Atticus's own state. */
const SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".atticus",
  ".idea",
  ".vscode",
  ".gradle",
  ".mvn",
  "target",
  "build",
  "dist",
  "out",
  "bin",
  "obj",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  ".next",
  ".nuxt",
  "coverage",
]);

/** Whether a repo-relative path stays inside the repo (no `..`, not absolute). */
export function insideRepo(path: string): boolean {
  if (path === "" || isAbsolute(path) || /^[A-Za-z]:/.test(path)) return false;
  const n = normalize(path).split(sep).join("/");
  return n !== ".." && !n.startsWith("../");
}

/** A checkout on disk (the base clone at the commit being verified). */
export function dirSource(root: string): FileSource {
  let cache: string[] | undefined;
  const walk = (dir: string, out: string[]) => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(full, out);
      } else if (st.isFile()) out.push(relative(root, full).split(sep).join("/"));
    }
  };
  return {
    list() {
      if (!cache) {
        cache = [];
        walk(root, cache);
      }
      return cache;
    },
    read(path) {
      if (!insideRepo(path)) return undefined;
      try {
        return readFileSync(join(root, ...path.split("/")), "utf8");
      } catch {
        return undefined;
      }
    },
  };
}

/** Files held in memory (tests, and facts checked against a hand-off's pasted files). */
export function memorySource(files: Record<string, string>): FileSource {
  const keys = Object.keys(files).sort();
  return {
    list: () => keys,
    read: (path) => (insideRepo(path) ? files[path] : undefined),
  };
}
