import { constants as fsConstants, existsSync, statSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  rmdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  changeBranch,
  withSharedFileLock,
  WORKSPACE_SCHEMA_VERSION,
  type ChangeRepo,
  type ChangeRepos,
  type ManifestRepo,
} from "@maycombhq/core";
import { readChangeRepos, writeChangeRepos } from "./files.js";

/**
 * Review round 48: git work on a base clone (a clone, a fetch and checkout, a worktree added
 * from it) holds `<base clone>.lock`, so two syncs (the app's and a terminal's, or two clicks)
 * never run git in one folder together. Cross-process (withSharedFileLock); a lock whose process
 * is gone is taken over at once. Review round 50: one whose process on this machine is alive is
 * never taken over (a clone may take longer than any stale time); another machine's goes by its
 * age. A terminal waits up to 30 minutes for it; the app's routes pass a short `waitMs`
 * (createWorkspace's lockWaitMs) and answer that a sync is running (LockHeldError).
 */
const BASE_CLONE_WAIT_MS = 30 * 60_000;
function withBaseCloneLock<T>(
  dest: string,
  id: string,
  work: () => Promise<T>,
  waitMs = BASE_CLONE_WAIT_MS,
): Promise<T> {
  return withSharedFileLock(dest, work, {
    staleMs: BASE_CLONE_WAIT_MS,
    waitMs,
    what: `git work on the base clone of ${id}`,
  });
}
import { createGit, GitError, GitStoppedError, type GitRunner } from "./git.js";
import {
  baseClonePath,
  branchCheckoutPath,
  changeWorktreesDir,
  ensureGitignore,
  legacyBranchCheckoutPath,
  toRepoRelative,
  worktreePath,
} from "./layout.js";
import { removeEditorWorkspaces, writeEditorWorkspaces } from "./editors.js";

export interface SyncResult {
  id: string;
  /** `stopped` (beta.27 review): the sync was stopped before this repo was done, or begun. */
  action: "cloned" | "updated" | "skipped" | "failed" | "stopped";
  sha?: string;
  reason?: string;
  /**
   * The branch the remote calls its default (ADR 0123), read at this sync: a warning when the
   * manifest's defaultBranch is another one. Undefined when the remote didn't say.
   */
  remoteDefault?: string;
  /** The clone of yours it was copied from (`sync --from`), when one matched. */
  from?: string;
  /**
   * Beta.27 re-review (round 2): the working files a stopped checkout's put-back found neither
   * commit's (an edit of yours, or a file written half-way), each copied before it was put back
   * (`.git/atticus-put-back/<at>/<path>`), and named in `reason` too. Never deleted by Atticus.
   */
  kept?: KeptCopy[];
}

/** A working file kept before a put-back wrote over it: its path in the clone, and the copy. */
export interface KeptCopy {
  path: string;
  copy: string;
}

export interface SyncOptions {
  /**
   * A folder holding your own clones (`atticus workspace sync --from <dir>`). A missing base
   * clone is copied from your clone of the same repo there (matched by its origin URL, else by
   * folder name), with no network: Git hard-links the objects on the same drive. It takes the
   * branch as your clone last fetched it (origin/<branch>), never your unpushed commits or
   * edits, and points origin at the manifest's URL, so later syncs fetch from the server. Your
   * clones are only read.
   */
  from?: string;
}

export interface WorkspaceManager {
  readonly root: string;
  /** Clone missing base clones and fast-forward existing ones to the default branch. One failure doesn't stop the rest. */
  sync(repos: ManifestRepo[], opts?: SyncOptions): Promise<SyncResult[]>;
  /**
   * Another branch of a repo, checked out read-only beside its base clone (ADR 0123), fetched
   * first: what `atticus scan --ref` reads. Nothing is ever committed there.
   */
  checkoutBranch(repo: ManifestRepo, branch: string): Promise<{ dir: string; commit: string }>;
  /** Create (or reuse) a worktree on change/<id> in each repo, record them in repos.yaml and write the editor workspaces. */
  openChange(change: string, repos: ManifestRepo[]): Promise<ChangeRepos>;
  /**
   * Remove worktrees whose PR merged or closed (or all of them with `all`), and the editor
   * workspaces once none remain. Worktrees with uncommitted work are kept unless `force`;
   * the task worktrees under the change's `.tasks/` folder get the same care.
   */
  prune(
    change: string,
    opts?: { all?: boolean; force?: boolean },
  ): Promise<{ removed: string[]; kept: { id: string; reason: string }[] }>;
}

/**
 * A manifest url of `.` or `./<path>` names a repo already in place under the metarepo root
 * (an adopted repo, or a folder of clones): scans read it there, so there is no base clone.
 * A url written the Windows way (`.\<path>`, or `.\\<path>` as YAML may keep it) is the same.
 * This is the one rule: sync, scans, doctor and the CLI all ask it.
 */
export function isInPlace(url: string): boolean {
  const u = url.replace(/\\/g, "/");
  return u === "." || u.startsWith("./");
}

/**
 * An in-place url as a `/` path under the root (`.` for the root itself), with `\` read as `/`
 * and empty and `.` segments dropped. Undefined for a clone url, and for a path that climbs out
 * of the root with `..`.
 */
export function inPlacePath(url: string): string | undefined {
  if (!isInPlace(url)) return undefined;
  const segs = url.split(/[\\/]+/).filter((s) => s !== "" && s !== ".");
  if (segs.includes("..")) return undefined;
  return segs.length ? segs.join("/") : ".";
}

/** The folder an in-place repo is read from under `root`; undefined when the url isn't one. */
export function inPlaceDir(root: string, url: string): string | undefined {
  const p = inPlacePath(url);
  if (p === undefined) return undefined;
  return p === "." ? root : join(root, ...p.split("/"));
}

/**
 * The remote's default branch as the base clone last heard it (refs/remotes/origin/HEAD, which
 * every sync refreshes): read offline, for doctor and the Repos screen. Undefined when unknown.
 */
export async function remoteDefaultBranch(
  dir: string,
  git: GitRunner = createGit(),
): Promise<string | undefined> {
  if (!existsSync(dir)) return undefined;
  try {
    const r = (await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], dir)).stdout;
    return r.trim().replace(/^origin\//, "") || undefined;
  } catch {
    return undefined;
  }
}

export interface WorkspaceOptions {
  /**
   * How long to wait for a base clone another sync holds before LockHeldError (default 30
   * minutes, as a terminal waits). The app's routes that answer at once pass a short one.
   */
  lockWaitMs?: number;
  /**
   * Beta.27 review: stops the work (Stop on a sync in the app). Each git it runs is given it, so
   * a stop kills the git under way; a clone half made is taken away, the base clone's lock is
   * given back, and no other repo is started (each is `stopped`).
   */
  signal?: AbortSignal;
}

