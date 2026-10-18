import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
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
  /** Files larger than this are listed but readText refuses them. Default 5 MB. */
  maxFileBytes?: number;
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
 * Symbolic links are never followed, and no path may leave the repo folder.
 */
export function fsRepo(
  name: string,
  dir: string,
  commit: string,
  options: FsRepoOptions = {},
): RepoHandle {
  const root = resolve(dir);
  const ignore = new Set(options.ignore ?? DEFAULT_IGNORES);
  const maxBytes = options.maxFileBytes ?? 5 * 1024 * 1024;
  let cache: string[] | undefined;

  async function walk(abs: string, out: string[]): Promise<void> {
    const entries = await readdir(abs, { withFileTypes: true });
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const full = join(abs, e.name);
      if (e.isDirectory()) {
        if (!ignore.has(e.name)) await walk(full, out);
      } else if (e.isFile()) {
        out.push(relative(root, full).split(sep).join("/"));
      }
    }
  }

  async function allFiles(): Promise<string[]> {
    if (!cache) {
      const out: string[] = [];
      await walk(root, out);
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
    if (!info || !info.isFile()) throw new RepoReadError(`no such file: ${path}`, path);
    if (info.isSymbolicLink())
      throw new RepoReadError(`symbolic links are not read: ${path}`, path);
    const real = await realpath(abs);
    const realRoot = await realpath(root);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      throw new RepoReadError(`path leaves the repo: ${path}`, path);
    }
    if (info.size > maxBytes)
      throw new RepoReadError(`file is larger than ${maxBytes} bytes: ${path}`, path);
    return abs;
  }

  return {
    name,
    commit,
    async *listFiles(globs) {
      const matchers = globs.map(globToRegExp);
      for (const p of await allFiles()) if (matchers.some((m) => m.test(p))) yield p;
    },
    async readText(path) {
      const text = await readFile(await safePath(path), "utf8");
      // Strip a UTF-8 byte-order mark so line numbers and parsers agree across editors.
      return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    },
  };
}
