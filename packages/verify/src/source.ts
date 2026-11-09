import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import { decodeText, listRepoFilesSync } from "@maycombhq/core";

/**
 * Where the verifier reads a repo's files from. Paths are repo-relative with forward slashes.
 * `read` returns undefined for a file that isn't there (or isn't inside the repo).
 */
export interface FileSource {
  list(): string[];
  read(path: string): string | undefined;
  /**
   * A file's size in bytes without reading it (review round 49), when the source can say it:
   * a file too big to be source is passed over before its bytes are read.
   */
  size?(path: string): number | undefined;
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
 * Names that are build output or vendored copies, but are as often a package of the product's
 * own (a hexagonal `adapter/out/`, a card `bin/` lookup, an integration `vendor/`, a Node CLI's
 * `bin/`). Beside the build that makes them they are skipped anywhere (a .NET project's `bin/`
 * and `obj/` under `src/` included); otherwise, below a `src` folder they are the product's and
 * walked, and elsewhere `bin`, `obj` and `vendor` are walked and the rest skipped.
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
const DOTNET = /\.(csproj|fsproj|vbproj|sln)$/i;
const NODE = /^package\.json$/;
const MADE_BESIDE: Record<string, RegExp> = {
  bin: DOTNET,
  obj: DOTNET,
  vendor: /^(go\.mod|composer\.json|Gemfile)$/,
  target: /^(pom\.xml|build\.sbt|Cargo\.toml)$/,
  build: /^(build\.gradle(\.kts)?|settings\.gradle(\.kts)?|package\.json|CMakeLists\.txt)$/,
  dist: NODE,
  coverage: NODE,
  out: /^(tsconfig\.json|package\.json)$|\.iml$/,
};
/** Outside src/, only beside their build: the rest are build output wherever they are. */
const ONLY_BESIDE = new Set(["bin", "obj", "vendor"]);

/** Whether a folder named `name`, below the folders `above` (repo-relative), beside `siblings`, is skipped. */
export function skippedFolder(
  above: readonly string[],
  name: string,
  siblings: readonly string[],
): boolean {
  if (SKIP_DIRS.has(name)) return true;
  if (!BUILD_OUTPUT.has(name)) return false;
  if (siblings.some((x) => MADE_BESIDE[name]!.test(x))) return true;
  if (above.some((a) => a.toLowerCase() === "src")) return false;
  return !ONLY_BESIDE.has(name);
}

/**
 * Whether a repo-relative path stays inside the repo (no `..`, not absolute), read with `\` as
 * `/` as Windows reads it. Review round 46: NTFS opens `.env::$DATA` as `.env` and `a.ts.` or
 * `a.ts ` as `a.ts`, so a path with a `:` anywhere, or a part ending in a dot or a space, is
 * refused: no file a repo lists is named so on Windows, and the name could open another file.
 */
export function insideRepo(path: string): boolean {
  const p = path.replace(/\\/g, "/");
  if (p === "" || p.includes(":") || isAbsolute(p) || p.startsWith("/")) return false;
  if (p.split("/").some((x) => x !== "." && x !== ".." && /[. ]$/.test(x))) return false;
  const n = normalize(p).split(sep).join("/");
  return n !== ".." && !n.startsWith("../");
}

/**
 * A checkout on disk (the base clone at the commit being verified). Review round 49: listed with
 * the walker the scan and the assistant's code tools share (@maycombhq/core `listRepoFilesSync`):
 * no symbolic link is followed (a loop hung the map, a link to /etc/passwd or to ../.env put that
 * file in a prompt under another name), and nothing a .gitignore ignores is listed. A read
 * refuses a link and any path whose real path leaves the repo's, and decodes as every reader
 * does (`decodeText`).
 */
export function dirSource(root: string): FileSource {
  let cache: string[] | undefined;
  let realRoot: string | undefined;
  /** The file a path names, when it is a plain file whose real path is in the repo. */
  const fileAt = (path: string): string | undefined => {
    if (!insideRepo(path)) return undefined;
    const full = join(root, ...path.split("/"));
    try {
      if (!lstatSync(full).isFile()) return undefined;
      realRoot ??= realpathSync(root);
      const r = relative(realRoot, realpathSync(full));
      if (!r || r.startsWith("..") || isAbsolute(r)) return undefined;
      return full;
    } catch {
      return undefined;
    }
  };
  return {
    list() {
      cache ??= listRepoFilesSync(root, { skipFolder: skippedFolder });
      return cache;
    },
    read(path) {
      const full = fileAt(path);
      if (!full) return undefined;
      try {
        return decodeText(readFileSync(full));
      } catch {
        return undefined;
      }
    },
    size(path) {
      const full = fileAt(path);
      if (!full) return undefined;
      try {
        return statSync(full).size;
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
    size: (path) =>
      insideRepo(path) && files[path] !== undefined
        ? Buffer.byteLength(files[path], "utf8")
        : undefined,
  };
}

/**
 * Bytes a file may be and still be read as source (review round 49): over it a file is generated
 * or data, and is passed over by its size before its bytes are read. The scan's limit (`fsRepo`).
 */
export const MAX_SOURCE_BYTES = 5 * 1024 * 1024;

/** Whether a source says a file is over MAX_SOURCE_BYTES (without reading it). */
export function tooBigToRead(source: FileSource, path: string): boolean {
  const n = source.size?.(path);
  return n !== undefined && n > MAX_SOURCE_BYTES;
}