/**
 * Beta.27 review: in a base clone's `.git`, while a sync checks out what it fetched: the commit
 * and branch the clone was on, clean, before, and the commit it fetched (JSON: head, branch,
 * target). A checkout stopped (Stop, Atticus closed) or killed leaves files half-written, which
 * read as local changes, and every later sync skipped the clone for ever; with the mark there, the
 * sync puts the clone back on that commit first (restoreBaseClone). Beta.27 re-review: only while
 * the clone is as that checkout could have left it, and only the paths it writes; anything else
 * there is a person's, and nothing is changed. Removed once the checkout is done.
 */
export const SYNC_CHECKOUT_MARK = "atticus-sync-checkout.json";

/** The gits that take git's index lock (`.git/index.lock`): only theirs is a killed git's to drop. */
const TAKES_INDEX_LOCK = new Set(["checkout", "status", "sparse-checkout", "read-tree", "reset"]);
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Beta.27 re-review (round 2): in a base clone's `.git`, the copies a stopped checkout's put-back
 * kept of the working files that were neither commit's, one folder a put-back (`<at>/<path>`).
 */
export const PUT_BACK_DIR = "atticus-put-back";

/**
 * Beta.27 re-review 6: whether a link's text (`readlink`) is git's own for a path whose mode in a
 * commit is `mode` and whose blob there holds `blob`. Only a link's mode (120000) is a link git
 * writes: a file whose bytes are the link's text is no link of git's. Git for Windows with
 * core.symlinks writes a link's target with `\` (`..\shared\forge-common` for the blob
 * `../shared/forge-common`), so on Windows `\` and `/` read the same; elsewhere a `\` is a
 * character of the name.
 */
export function linkTextIsBlob(
  text: string,
  mode: string,
  blob: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (mode !== "120000") return false;
  if (platform !== "win32") return text === blob;
  const slashed = (s: string) => s.replaceAll("\\", "/");
  return slashed(text) === slashed(blob);
}

/** The copies kept, said: `your version of a.txt was kept at <copy>`, and how many more. */
function sayKept(kept: readonly KeptCopy[]): string {
  const said = kept
    .slice(0, 5)
    .map((k) => `your version of ${k.path} was kept at ${k.copy}`)
    .join("; ");
  // The folder they are in: a copy is <folder>/<path>, its path's `/` the system's own.
  const k = kept[0]!;
  const folder = k.copy.slice(0, k.copy.length - k.path.length - 1);
  return kept.length > 5 ? `${said}; and ${kept.length - 5} more, kept under ${folder}` : said;
}

