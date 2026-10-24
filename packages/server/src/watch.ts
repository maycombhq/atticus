import { statSync, watch, type FSWatcher } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  catalogDirOf,
  inputsDirOf,
  knowledgeDirOf,
  openspecDirOf,
  orgPackDirOf,
  proposalsDirOf,
  questionsDirOf,
  runsDirOf,
  specsDirOf,
} from "@maycombhq/core";

/**
 * The server follows the metarepo's files (ADR 0119). What an assistant, the CLI or a person
 * writes reaches the app as a `file.changed` live event, so a browser and IntelliJ's panel
 * update as the VS Code panel does, without a reload.
 *
 * It follows the folders Atticus keeps its files in (the org pack, the catalog, OpenSpec, specs,
 * questions, knowledge, proposals, inputs, the model runs and the prompt history), not the base
 * clones, the index or Git: those change while the app reads, and following them would make the
 * app read again for nothing. A folder made later is followed from then on.
 */

export interface MetarepoWatch {
  /** The folders followed, from the root with forward slashes. */
  readonly following: string[];
  /** Folders that couldn't be followed, and why (shown by health; the app still works by reload). */
  readonly problems: string[];
  close(): void;
}

export interface WatchOptions {
  root: string;
  publish: (e: { type: "file.changed"; path: string }) => void;
  /** Quiet time before the paths written are sent. Default 300 ms. */
  delayMs?: number;
  /** More paths than this at once are sent as their top folders. Default 50. */
  maxPaths?: number;
}

/** Never followed: they change as the app reads, or they are code, not Atticus's files. */
const SKIP = new Set([".git", "node_modules", ".index", "workspace", "logs", ".vitest-cache"]);
/** Editors' and downloads' temporary files. */
const TEMP = /(~|\.swp|\.swx|\.tmp|\.crdownload|\.part)$/i;

const posix = (p: string) => p.split(sep).join("/");

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

export function watchMetarepo(o: WatchOptions): MetarepoWatch {
  const root = o.root;
  const delay = o.delayMs ?? 300;
  const maxPaths = o.maxPaths ?? 50;
  const watchers = new Map<string, FSWatcher>();
  const problems: string[] = [];
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let first = 0;
  let closed = false;

  const skipped = (rel: string) =>
    rel === "" || rel.startsWith("..") || TEMP.test(rel) || rel.split("/").some((s) => SKIP.has(s));

  const flush = () => {
    timer = undefined;
    first = 0;
    if (closed || !pending.size) return;
    let out = [...pending].sort();
    pending.clear();
    if (out.length > maxPaths)
      out = [...new Set(out.map((p) => p.split("/").slice(0, 2).join("/")))].sort();
    for (const path of out) o.publish({ type: "file.changed", path });
  };

  const note = (abs: string) => {
    const rel = posix(relative(root, abs));
    if (skipped(rel)) return;
    pending.add(rel);
    const now = Date.now();
    if (!first) first = now;
    clearTimeout(timer);
    // Wait for quiet, but never more than a few delays while writes keep coming.
    timer = setTimeout(flush, now - first > delay * 5 ? 0 : delay);
  };

  /** The folders Atticus keeps files in, as they resolve now (the layout can name others). */
  const folders = (): string[] => {
    const all = [
      orgPackDirOf(root),
      catalogDirOf(root),
      openspecDirOf(root),
      specsDirOf(root),
      questionsDirOf(root),
      knowledgeDirOf(root),
      proposalsDirOf(root),
      inputsDirOf(root),
      runsDirOf(root),
      join(root, ".atticus", "history"),
    ].filter((d) => !skipped(posix(relative(root, d))));
    const unique = [...new Set(all)].sort();
    // A folder inside another followed one is already covered.
    return unique.filter((d) => !unique.some((p) => p !== d && d.startsWith(p + sep)));
  };

  const follow = (dir: string, recursive: boolean) => {
    if (closed || watchers.has(dir) || !isDir(dir)) return;
    try {
      const w = watch(dir, { recursive }, (_event, name) => {
        if (!recursive && name) {
          // A new top folder may be one Atticus keeps files in: follow it from now on.
          attach();
          // A folder already followed reports its own files.
          if (watchers.has(join(dir, String(name)))) return;
        }
        note(name ? join(dir, String(name)) : dir);
      });
      w.on("error", (e) => {
        problems.push(`${posix(relative(root, dir)) || "."}: ${e.message}`);
        w.close();
        watchers.delete(dir);
      });
      watchers.set(dir, w);
    } catch (e) {
      problems.push(`${posix(relative(root, dir)) || "."}: ${(e as Error).message}`);
    }
  };

  const attach = () => {
    for (const d of folders()) follow(d, true);
  };

  // The root and .atticus/, not recursively: they say when a followed folder appears, and
  // carry the files directly in them (.atticus/me.yaml).
  follow(root, false);
  follow(join(root, ".atticus"), false);
  attach();

  return {
    get following() {
      return [...watchers.keys()]
        .filter((d) => d !== root && d !== join(root, ".atticus"))
        .map((d) => posix(relative(root, d)))
        .sort();
    },
    problems,
    close() {
      closed = true;
      clearTimeout(timer);
      for (const w of watchers.values()) w.close();
      watchers.clear();
      pending.clear();
    },
  };
}
