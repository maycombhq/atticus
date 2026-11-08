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

/** Folders never walked, at any depth: version control, dependencies, tool and cache state. */
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
  "__pycache__",
  ".venv",
  "venv",
  ".next",
  ".nuxt",
]);

/**
 * Names that are build output or vendored copies beside a build, but are as often a package of
 * the product's own (a hexagonal `adapter/out/`, a card `bin/` lookup, an integration `vendor/`,
 * a Node CLI's `bin/`). Below a `src` folder they are always walked; elsewhere `bin`, `obj` and
 * `vendor` are skipped only beside the build that makes them, the rest always.
 */
export const BUILD_OUTPUT = new Set([
  "target",
  "build",
  "dist",
  "out",
  "bin",
  "obj",
  "vendor",
  "coverage",
]);
const MADE_BESIDE: Record<string, RegExp> = {
  bin: /\.(csproj|fsproj|vbproj|sln)$/i,
  obj: /\.(csproj|fsproj|vbproj|sln)$/i,
  vendor: /^(go\.mod|composer\.json|Gemfile)$/,
};

/** Whether a folder named `name`, below the folders `above` (repo-relative), beside `siblings`, is skipped. */
export function skippedFolder(
  above: readonly string[],
  name: string,
  siblings: readonly string[],
): boolean {
  if (SKIP_DIRS.has(name)) return true;
  if (!BUILD_OUTPUT.has(name)) return false;
  if (above.some((a) => a.toLowerCase() === "src")) return false;
  const beside = MADE_BESIDE[name];
  return beside ? siblings.some((x) => beside.test(x)) : true;
}

/** Whether a repo-relative path stays inside the repo (no `..`, not absolute). */
export function insideRepo(path: string): boolean {
  if (path === "" || isAbsolute(path) || /^[A-Za-z]:/.test(path)) return false;
  const n = normalize(path).split(sep).join("/");
  return n !== ".." && !n.startsWith("../");
}

/** A checkout on disk (the base clone at the commit being verified). */
export function dirSource(root: string): FileSource {
  let cache: string[] | undefined;
  const walk = (dir: string, above: string[], out: string[]) => {
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
        if (!skippedFolder(above, name, names)) walk(full, [...above, name], out);
      } else if (st.isFile()) out.push(relative(root, full).split(sep).join("/"));
    }
  };
  return {
    list() {
      if (!cache) {
        cache = [];
        walk(root, [], cache);
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
