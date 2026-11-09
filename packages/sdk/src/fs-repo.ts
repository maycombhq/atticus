import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { decodeText, walkRepo } from "@maycombhq/core";
import { setListing } from "./listing.js";
import { globToRegExp, type RepoHandle } from "./plugin.js";

/** Folders never scanned: VCS data, dependencies and build output. */
export const DEFAULT_IGNORES = [
  ".git",
  "node_modules",
  "target",
  "build",
  "dist",
  "out",
  ".gradle",
  ".idea",
  ".vscode",
  "__pycache__",
  ".venv",
] as const;

export interface FsRepoOptions {
  /** Folder names skipped anywhere in the tree. Defaults to DEFAULT_IGNORES. */
  ignore?: readonly string[];
  /**
   * Files larger than this (minified bundles, data dumps) are left out of listings and readText
   * refuses them; skippedFiles() says which were left out. Default 5 MB.
   */
  maxFileBytes?: number;
}

/** A RepoHandle over a folder, which can also say which files it left out for their size. */
export interface FsRepoHandle extends RepoHandle {
  /** The size limit: files over it are left out of listings. */
  readonly maxFileBytes: number;
  /** Files a listing left out because they are over maxFileBytes, in path order. */
  skippedFiles(): { path: string; bytes: number }[];
}

/** The warning for a file left out for its size: "left out: 5242881 bytes is over the 5 MB a file may be". */
export function tooLargeMessage(bytes: number, maxBytes: number): string {
  const mb = maxBytes / 1024 / 1024;
  return `left out: ${bytes} bytes is over the ${Number.isInteger(mb) ? `${mb} MB` : `${maxBytes} bytes`} a file may be`;
}

export class RepoReadError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "RepoReadError";
  }
}

/**
 * A read-only RepoHandle over a folder on disk (a base clone). Paths are repo-relative with
 * forward slashes on every platform and listed in sorted order, so scans are deterministic.
 * Symbolic links are never followed, what the repo's .gitignore files ignore isn't listed, and
 * no path may leave the repo folder.
 */
export function fsRepo(
  name: string,
  dir: string,
  commit: string,
  options: FsRepoOptions = {},
): FsRepoHandle {
  const root = resolve(dir);
  const ignore = new Set(options.ignore ?? DEFAULT_IGNORES);
  const maxBytes = options.maxFileBytes ?? 5 * 1024 * 1024;
  let cache: string[] | undefined;
  /** Size of each file a listing matched, read once. */
  const sizes = new Map<string, number>();
  const skipped = new Map<string, number>();

  async function allFiles(): Promise<string[]> {
    if (!cache) {
      // Review round 49: the walker every reader of a checkout shares (@maycombhq/core): no
      // link, no .git, nothing a .gitignore ignores (generated output isn't the commit's).
      const out: string[] = [];
      await walkRepo(root, async (p) => void out.push(p), {
        skipFolder: (_above, name) => ignore.has(name),
      });
      cache = out.sort();
    }
    return cache;
  }

  async function safePath(path: string): Promise<string> {
    if (
      path.startsWith("/") ||
      /^[A-Za-z]:/.test(path) ||
      path.includes("\\") ||
      path.split("/").includes("..")
    ) {
      throw new RepoReadError(`path must be repo-relative with forward slashes: ${path}`, path);
    }
    const abs = join(root, ...path.split("/"));
    const info = await lstat(abs).catch(() => undefined);
    // A link is said to be one (lstat says link, not file), then a non-file is "no such file".
    if (info?.isSymbolicLink())
      throw new RepoReadError(`symbolic links are not read: ${path}`, path);
    if (!info || !info.isFile()) throw new RepoReadError(`no such file: ${path}`, path);
    const real = await realpath(abs);
    const realRoot = await realpath(root);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      throw new RepoReadError(`path leaves the repo: ${path}`, path);
    }
    if (info.size > maxBytes)
      throw new RepoReadError(`file is larger than ${maxBytes} bytes: ${path}`, path);
    return abs;
  }

  const handle: FsRepoHandle = {
    name,
    commit,
    async *listFiles(globs) {
      const matchers = globs.map(globToRegExp);
      for (const p of await allFiles()) {
        if (!matchers.some((m) => m.test(p))) continue;
        if (!sizes.has(p))
          sizes.set(p, (await stat(join(root, ...p.split("/"))).catch(() => undefined))?.size ?? 0);
        const bytes = sizes.get(p)!;
        if (bytes > maxBytes) {
          skipped.set(p, bytes);
          continue;
        }
        yield p;
      }
    },
    maxFileBytes: maxBytes,
    skippedFiles() {
      return [...skipped]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([path, bytes]) => ({ path, bytes }));
    },
    async readText(path) {
      // One decoder for every reader (review round 49): UTF-16 with its mark, UTF-8 without
      // one, Latin-1 when the bytes aren't UTF-8, so line numbers and parsers agree.
      return decodeText(await readFile(await safePath(path)));
    },
  };
  // The scan's stored results are keyed by how the files were listed (review round 49).
  setListing(
    handle,
    JSON.stringify({ ignore: [...ignore].sort(), maxFileBytes: maxBytes, gitignore: true }),
  );
  return handle;
}