/** Paths in groups small enough for one command line (Windows takes about 32 000 characters). */
function inGroups(paths: readonly string[], max = 8000): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let len = 0;
  for (const p of paths) {
    if (cur.length > 0 && len + p.length + 1 > max) {
      out.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(p);
    len += p.length + 1;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/**
 * Beta.27 re-review (round 3): whether the clone's folder `dir` (`/`-separated, `.` its top) or
 * a folder on the way to it is a link, each looked at from the clone's top: what is through one
 * is outside the clone, never removed, read or copied. Nothing there: nothing beyond it either.
 */
async function throughLink(dest: string, dir: string): Promise<boolean> {
  if (dir === "." || dir === "") return false;
  let at = dest;
  for (const part of dir.split("/")) {
    at = join(at, part);
    const st = await lstat(at).catch(() => undefined);
    if (!st) return false;
    if (st.isSymbolicLink()) return true;
  }
  return false;
}

/** `git status --porcelain=v1 -z` as [XY, path] pairs (renames off, so one path each). */
function statusEntries(z: string): [string, string][] {
  return z
    .split("\0")
    .filter((e) => e.length > 3)
    .map((e) => [e.slice(0, 2), e.slice(3)]);
}

/** A few of the paths, said: `notes.txt (not tracked), pom.xml (changed)` and how many more. */
function sayPaths(entries: [string, string][]): string {
  const said = entries
    .slice(0, 5)
    .map(([xy, p]) => `${p} (${xy === "??" ? "not tracked" : "changed"})`)
    .join(", ");
  return entries.length > 5 ? `${said} and ${entries.length - 5} more` : said;
}

export function createWorkspace(
  root: string,
  git: GitRunner = createGit(),
  opts: WorkspaceOptions = {},
): WorkspaceManager {
  const signal = opts.signal;
  // The base clone a git runs in now, and git's index lock there when the stop came: that lock
  // (the same file) is the killed git's to take away; one made after it is another git's.
  // Beta.27 re-review: only a git that takes that lock (a checkout, a status) leaves it; one
  // there after a stopped fetch is another git's.
  let busy: string | undefined;
  let running: string | undefined;
  let lockAtStop: string | undefined;
  signal?.addEventListener(
    "abort",
    () => {
      if (busy && running && TAKES_INDEX_LOCK.has(running)) lockAtStop = lockOf(busy);
    },
    { once: true },
  );
  const g = async (args: string[], cwd = root) => {
    running = args[0];
    try {
      return await (signal ? git(args, cwd, { signal }) : git(args, cwd));
    } finally {
      running = undefined;
    }
  };
  const withBaseClone = <T>(dest: string, id: string, work: () => Promise<T>) =>
    withBaseCloneLock(dest, id, work, opts.lockWaitMs);
  const head = async (cwd: string) => (await g(["rev-parse", "HEAD"], cwd)).stdout.trim();
  const dirty = async (cwd: string) =>
    (await g(["status", "--porcelain", "--untracked-files=normal"], cwd)).stdout.trim() !== "";
  const refExists = async (cwd: string, ref: string) => {
    try {
      await g(["rev-parse", "--verify", "--quiet", ref], cwd);
      return true;
    } catch {
      return false;
    }
  };

  // Ask the remote which branch it calls its default (ADR 0123); never fails the sync.
  const remoteDefault = async (cwd: string): Promise<{ remoteDefault?: string }> => {
    try {
      await g(["remote", "set-head", "origin", "--auto"], cwd);
    } catch {
      // the remote didn't say; what the clone knew stays
    }
    const b = await remoteDefaultBranch(cwd, git);
    return b ? { remoteDefault: b } : {};
  };

  /**
   * A base clone copied from your clone at `from`, with no network (sync --from): a local clone
   * (hard-linked objects), origin pointed at the manifest's URL, and the branch checked out at
   * your clone's origin/<branch> (what the server had when you last fetched), else at your
   * local branch when it has never fetched.
   */
  async function copyFrom(repo: ManifestRepo, from: string, dest: string): Promise<SyncResult> {
    const branch = repo.defaultBranch;
    const sha = async (ref: string) => {
      try {
        return (
          await g(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], from)
        ).stdout.trim();
      } catch {
        return "";
      }
    };
    const at = (await sha(`refs/remotes/origin/${branch}`)) || (await sha(`refs/heads/${branch}`));
    if (!at)
      return {
        id: repo.id,
        action: "failed",
        reason: `your clone at ${from} has no ${branch} branch; fetch it there, or sync without --from`,
      };
    await g([
      "clone",
      "-c",
      "core.longpaths=true",
      "--quiet",
      "--no-tags",
      "--no-checkout",
      "--",
      from,
      dest,
    ]);
    await g(["remote", "set-url", "origin", "--", repo.url], dest);
    // Your clone's own branches came over as origin/*: replace them with the one we read.
    const refs = (
      await g(["for-each-ref", "--format=%(refname)", "refs/remotes/origin"], dest)
    ).stdout
      .split("\n")
      .filter(Boolean);
    for (const r of refs) await g(["update-ref", "-d", r], dest);
    await g(["update-ref", `refs/remotes/origin/${branch}`, at], dest);
    if (repo.sparse.length > 0) await g(["sparse-checkout", "set", "--", ...repo.sparse], dest);
    await g(["checkout", "--quiet", "-B", branch, at], dest);
    return { id: repo.id, action: "cloned", sha: await head(dest), from };
  }

  const markOf = (dest: string) => join(dest, ".git", SYNC_CHECKOUT_MARK);
  /** Which file git's index lock is (device, inode, time), or undefined when there is none. */
  function lockOf(dest: string): string | undefined {
    try {
      const st = statSync(join(dest, ".git", "index.lock"), { throwIfNoEntry: false });
      return st ? `${st.dev}:${st.ino}:${st.mtimeMs}` : undefined;
    } catch {
      return undefined;
    }
  }
  /** Git's index lock taken away when it is the one there at the stop (`atStop`). */
  async function dropKilledLock(dest: string, atStop: string | undefined): Promise<boolean> {
    const now = lockOf(dest);
    if (!now) return true;
    if (now !== atStop) return false;
    await rm(join(dest, ".git", "index.lock"), { force: true });
    return true;
  }

  /**
   * Beta.27 review: a base clone whose checkout was stopped or killed, put back on the commit it
   * was on (from its mark), with nothing of the checkout left. Beta.27 re-review: a person's work
   * is never lost to it. The mark is honoured only when a sync wrote it (both commits' full ids,
   * the manifest's branch by its plain name, the commit it fetched still origin's) and the clone
   * is as that checkout could have left it: its own repo at its own place (no link, never the
   * metarepo above it), on that branch, the branch at one of the two commits (at the fetched one
   * only when git moved it there from the other), and nothing changed or added but in the paths
   * the two commits differ in. Only those paths are put back (`checkout <commit> -- <paths>`, and
   * what the fetched commit added taken out of the index and the folder): never a blanket clean.
   * Anything else is refused, with nothing changed and how to keep it. Git's index lock goes only
   * when it is the one that was there at the stop (`atStop`: the killed git's, never another
   * git's made since). Run without the stop's signal. Beta.27 re-review (round 2): at those
   * paths, a staged blob that is neither commit's is a person's (refused, nothing changed), and a
   * working file that is neither commit's is copied to `.git/atticus-put-back/<at>/<path>` before
   * it is put back (`kept`, never deleted); what the fetched commit added goes before what it
   * changed is put back (a folder it made a file, a case-only rename). `why` is undefined when the
   * clone is back (the mark taken away), else why not (the mark stays).
   */
  async function restoreBaseClone(
    repo: ManifestRepo,
    dest: string,
    atStop?: string,
  ): Promise<{ why?: string; kept: KeptCopy[] }> {
    const kept: KeptCopy[] = [];
    const no = (why: string) => ({ why, kept });
    const mark = markOf(dest);
    const keep = (what: string) =>
      no(
        `${what}. Nothing was changed. To keep it, move it out of ${dest} (base clones are read-only) and sync again; or delete ${mark} to keep the clone as it is`,
      );
    const notOurs = (detail: string) =>
      no(
        `its mark ${mark} isn't one a sync writes (${detail}). Nothing was changed. If nothing in ${dest} is yours, put it back with git -C ${dest} checkout --force ${repo.defaultBranch} and git -C ${dest} clean -fd, then delete the mark; or delete the mark to keep the clone as it is`,
      );
    let was: { head?: unknown; target?: unknown; branch?: unknown };
    try {
      was = JSON.parse(await readFile(mark, "utf8")) as typeof was;
    } catch {
      return notOurs("it can't be read");
    }
    if (typeof was !== "object" || was === null) return notOurs("it can't be read");
    const head = typeof was.head === "string" && SHA.test(was.head) ? was.head : "";
    const target = typeof was.target === "string" && SHA.test(was.target) ? was.target : "";
    if (!head || !target) return notOurs("it names no commit it was on and none it fetched");
    const branch = typeof was.branch === "string" ? was.branch : "";
    if (branch !== repo.defaultBranch || branch.startsWith("-") || branch.startsWith("refs/"))
      return notOurs(`its branch isn't ${repo.defaultBranch}, the manifest's`);
    const ref = `refs/heads/${branch}`;
    const read = async (args: string[]) => {
      try {
        return (await git(args, dest)).stdout.trim();
      } catch {
        return "";
      }
    };
    const ok = (args: string[]) =>
      git(args, dest).then(
        () => true,
        () => false,
      );
    try {
      // Its own repo at its own place: never a link (to a person's own clone), nor the metarepo
      // above it (a .git folder git doesn't read as a repo), nor a clone moved here.
      if ((await lstat(dest)).isSymbolicLink())
        return keep(
          `${dest} is a link (to ${await realpath(dest).catch(() => "a folder that isn't there")}), not a base clone Atticus made`,
        );
      const noClone = no(
        `${dest} is no git clone of its own (its .git folder is broken). Nothing was changed. If nothing in it is yours, delete the folder ${dest} and sync again to clone it afresh; or delete ${mark} to keep it as it is`,
      );
      if (!(await lstat(join(dest, ".git"))).isDirectory()) return noClone;
      const top = await read(["rev-parse", "--show-toplevel"]);
      if (!top || (await realpath(top)) !== (await realpath(dest))) return noClone;
      if (!(await ok(["check-ref-format", ref]))) return notOurs(`${branch} is no branch name`);
      // On that branch, at the commit it was on or (moved there by git's checkout) the fetched one.
      if ((await read(["symbolic-ref", "--quiet", "HEAD"])) !== ref)
        return keep(`the base clone isn't on ${branch} as the sync left it`);
      // The commit it fetched is origin's: origin/<branch> now, or (fetched again since, by a
      // branch's checkout or a person's own git fetch) a commit the clone has that is in
      // origin/<branch>'s history or its reflog.
      const origin = `refs/remotes/origin/${branch}`;
      if (
        (await read(["rev-parse", "--verify", "--quiet", origin])) !== target &&
        !(
          (await read(["rev-parse", "--verify", "--quiet", `${target}^{commit}`])) === target &&
          ((await ok(["merge-base", "--is-ancestor", target, origin])) ||
            (await read(["reflog", "show", "--format=%H", origin, "--"]))
              .split("\n")
              .includes(target))
        )
      )
        return notOurs(`the commit it names as fetched was never origin/${branch}`);
      const tip = await read(["rev-parse", "--verify", "--quiet", ref]);
      if (tip !== head && tip !== target)
        return keep(
          `${branch} is at ${tip.slice(0, 12) || "no commit"}, a commit that sync didn't leave`,
        );
      if (tip === target && target !== head) {
        const before = await read(["rev-parse", "--verify", "--quiet", `${ref}@{1}`]);
        // Beta.27 re-review (round 2): no reflog at all (core.logAllRefUpdates off) shows nothing
        // either way: said so, without saying that work of the person's is there.
        if (before !== head && !(await ok(["reflog", "exists", ref])))
          return no(
            `${branch} is at ${tip.slice(0, 12)}, the commit that sync fetched, but this clone's history can't show the sync left it (git keeps no reflog of ${branch} there). Nothing was changed. To let Atticus put it back, set ${branch} back to the commit it was on with git -C ${dest} update-ref ${ref} ${head} ${target} and sync again; or delete ${mark} to keep the clone as it is`,
          );
        if (before !== head)
          return keep(
            `${branch} is at ${tip.slice(0, 12)} but wasn't moved there from ${head.slice(0, 12)} by that sync`,
          );
      }
      if (!(await read(["rev-parse", "--verify", "--quiet", `${head}^{commit}`])))
        return notOurs(`it names a commit the clone hasn't got`);
      // The paths the checkout writes, with each one's blob in either commit (none where a
      // commit hasn't the path); anything changed or added elsewhere is a person's.
      const differ = (
        await git(["diff-tree", "-r", "-z", "--no-renames", "--no-commit-id", head, target], dest)
      ).stdout.split("\0");
      const added = new Set<string>();
      const inBoth = new Set<string>();
      const blobs = new Map<string, Set<string>>();
      // each commit's mode and blob at a path, where a link is told by its mode (120000)
      const entries = new Map<string, [mode: string, blob: string][]>();
      const ignoreCase = (await read(["config", "--bool", "core.ignorecase"])) === "true";
      // Where case is ignored, README.md and readme.md are one file: either's blob is its own.
      const keyOf = (p: string) => (ignoreCase ? p.toLowerCase() : p);
      const NONE = /^0+$/;
      // Beta.27 re-review (round 3): a submodule (gitlink) in one commit, a file in the other.
      const swapped: string[] = [];
      for (let i = 0; i + 1 < differ.length; i += 2) {
        // `:<mode> <mode> <blob> <blob> <status>`, then the path.
        const [from, to, was, now, st] = differ[i]!.split(" ");
        const p = differ[i + 1]!;
        (st === "A" ? added : inBoth).add(p);
        const modes = [from!.slice(1), to!];
        if (modes.includes("160000") && !modes.includes("000000") && modes[0] !== modes[1])
          swapped.push(p);
        const known = blobs.get(keyOf(p)) ?? new Set<string>();
        for (const b of [was, now]) if (b && !NONE.test(b)) known.add(b);
        blobs.set(keyOf(p), known);
        const both = entries.get(keyOf(p)) ?? [];
        [was, now].forEach((b, k) => {
          if (b && !NONE.test(b)) both.push([modes[k]!, b]);
        });
        entries.set(keyOf(p), both);
      }
      const inDiff = (p: string) => added.has(p) || inBoth.has(p);
      const status = async () =>
        statusEntries(
          (
            await git(
              [
                "status",
                "--porcelain=v1",
                "-z",
                "--no-renames",
                "--untracked-files=all",
                "--ignore-submodules=none",
              ],
              dest,
            )
          ).stdout,
        );
      const theirs = (await status()).filter(([, p]) => !inDiff(p));
      if (theirs.length > 0)
        return keep(`what that checkout didn't write is changed: ${sayPaths(theirs)}`);
      // Beta.27 re-review (round 2): git's checkout stages nothing at those paths but either
      // commit's blob; any other staged there (an edit, a file made and added) is a person's.
      const staged = new Set<string>();
      const indexed: string[] = [];
      for (const e of (await git(["ls-files", "--stage", "-z"], dest)).stdout.split("\0")) {
        const tab = e.indexOf("\t");
        if (tab >= 0) indexed.push(e.slice(tab + 1));
        if (tab < 0 || !inDiff(e.slice(tab + 1))) continue;
        const [, blob, stage] = e.slice(0, tab).split(" ");
        if (stage !== "0" || !blobs.get(keyOf(e.slice(tab + 1)))?.has(blob!))
          staged.add(e.slice(tab + 1));
      }
      if (staged.size > 0)
        return no(
          `what that checkout didn't write is staged: ${sayPaths([...staged].map((p) => ["A ", p]))}. Nothing was changed. To keep it, move it out of ${dest} (base clones are read-only) and unstage it there (git -C ${dest} restore --staged -- <path>), then sync again; or delete ${mark} to keep the clone as it is`,
        );
      // Beta.27 re-review (round 3): where one commit has a submodule and the other a file, a
      // folder there with anything in it (git doesn't look inside a submodule's folder) would
      // go with the file put back.
      for (const p of swapped) {
        // never looked into through a link (a link on its way is refused as one)
        if (await throughLink(dest, dirname(p)))
          return keep(
            `a folder on the way to ${p} is a link, where one commit has a submodule and the other a file`,
          );
        const st = await lstat(join(dest, p)).catch(() => undefined);
        // Beta.27 re-review 5: a link in one commit, a submodule in the other: a link whose text
        // is the blob of the commit whose mode for it is a link's (120000) is git's own, left by
        // the stopped checkout, and is put back like any file (never followed); any other link
        // there is a person's, one whose text is a file's bytes too (re-review 6).
        if (st?.isSymbolicLink()) {
          const to = await readlink(join(dest, p));
          if (!(await gitsOwnLink(dest, to, entries.get(keyOf(p)) ?? [])))
            return keep(`${p} is a link, where one commit has a submodule and the other a file`);
        } else if (st?.isDirectory() && (await readdir(join(dest, p))).length > 0)
          return keep(
            `${p} is a folder with files in it, where one commit has a submodule and the other a file`,
          );
      }
      if (!(await dropKilledLock(dest, atStop)))
        return no(
          `git's lock ${join(dest, ".git", "index.lock")} is there: if no git is running in ${dest}, delete it; the next sync puts the clone back (its mark ${mark} stays until then)`,
        );
      if (tip !== head)
        await git(["update-ref", "-m", "atticus: a stopped sync put back", ref, head, tip], dest);
      // Only what differs now, path by path (a path outside a sparse checkout isn't there).
      const now = (await status()).map(([, p]) => p);
      // Where git is told case is ignored but the file system has it (a clone moved from a Mac),
      // a file the fetched commit added whose name differs only in case from one the index has
      // (readme.md beside README.md) is hidden from status; it is the checkout's all the same,
      // unless it is that very file (the file system ignoring case after all).
      const strays = ignoreCase ? await hiddenByCase(dest, [...added], now, indexed) : [];
      // A working file that is neither commit's (an edit of a person's, or one written half-way)
      // is copied before anything is put back, and the copy named: never lost, never deleted.
      kept.push(
        ...(await keepTheirs(
          dest,
          [...now, ...strays],
          (p) => blobs.get(keyOf(p)) ?? new Set(),
          (p) => entries.get(keyOf(p)) ?? [],
          new Set(indexed),
        )),
      );
      const back = now.filter((p) => inBoth.has(p));
      const out = now.filter((p) => added.has(p));
      // What the fetched commit added goes first, so a folder it made a file (or a file it made
      // a folder) is free for the commit the clone was on: each index entry by its exact path
      // (update-index takes no pathspec, so `conf` never means conf/app.yml), then its file.
      // Where case is ignored, readme.md (added) goes before README.md is written again, so
      // the one file on disk is never cleaned away after it.
      for (const ps of inGroups(out))
        await git(["update-index", "--force-remove", "--", ...ps], dest);
      // Each path as written (no glob, no magic of its own), after `--`.
      const lit = (ps: string[]) => ps.map((p) => `:(literal)${p}`);
      // Beta.27 re-review (round 3): never through a linked folder (what is there is outside).
      const files: string[] = [];
      for (const p of out) {
        const st = await lstat(join(dest, p)).catch(() => undefined);
        if (st && !st.isDirectory() && !(await throughLink(dest, dirname(p)))) files.push(p);
      }
      for (const ps of inGroups(files)) await git(["clean", "-fq", "--", ...lit(ps)], dest);
      // git clean takes them for the index's own: each goes by itself (kept above, if not the
      // fetched commit's), never through a link.
      for (const p of strays) await rm(join(dest, p), { force: true });
      // The folders on the way to what the fetched commit added, left empty: only those the
      // commit the clone was on hasn't got (the climb stops at the first it has: a folder, or a
      // submodule's), each only while no folder on the way to it is a link. An empty folder a
      // person made on that way goes too (nothing is in it); one anywhere else stays.
      const headFolders = new Set<string>();
      for (const e of (await git(["ls-tree", "-r", "-t", "-z", head], dest)).stdout.split("\0")) {
        const [, type] = e.slice(0, Math.max(0, e.indexOf("\t"))).split(" ");
        if (type === "tree" || type === "commit")
          headFolders.add(keyOf(e.slice(e.indexOf("\t") + 1)));
      }
      for (const p of added)
        for (let d = dirname(p); d !== "." && d !== "" && d !== "/"; d = dirname(d))
          if (
            headFolders.has(keyOf(d)) ||
            (await throughLink(dest, d)) ||
            !(await rmdir(join(dest, d)).then(
              () => true,
              () => false,
            ))
          )
            break;
      for (const ps of inGroups(back))
        await git(["checkout", "--quiet", head, "--", ...lit(ps)], dest);
      const left = await status();
      if (left.length > 0)
        return no(
          `putting it back left ${sayPaths(left)}; its mark ${mark} stays, so the next sync tries again${kept.length ? `; ${sayKept(kept)}` : ""}`,
        );
      await rm(mark, { force: true });
      return { kept };
    } catch (e) {
      return no(
        `${(e as Error).message}; its mark ${mark} stays, so the next sync tries again${kept.length ? `; ${sayKept(kept)}` : ""}`,
      );
    }
  }

  /**
   * Beta.27 re-review (round 2), git told case is ignored (core.ignorecase): of the paths the
   * fetched commit `added`, those status didn't list (`listed`) that are there as a file of their
   * own: no index entry names them but one does in another case (`indexed`), and that one isn't
   * the same file (a file system that has case), and no folder on the way is a link.
   */
  async function hiddenByCase(
    dest: string,
    added: string[],
    listed: string[],
    indexed: string[],
  ): Promise<string[]> {
    const seen = new Set(listed);
    const exact = new Set(indexed);
    const byCase = new Map<string, string[]>();
    for (const q of indexed)
      byCase.set(q.toLowerCase(), [...(byCase.get(q.toLowerCase()) ?? []), q]);
    const out: string[] = [];
    for (const p of added) {
      if (seen.has(p) || exact.has(p)) continue;
      const others = byCase.get(p.toLowerCase()) ?? [];
      if (others.length === 0) continue;
      const st = await lstat(join(dest, p)).catch(() => undefined);
      if (!st || st.isDirectory()) continue;
      let same = false;
      for (const q of others) {
        const o = await lstat(join(dest, q)).catch(() => undefined);
        if (o && o.dev === st.dev && o.ino === st.ino) same = true;
      }
      if (!same && !(await throughLink(dest, dirname(p)))) out.push(p);
    }
    return out;
  }

  /**
   * Beta.27 re-review 6: whether a link whose text is `to` is git's own: the blob of one of
   * `entries` (a commit's mode and blob at its path) whose mode is a link's (`linkTextIsBlob`:
   * `\` read as `/` on Windows). Only a link's blob is read.
   */
  async function gitsOwnLink(
    dest: string,
    to: string,
    entries: readonly (readonly [mode: string, blob: string])[],
  ): Promise<boolean> {
    for (const [mode, b] of entries) {
      if (mode !== "120000") continue;
      const text = (await git(["cat-file", "blob", b], dest).catch(() => undefined))?.stdout;
      if (text !== undefined && linkTextIsBlob(to, mode, text)) return true;
    }
    return false;
  }

  /**
   * Beta.27 re-review (round 2): each of `paths` whose working file is none of its `known`
   * blobs (`git hash-object`, so git's own filters apply), copied to
   * `.git/atticus-put-back/<at>/<path>` before the put-back writes over it. A folder or a path
   * that isn't there has nothing to copy. The copies are never deleted by Atticus. Beta.27
   * re-review (round 3): one path a file. Where case is ignored, status lists a case-only rename
   * as two paths (D README.md, AM readme.md) that are one file: it is copied once, named after
   * the path the index has (`indexed` first), the other left out by device and inode; a name
   * already copied in another case whose bytes are this one's (a system that gives no inode) is
   * kept already. Nothing is read through a linked folder (what is there is outside the clone).
   * A link is git's own only as a link's blob in a commit (`gitsOwnLink`, by `entries`).
   */
  async function keepTheirs(
    dest: string,
    paths: string[],
    known: (p: string) => Set<string>,
    entries: (p: string) => readonly (readonly [mode: string, blob: string])[],
    indexed: ReadonlySet<string>,
  ): Promise<KeptCopy[]> {
    const files: string[] = [];
    const links: string[] = [];
    // one copy per file: a name that is the same file as one kept already, in another case only
    // (a case-only rename on a file system that ignores case); two tracked paths that are hard
    // links of each other are both named
    const seen = new Map<string, string>();
    const first = [...new Set(paths)].sort((a, b) => +indexed.has(b) - +indexed.has(a));
    for (const p of first) {
      if (await throughLink(dest, dirname(p))) continue;
      const st = await lstat(join(dest, p), { bigint: true }).catch(() => undefined);
      if (!st) continue;
      const id = `${st.dev}:${st.ino}`;
      const was = seen.get(id);
      if (st.ino !== 0n && was !== undefined && was.toLowerCase() === p.toLowerCase()) continue;
      if (was === undefined) seen.set(id, p);
      if (st.isFile()) files.push(p);
      else if (st.isSymbolicLink()) links.push(p);
    }
    const theirs: string[] = [];
    for (const ps of inGroups(files)) {
      const ids = (await git(["hash-object", "--", ...ps], dest)).stdout.trim().split("\n");
      ps.forEach((p, i) => {
        if (!known(p).has(ids[i]!.trim())) theirs.push(p);
      });
    }
    const linkText = new Map<string, string>();
    for (const p of links) {
      const to = await readlink(join(dest, p));
      linkText.set(p, to);
      if (!(await gitsOwnLink(dest, to, entries(p)))) theirs.push(p);
    }
    if (theirs.length === 0) return [];
    const top = join(dest, ".git", PUT_BACK_DIR);
    await mkdir(top, { recursive: true });
    // never copied through a link put at the put-back folder's place
    if (!(await lstat(top)).isDirectory())
      throw new Error(`${top} isn't a folder of its own (a link?): nothing was copied there`);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let at = join(top, stamp);
    for (let n = 2; ; n++) {
      try {
        await mkdir(at);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST" || n > 100) throw e;
        at = join(top, `${stamp}-${n}`);
      }
    }
    const out: KeptCopy[] = [];
    for (const p of theirs) {
      const copy = join(at, ...p.split("/"));
      await mkdir(dirname(copy), { recursive: true });
      const to = linkText.get(p);
      try {
        if (to === undefined) await copyFile(join(dest, p), copy, fsConstants.COPYFILE_EXCL);
        else await symlink(to, copy).catch(() => writeFile(copy, to, { flag: "wx" }));
      } catch (e) {
        // Where case is ignored, the same name in another case, copied already: the same file
        // if its bytes are this one's (never read through a link).
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        const c = await lstat(copy);
        const there = c.isSymbolicLink()
          ? (await readlink(copy)) === to
          : c.isFile() &&
            (await readFile(copy)).equals(
              to === undefined ? await readFile(join(dest, p)) : Buffer.from(to),
            );
        if (!there) throw e;
        continue;
      }
      out.push({ path: p, copy });
    }
    return out;
  }

  /**
   * Beta.27 review: a repo whose git was stopped. A clone this sync made is taken away (Windows
   * may hold its files a moment after the kill: tried a few times), so the next sync clones it
   * again; a base clone that was there keeps everything but the index lock a killed git leaves.
   * A folder that can't be taken away is named, to delete by hand.
   */
  async function stoppedOne(
    repo: ManifestRepo,
    dest: string,
    made: boolean,
    updatedTo?: string,
  ): Promise<SyncResult> {
    if (made) {
      const gone = await rm(dest, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
        .then(() => true)
        .catch(() => false);
      return {
        id: repo.id,
        action: "stopped",
        reason: gone
          ? "stopped: the clone it had started was taken away; sync again to clone it"
          : `stopped: the clone it had started couldn't be taken away; delete ${dest} before you sync again`,
      };
    }
    // Beta.27 re-review (round 2): stopped once its checkout was done and the mark gone (reading
    // the commit, asking the remote its default): the clone was updated, nothing to put back.
    if (updatedTo !== undefined)
      return {
        id: repo.id,
        action: "stopped",
        sha: updatedTo,
        reason: `stopped once the base clone was updated, to ${repo.defaultBranch} at ${updatedTo.slice(0, 12)}; sync again to finish`,
      };
    // Stopped in its checkout: the clone is put back on the commit it was on.
    if (existsSync(markOf(dest))) {
      const { why, kept } = await restoreBaseClone(repo, dest, lockAtStop);
      return {
        id: repo.id,
        action: "stopped",
        ...(kept.length ? { kept } : {}),
        reason: why
          ? `stopped in the base clone's checkout, and it wasn't put back as it was: ${why}`
          : `stopped: the base clone is back as it was before this sync${kept.length ? `; ${sayKept(kept)}` : ""}; sync again`,
      };
    }
    // Stopped before its checkout (a fetch, a status): the files are as they were; a lock goes
    // only when the stopped git takes it (lockAtStop is then the file there at the stop).
    await dropKilledLock(dest, lockAtStop).catch(() => false);
    return {
      id: repo.id,
      action: "stopped",
      reason: "stopped: the base clone is as it was before this sync; sync again",
    };
  }

  async function syncOne(
    repo: ManifestRepo,
    local: Map<string, string> | undefined,
  ): Promise<SyncResult> {
    if (repo.archived) return { id: repo.id, action: "skipped", reason: "archived" };
    if (isInPlace(repo.url))
      return {
        id: repo.id,
        action: "skipped",
        reason: `in place at ${repo.url}, nothing to clone`,
      };
    const dest = baseClonePath(root, repo.id);
    const branch = repo.defaultBranch;
    // Made by this sync: a clone or copy that fails half-way (git leaves the folder when only its
    // checkout fails) is taken away, so the next sync clones it again rather than calling it a
    // base clone with local changes forever.
    const made = !existsSync(dest);
    busy = made ? undefined : dest;
    // What an earlier sync's put-back kept (said in whatever this sync ends with), and the commit
    // this sync's checkout left the clone on once it was done (its mark gone).
    let earlier: KeptCopy[] = [];
    let updatedTo: string | undefined;
    const said = (r: SyncResult): SyncResult =>
      earlier.length === 0
        ? r
        : {
            ...r,
            kept: [...earlier, ...(r.kept ?? [])],
            reason: `${r.reason ? `${r.reason}; ` : ""}an earlier sync's stopped checkout was put back first: ${sayKept(earlier)}`,
          };
    try {
      if (made) {
        await mkdir(dirname(dest), { recursive: true });
        const from = local && yourClone(local, repo);
        if (from) return await copyFrom(repo, from, dest);
        // Review round 32: a clone-level -c is kept in the clone's config, so the person's own git
        // (and the editor's) copes with paths past 260 characters in the clone and its worktrees.
        const args = [
          "clone",
          "-c",
          "core.longpaths=true",
          "--no-tags",
          "--branch",
          branch,
          "--filter=blob:none",
        ];
        if (repo.sparse.length > 0) args.push("--sparse");
        args.push("--", repo.url, dest);
        await g(args);
        if (repo.sparse.length > 0) await g(["sparse-checkout", "set", "--", ...repo.sparse], dest);
        return {
          id: repo.id,
          action: "cloned",
          sha: await head(dest),
          ...(await remoteDefault(dest)),
        };
      }
      // An earlier sync's checkout, stopped or killed: put back before anything else.
      if (existsSync(markOf(dest))) {
        const { why, kept } = await restoreBaseClone(repo, dest);
        if (why)
          return {
            id: repo.id,
            action: "failed",
            ...(kept.length ? { kept } : {}),
            reason: `an earlier sync was stopped in the base clone's checkout, and it wasn't put back: ${why}`,
          };
        earlier = kept;
      }
      if (await dirty(dest)) {
        return said({
          id: repo.id,
          action: "skipped",
          sha: await head(dest),
          reason: "the base clone has local changes; base clones are read-only",
        });
      }
      const before = await head(dest);
      await g(
        ["fetch", "--no-tags", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
        dest,
      );
      const target = (
        await g(
          ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}^{commit}`],
          dest,
        )
      ).stdout.trim();
      // Clean until now: what the checkout leaves if it is stopped is Atticus's own to undo, in
      // the paths the two commits differ in.
      await writeFile(
        markOf(dest),
        `${JSON.stringify({ head: before, target, branch, at: new Date().toISOString() })}\n`,
        "utf8",
      );
      await g(["checkout", "--quiet", "-B", branch, `refs/remotes/origin/${branch}`], dest);
      if (repo.sparse.length > 0) await g(["sparse-checkout", "set", "--", ...repo.sparse], dest);
      await rm(markOf(dest), { force: true });
      updatedTo = target;
      return said({
        id: repo.id,
        action: "updated",
        sha: await head(dest),
        ...(await remoteDefault(dest)),
      });
    } catch (err) {
      if (signal?.aborted || err instanceof GitStoppedError)
        return said(await stoppedOne(repo, dest, made, updatedTo));
      if (made) await rm(dest, { recursive: true, force: true }).catch(() => undefined);
      const msg = (err as Error).message;
      // A checkout that failed leaves its mark: the next sync puts the clone back first.
      const marked =
        !made && existsSync(markOf(dest))
          ? `; the base clone's checkout mark ${markOf(dest)} stays, so the next sync puts the clone back first`
          : "";
      return said({
        id: repo.id,
        action: "failed",
        reason: /Filename too long/i.test(msg)
          ? `${msg.trim()} — a path in the repo is longer than Windows allows: run git config --global core.longpaths true, then sync again${marked}`
          : `${msg}${marked}`,
      });
    } finally {
      // Done with this repo: a later stop is no longer about its git or its lock.
      busy = undefined;
      lockAtStop = undefined;
    }
  }

  async function worktreeFor(change: string, repo: ManifestRepo): Promise<ChangeRepo> {
    const base = baseClonePath(root, repo.id);
    if (!existsSync(base))
      throw new Error(`no base clone for ${repo.id}; run atticus workspace sync first`);
    const branch = changeBranch(change);
    const path = worktreePath(root, change, repo.id);
    const baseRef = `refs/remotes/origin/${repo.defaultBranch}`;
    const baseSha = (await g(["rev-parse", baseRef], base)).stdout.trim();

    if (!existsSync(path)) {
      await mkdir(dirname(path), { recursive: true });
      // Someone may already have pushed this change's branch; continue from it if so.
      try {
        await g(
          ["fetch", "--no-tags", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
          base,
        );
      } catch {
        // no remote branch yet
      }
      if (await refExists(base, `refs/heads/${branch}`)) {
        await g(["worktree", "add", "--", path, branch], base);
      } else if (await refExists(base, `refs/remotes/origin/${branch}`)) {
        await g(
          ["worktree", "add", "--track", "-b", branch, "--", path, `refs/remotes/origin/${branch}`],
          base,
        );
      } else {
        await g(["worktree", "add", "--no-track", "-b", branch, "--", path, baseRef], base);
      }
    }
    return {
      id: repo.id,
      branch,
      base: repo.defaultBranch,
      baseSha,
      worktree: toRepoRelative(root, path),
      build: { status: "not-run" },
    };
  }

  async function checkoutOne(
    repo: ManifestRepo,
    branch: string,
  ): Promise<{ dir: string; commit: string }> {
    const base = baseClonePath(root, repo.id);
    if (!existsSync(base))
      throw new Error(`no base clone for ${repo.id}; run atticus workspace sync first`);
    const ref = `refs/remotes/origin/${branch}`;
    try {
      await g(["fetch", "--no-tags", "origin", `+refs/heads/${branch}:${ref}`], base);
    } catch {
      throw new Error(`${repo.id} has no branch ${branch} on its remote`);
    }
    const dir = branchCheckoutPath(root, repo.id, branch);
    // Review round 46: a branch with capitals had a folder named with them; its checkout moves
    // to the new name (git's own move, so the base clone's worktree list follows) and is then
    // checked out as any other, so a folder shared on NTFS ends on the right commit.
    const old = legacyBranchCheckoutPath(root, repo.id, branch);
    if (old !== dir && !existsSync(dir) && existsSync(old))
      await g(["worktree", "move", "--", old, dir], base).catch(() => undefined);
    if (!existsSync(dir)) {
      await mkdir(dirname(dir), { recursive: true });
      await g(["worktree", "add", "--detach", "--", dir, ref], base);
    } else {
      // A person's edits in the checkout are never thrown away by a forced checkout.
      if (await dirty(dir))
        throw new Error(
          `${repo.id}'s checkout of ${branch} has local changes: commit or stash them in ${dir}, then try again`,
        );
      await g(["checkout", "--quiet", "--force", "--detach", ref], dir);
    }
    return { dir, commit: await head(dir) };
  }

  return {
    root,

    async sync(repos, opts = {}) {
      // Only base clones need workspace/ ignored; a root of in-place repos (an adopted repo)
      // must stay untouched.
      if (repos.some((r) => !r.archived && !isInPlace(r.url))) await ensureGitignore(root);
      const out: SyncResult[] = [];
      const local = opts.from ? await localClones(opts.from, git) : undefined;
      for (const repo of repos) {
        // Beta.27 review: stopped, the rest are not begun.
        if (signal?.aborted) {
          out.push({ id: repo.id, action: "stopped", reason: "not started: the sync was stopped" });
          continue;
        }
        out.push(
          // Nothing to lock (nor a folder to make) for an archived or in-place repo.
          repo.archived || isInPlace(repo.url)
            ? await syncOne(repo, local)
            : await withBaseClone(baseClonePath(root, repo.id), repo.id, () =>
                syncOne(repo, local),
              ),
        );
      }
      return out;
    },

    checkoutBranch(repo, branch) {
      // Fetched into the base clone and added as its worktree: under the base clone's lock.
      return withBaseClone(baseClonePath(root, repo.id), repo.id, () => checkoutOne(repo, branch));
    },

    async openChange(change, repos) {
      await ensureGitignore(root);
      const existing = await readChangeRepos(root, change);
      const byId = new Map((existing?.repos ?? []).map((r) => [r.id, r]));
      for (const repo of repos) {
        // Its base clone fetches and adds a worktree: under the base clone's lock, as sync is.
        const fresh = await withBaseClone(baseClonePath(root, repo.id), repo.id, () =>
          worktreeFor(change, repo),
        );
        const prior = byId.get(repo.id);
        // Keep what is already known (PR, build, original base) for repos opened before.
        byId.set(repo.id, prior ? { ...fresh, ...prior, worktree: fresh.worktree } : fresh);
      }
      const value: ChangeRepos = {
        schemaVersion: WORKSPACE_SCHEMA_VERSION,
        change,
        repos: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
      };
      await writeChangeRepos(root, value);
      await writeEditorWorkspaces(root, value);
      return value;
    },

    async prune(change, opts = {}) {
      const repos = await readChangeRepos(root, change);
      const removed: string[] = [];
      const kept: { id: string; reason: string }[] = [];
      if (!repos) return { removed, kept };
      // One worktree: kept with uncommitted work unless forced, else `git worktree remove`.
      const removeOne = async (id: string, path: string, repo: string) => {
        try {
          if (!opts.force && (await dirty(path))) {
            kept.push({ id, reason: "uncommitted changes in the worktree" });
            return;
          }
          const args = ["worktree", "remove"];
          if (opts.force) args.push("--force");
          await g([...args, "--", path], baseClonePath(root, repo));
          removed.push(id);
        } catch (err) {
          kept.push({ id, reason: err instanceof GitError ? err.message : String(err) });
        }
      };
      const waiting = new Set<string>();
      for (const r of repos.repos) {
        const done = r.pr?.state === "merged" || r.pr?.state === "closed";
        if (!done && !opts.all) {
          kept.push({ id: r.id, reason: r.pr ? `PR is ${r.pr.state}` : "no PR yet" });
          waiting.add(r.id);
          continue;
        }
        const path = worktreePath(root, change, r.id);
        if (!existsSync(path)) {
          removed.push(r.id);
          continue;
        }
        await removeOne(r.id, path, r.id);
      }
      // Final review (git and tasks): an AI task run's worktree sits inside the change's folder,
      // .tasks/<task>/<repo>; each gets the same care, so the folder goes only once none is kept.
      const tasksDir = join(changeWorktreesDir(root, change), ".tasks");
      const subdirs = async (dir: string) =>
        (await readdir(dir, { withFileTypes: true }).catch(() => []))
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
          .sort();
      const taskRepos = new Set<string>();
      for (const task of await subdirs(tasksDir))
        for (const repo of await subdirs(join(tasksDir, task))) {
          taskRepos.add(repo);
          if (waiting.has(repo)) continue;
          await removeOne(`${repo} task ${task}`, join(tasksDir, task, repo), repo);
        }
      for (const id of new Set([...repos.repos.map((r) => r.id), ...taskRepos])) {
        let base: string;
        try {
          base = baseClonePath(root, id);
        } catch {
          continue;
        }
        if (existsSync(base)) await g(["worktree", "prune"], base).catch(() => undefined);
      }
      if (kept.length === 0) {
        await removeEditorWorkspaces(root, change);
        await rm(changeWorktreesDir(root, change), { recursive: true, force: true });
      }
      return { removed, kept };
    },
  };
}

/**
 * A remote URL as a key: no credentials, no trailing `.git` or `/`, the host in lower case and
 * `git@host:path` written as `host/path`, so a clone made over SSH matches a manifest's HTTPS.
 */
export function remoteKey(url: string): string {
  let u = url.trim().replace(/\\/g, "/");
  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(u);
  if (scp) u = `${scp[1]}/${scp[2]}`;
  u = u.replace(/^[a-z+]+:\/\//i, "").replace(/^[^@/]+@/, "");
  u = u
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  const slash = u.indexOf("/");
  return slash < 0 ? u.toLowerCase() : u.slice(0, slash).toLowerCase() + u.slice(slash);
}

/**
 * Your clones under `dir` (two levels deep), by their origin's key and by folder name. The
 * origin URL is asked of Git (`git config --get`, local, no network): the config file escapes a
 * Windows path's backslashes, which a reader of the file would have to undo.
 */
async function localClones(dir: string, g: GitRunner): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const visit = async (d: string, depth: number) => {
    let names: string[];
    try {
      names = await readdir(d);
    } catch {
      return;
    }
    if (names.includes(".git")) {
      const url = await g(["config", "--get", "remote.origin.url"], d).then(
        (r) => r.stdout.trim(),
        () => "",
      );
      if (url && !found.has(`url:${remoteKey(url)}`)) found.set(`url:${remoteKey(url)}`, d);
      if (!found.has(`name:${nameKey(basename(d))}`)) found.set(`name:${nameKey(basename(d))}`, d);
      return;
    }
    if (depth === 0) return;
    for (const n of names)
      if (!n.startsWith(".") && n !== "node_modules") await visit(join(d, n), depth - 1);
  };
  await visit(dir, 2);
  return found;
}

const yourClone = (local: Map<string, string>, repo: ManifestRepo): string | undefined =>
  local.get(`url:${remoteKey(repo.url)}`) ?? local.get(`name:${nameKey(repo.id)}`);

/**
 * A folder name or repo id as a key: lower case, anything but letters, digits, `.`, `_` and `-`
 * as `-`, the way an id is made from a folder (`Forge_Onboarding_1-0` is `forge_onboarding_1-0`).
 */
const nameKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
