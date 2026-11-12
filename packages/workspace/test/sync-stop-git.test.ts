import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ManifestRepo } from "@maycombhq/core";
import {
  baseClonePath,
  createGit,
  createWorkspace,
  GitStoppedError,
  SYNC_CHECKOUT_MARK,
  type GitRunner,
} from "../src/index.js";
import { linkTextIsBlob } from "../src/manager.js";

/**
 * Beta.27 re-review: a stop during the checkout of an existing base clone left it with
 * half-written files, and every later sync skipped it ("the base clone has local changes")
 * for ever. The sync now marks the checkout, puts the clone back on the commit it was on when
 * it is stopped, and the next sync honours a mark left behind. Real git, local only (no network).
 */

const T = 60_000;

function realGit(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
  ).trim();
}

const made: string[] = [];
afterEach(async () => {
  for (const d of made.splice(0)) await rm(d, { recursive: true, force: true });
});

/**
 * Files of a commit: a text is written (whatever was at that path first goes), null deletes, a
 * link is made, a gitlink (a submodule's commit) is put in the index.
 */
type Tree = Record<string, string | null | { link: string } | { gitlink: string }>;
/** Files written in the clone: a text is written, null deletes. */
type Files = Record<string, string | null>;

/** Whether this file system ignores case (README.md and readme.md one file), tried in a temp dir. */
function fsIgnoresCase(): boolean {
  const d = mkdtempSync(join(tmpdir(), "atticus-case-"));
  try {
    writeFileSync(join(d, "case"), "a");
    try {
      writeFileSync(join(d, "CASE"), "b", { flag: "wx" });
      return false;
    } catch {
      return true;
    }
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}
const IGNORES_CASE = fsIgnoresCase();

async function setUp(
  first: Tree = { "pom.xml": "<project/>\n", "src/Ledger.java": "class Ledger {}\n" },
  second: Tree = {
    "src/Ledger.java": "class Ledger { int limit; }\n",
    "src/Limits.java": "class Limits {}\n",
  },
) {
  const dir = await mkdtemp(join(tmpdir(), "atticus-sync-stop-git-"));
  made.push(dir);
  const root = join(dir, "metarepo");
  await mkdir(root);
  realGit(root, "init", "-q");
  const work = join(dir, "src", "forge-ledger");
  await mkdir(work, { recursive: true });
  realGit(work, "init", "-q", "-b", "main");
  const commit = async (files: Tree) => {
    const gitlinks: string[] = [];
    for (const [p, t] of Object.entries(files)) {
      await rm(join(work, p), { recursive: true, force: true });
      // a removed path leaves the index by name, so a case-only rename is a delete and an add on
      // a file system that ignores case too (where add -A would record it as a change)
      if (t === null) {
        realGit(work, "rm", "-q", "-r", "--cached", "--ignore-unmatch", "--", p);
        continue;
      }
      await mkdir(dirname(join(work, p)), { recursive: true });
      if (typeof t === "string") await writeFile(join(work, p), t);
      else if ("link" in t) await symlink(t.link, join(work, p));
      else gitlinks.push(`160000,${t.gitlink},${p}`);
    }
    realGit(work, "add", "-A");
    for (const g of gitlinks) realGit(work, "update-index", "--add", "--cacheinfo", g);
    realGit(work, "commit", "-q", "-m", "update");
  };
  await commit(first);
  const url = join(dir, "remotes", "forge-ledger.git");
  realGit(dir, "clone", "-q", "--bare", work, url);
  realGit(work, "remote", "add", "origin", url);
  const r = ManifestRepo.parse({ id: "forge-ledger", url, type: "service", owner: "team" });
  const [cloned] = await createWorkspace(root).sync([r]);
  expect(cloned!.action).toBe("cloned");
  const dest = baseClonePath(root, "forge-ledger");
  const old = realGit(dest, "rev-parse", "HEAD");
  await commit(second);
  realGit(work, "push", "-q", "origin", "main");
  const next = realGit(work, "rev-parse", "HEAD");
  return { root, r, dest, old, next, work, commit };
}

/** The copies a put-back kept of a person's versions, as `<path>` → its text. */
async function keptCopies(dest: string): Promise<Record<string, string>> {
  const top = join(dest, ".git", "atticus-put-back");
  const out: Record<string, string> = {};
  if (!existsSync(top)) return out;
  for (const at of await readdir(top))
    for (const e of await readdir(join(top, at), { recursive: true, withFileTypes: true }))
      if (e.isFile()) {
        const full = join(e.parentPath, e.name);
        out[relative(join(top, at), full).split(sep).join("/")] = await readFile(full, "utf8");
      }
  return out;
}

/** Real git, but its checkout is killed half-way: some files written, git's lock left. */
function stoppedInCheckout(dest: string, reached: () => void): GitRunner {
  const real = createGit();
  let killed = false;
  return async (args, cwd, o) => {
    // The sync's checkout (given the stop's signal); the one putting the clone back is real.
    if (args[0] !== "checkout" || killed || !o?.signal) return real(args, cwd, o);
    killed = true;
    await writeFile(join(dest, "src", "Ledger.java"), "class Ledger { int lim");
    await writeFile(join(dest, "src", "Limits.java"), "class Lim");
    await writeFile(join(dest, ".git", "index.lock"), "");
    reached();
    return new Promise((_, reject) => {
      const stop = () => reject(new GitStoppedError(args));
      if (o?.signal?.aborted) stop();
      o?.signal?.addEventListener("abort", stop, { once: true });
    });
  };
}

/** What a checkout killed with Atticus leaves: the fetch done, half-written files, the mark. */
async function killedInCheckout(dest: string, old: string, next: string, mark?: object) {
  realGit(dest, "fetch", "-q", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main");
  await writeFile(join(dest, "src", "Ledger.java"), "class Ledger { int lim");
  await writeFile(join(dest, "src", "Limits.java"), "class Lim");
  await writeFile(
    join(dest, ".git", SYNC_CHECKOUT_MARK),
    JSON.stringify(mark ?? { head: old, target: next, branch: "main" }),
  );
}

/** Nothing of the killed checkout was undone: its half-written files and its mark are there. */
async function untouched(dest: string, old: string) {
  expect(realGit(dest, "rev-parse", "HEAD")).toBe(old);
  expect(await readFile(join(dest, "src", "Limits.java"), "utf8")).toBe("class Lim");
  expect(await readFile(join(dest, "src", "Ledger.java"), "utf8")).toBe("class Ledger { int lim");
  expect(existsSync(join(dest, ".git", SYNC_CHECKOUT_MARK))).toBe(true);
}

function startStopped(root: string, dest: string, r: ManifestRepo) {
  const stop = new AbortController();
  let reached!: () => void;
  const inCheckout = new Promise<void>((res) => (reached = res));
  const done = createWorkspace(root, stoppedInCheckout(dest, reached), {
    signal: stop.signal,
  }).sync([r]);
  return { stop, inCheckout, done };
}

describe("a sync stopped in an existing base clone's checkout (real git)", () => {
  it(
    "puts the clone back on the commit it was on, and the next sync updates it",
    async () => {
      const { root, r, dest, old, next } = await setUp();
      const { stop, inCheckout, done } = startStopped(root, dest, r);
      await inCheckout;
      expect(existsSync(join(dest, ".git", SYNC_CHECKOUT_MARK))).toBe(true);
      stop.abort();
      const [res] = await done;
      expect(res!.action).toBe("stopped");
      expect(res!.reason).toMatch(/back as it was/);
      // Clean, on the commit it was on, no lock, no mark.
      expect(realGit(dest, "status", "--porcelain")).toBe("");
      expect(realGit(dest, "rev-parse", "HEAD")).toBe(old);
      expect(existsSync(join(dest, ".git", "index.lock"))).toBe(false);
      expect(existsSync(join(dest, ".git", SYNC_CHECKOUT_MARK))).toBe(false);
      expect(existsSync(join(dest, "src", "Limits.java"))).toBe(false);
      // The next sync isn't skipped for "local changes": it updates.
      const [again] = await createWorkspace(root).sync([r]);
      expect(again!.action).toBe("updated");
      expect(again!.sha).toBe(next);
      expect(realGit(dest, "status", "--porcelain")).toBe("");
    },
    T,
  );

  it(
    "a checkout killed with no one to put it back (Atticus gone): the next sync honours the mark",
    async () => {
      const { root, r, dest, old, next } = await setUp();
      // What a killed checkout leaves: the fetch done, half-written files and the mark.
      await killedInCheckout(dest, old, next);
      const [again] = await createWorkspace(root).sync([r]);
      expect(again!.action).toBe("updated");
      expect(again!.sha).toBe(next);
      expect(realGit(dest, "status", "--porcelain")).toBe("");
      expect(existsSync(join(dest, ".git", SYNC_CHECKOUT_MARK))).toBe(false);
    },
    T,
  );

  it(
    "a lock made after the stop (another git's) is left, and the next sync puts the clone back",
    async () => {
      const { root, r, dest, next } = await setUp();
      const { stop, inCheckout, done } = startStopped(root, dest, r);
      await inCheckout;
      stop.abort();
      // Another git took the lock after the stop: its lock is newer than the stop.
      const later = new Date(Date.now() + 60_000);
      await utimes(join(dest, ".git", "index.lock"), later, later);
      const [res] = await done;
      expect(res!.action).toBe("stopped");
      expect(res!.reason).toMatch(/next sync puts the clone back/);
      expect(res!.reason).toContain(SYNC_CHECKOUT_MARK);
      expect(existsSync(join(dest, ".git", "index.lock"))).toBe(true);
      expect(existsSync(join(dest, ".git", SYNC_CHECKOUT_MARK))).toBe(true);
      // That git is done (its lock gone): the next sync puts the clone back and updates it.
      await rm(join(dest, ".git", "index.lock"));
      const [again] = await createWorkspace(root).sync([r]);
      expect(again!.action).toBe("updated");
      expect(again!.sha).toBe(next);
      expect(realGit(dest, "status", "--porcelain")).toBe("");
    },
    T,
  );

  it(
    "a mark in a folder that is no clone of its own never resets the metarepo above it",
    async () => {
      const { root, r, dest } = await setUp();
      await writeFile(join(root, "README.md"), "metarepo\n");
      realGit(root, "add", "README.md");
      realGit(root, "commit", "-q", "-m", "m");
      await writeFile(join(root, "README.md"), "edited by a person\n");
      // The clone's repo is gone but its .git folder: git would climb to the metarepo.
      await rm(join(dest, ".git"), { recursive: true, force: true });
      await mkdir(join(dest, ".git"));
      await writeFile(
        join(dest, ".git", SYNC_CHECKOUT_MARK),
        JSON.stringify({ head: "a".repeat(40), target: "c".repeat(40), branch: "main" }),
      );
      const [res] = await createWorkspace(root).sync([r]);
      expect(res!.action).toBe("failed");
      // It says what to delete to have the clone made again.
      expect(res!.reason).toMatch(/is no git clone of its own/);
      expect(res!.reason).toContain(`delete the folder ${dest}`);
      expect(await readFile(join(root, "README.md"), "utf8")).toBe("edited by a person\n");
    },
    T,
  );
});

/**
 * Beta.27 re-review (plumbing): a mark left by a killed sync was honoured whatever the clone held
 * since, so a person's untracked notes, an uncommitted edit and a commit on main were thrown away
 * by `checkout --force` and `clean -fdq`, and the sync said `updated`; a workspace/<id> linked to
 * the person's own clone passed the "own repo" check. The mark is honoured only while the clone is
 * as that checkout could have left it, and only the paths that checkout writes are put back.
 */
describe("a checkout mark never costs a person their work (real git)", () => {
  const refused = (reason: string | undefined) => {
    expect(reason).toMatch(/Nothing was changed/);
    expect(reason).toContain(SYNC_CHECKOUT_MARK);
  };

  it(
    "an untracked file of theirs: kept, and the sync refuses and says how to keep it",
    async () => {
      const { root, r, dest, old, next } = await setUp();
      await killedInCheckout(dest, old, next);
      await writeFile(join(dest, "notes.txt"), "my notes\n");
      const [res] = await createWorkspace(root).sync([r]);
      expect(res!.action).toBe("failed");
      refused(res!.reason);
      expect(res!.reason).toContain("notes.txt");
      expect(res!.reason).toMatch(/move it out/);
      expect(await readFile(join(dest, "notes.txt"), "utf8")).toBe("my notes\n");
      await untouched(dest, old);
      // Deleting the mark keeps it all as it is: the clone is then skipped for its changes.
      await rm(join(dest, ".git", SYNC_CHECKOUT_MARK));
      const [again] = await createWorkspace(root).sync([r]);
      expect(again!.action).toBe("skipped");
      expect(await readFile(join(dest, "notes.txt"), "utf8")).toBe("my notes\n");
    },
    T,
  );

  it(
    "an uncommitted edit of theirs: kept",
    async () => {
      const { root, r, dest, old, next } = await setUp();
      await killedInCheckout(dest, old, next);
      await writeFile(join(dest, "pom.xml"), "<project><!-- mine --></project>\n");
      const [res] = await createWorkspace(root).sync([r]);
      expect(res!.action).toBe("failed");
      refused(res!.reason);
      expect(res!.reason).toContain("pom.xml");
      expect(await readFile(join(dest, "pom.xml"), "utf8")).toBe(
        "<project><!-- mine --></project>\n",
      );
      await untouched(dest, old);
    },
    T,
  );

  it(
    "a commit of theirs on main: kept",
    async () => {
      const { root, r, dest, old, next } = await setUp();
      await killedInCheckout(dest, old, next);
      await writeFile(join(dest, "pom.xml"), "<project><!-- mine --></project>\n");
      realGit(dest, "commit", "-q", "-m", "mine", "--", "pom.xml");
      const mine = realGit(dest, "rev-parse", "HEAD");
      const [res] = await createWorkspace(root).sync([r]);
      expect(res!.action).toBe("failed");
      refused(res!.reason);
      expect(res!.reason).toMatch(/commit/);
      expect(realGit(dest, "rev-parse", "refs/heads/main")).toBe(mine);
      expect(await readFile(join(dest, "pom.xml"), "utf8")).toBe(
        "<project><!-- mine --></project>\n",
      );
      expect(await readFile(join(dest, "src", "Limits.java"), "utf8")).toBe("class Lim");
    },
    T,
  );

  it(
    "a workspace/<id> that is a link to their own clone: nothing in that clone is touched",
    async () => {
      const { root, r, dest, old, next } = await setUp();
      await killedInCheckout(dest, old, next);
      const mine = join(root, "..", "my-forge-ledger");
      await rename(dest, mine);
      await symlink(mine, dest, process.platform === "win32" ? "junction" : "dir");
      const [res] = await createWorkspace(root).sync([r]);
      expect(res!.action).toBe("failed");
      refused(res!.reason);
      expect(res!.reason).toMatch(/is a link/);
      await untouched(mine, old);
    },
    T,
  );
});

describe("a checkout genuinely stopped half-way is still put back (real git)", () => {
  it(
    "with git's index already written for the new commit",
    async () => {
      const { root, r, dest, old, next } = await setUp();
      await killedInCheckout(dest, old, next);
      realGit(dest, "read-tree", next);
      const [res] = await createWorkspace(root).sync([r]);
      expect(res!.action).toBe("updated");
      // The half-written files are kept as copies (neither commit's), and said.
      expect(res!.kept?.map((k) => k.path).sort()).toEqual(["src/Ledger.java", "src/Limits.java"]);
      expect(res!.sha).toBe(next);
      expect(realGit(dest, "status", "--porcelain")).toBe("");
      expect(existsSync(join(dest, ".git", SYNC_CHECKOUT_MARK))).toBe(false);
    },
    T,
  );

  it(
    "with the branch already moved (killed after git's checkout, before the mark went)",
    async () => {
      const { root, r, dest, old, next } = await setUp();
      await killedInCheckout(dest, old, next);
      realGit(dest, "checkout", "-q", "--force", "-B", "main", "refs/remotes/origin/main");
      const [res] = await createWorkspace(root).sync([r]);
      expect(res!.action).toBe("updated");
      expect(res!.sha).toBe(next);
      expect(realGit(dest, "status", "--porcelain")).toBe("");
      expect(existsSync(join(dest, ".git", SYNC_CHECKOUT_MARK))).toBe(false);
    },
    T,
  );

  it(
    "a sync writes the commit it fetched in its mark",
    async () => {
      const { root, r, dest, next } = await setUp();
      const { stop, inCheckout, done } = startStopped(root, dest, r);
      await inCheckout;
      const mark = JSON.parse(await readFile(join(dest, ".git", SYNC_CHECKOUT_MARK), "utf8"));
      expect(mark.target).toBe(next);
      expect(mark.branch).toBe("main");
      stop.abort();
      await done;
    },
    T,
  );
});

describe("a mark a sync didn't write is refused (real git)", () => {
  const other = (sha: string) => (sha.startsWith("a") ? "b" : "a") + sha.slice(1);
  const cases: [string, (old: string, next: string) => object][] = [
    [
      "a branch given as a ref",
      (old, next) => ({ head: old, target: next, branch: "refs/heads/main" }),
    ],
    [
      "an option for a branch",
      (old, next) => ({ head: old, target: next, branch: "--orphan=main" }),
    ],
    ["another branch", (old, next) => ({ head: old, target: next, branch: "release" })],
    ["an option for a commit", (_old, next) => ({ head: "--hard", target: next, branch: "main" })],
    [
      "a commit the clone isn't on",
      (old, next) => ({ head: other(old), target: next, branch: "main" }),
    ],
    ["no fetched commit", (old) => ({ head: old, branch: "main" })],
    [
      "a fetched commit that isn't origin's",
      (old, next) => ({ head: old, target: other(next), branch: "main" }),
    ],
    ["the two swapped", (old, next) => ({ head: next, target: old, branch: "main" })],
  ];
  for (const [what, mark] of cases)
    it(
      what,
      async () => {
        const { root, r, dest, old, next } = await setUp();
        await killedInCheckout(dest, old, next, mark(old, next));
        const [res] = await createWorkspace(root).sync([r]);
        expect(res!.action).toBe("failed");
        expect(res!.reason).toMatch(/Nothing was changed/);
        expect(res!.reason).toContain(SYNC_CHECKOUT_MARK);
        await untouched(dest, old);
      },
      T,
    );
});

/**
 * Beta.27 re-review (plumbing, round 2): the paths the fetched commit writes were put back
 * whatever they held, so after a hard kill an edit of a person's to a file the fetched commit
 * changes was overwritten silently, and a file they made and `git add`ed where it adds one was
 * removed. A staged version that is neither commit's is refused, nothing changed; a working file
 * that is neither commit's is copied to .git/atticus-put-back/<at>/<path> before it is put back,
 * and the copy is named, and never deleted by Atticus.
 */
describe("a person's version of a path the fetched commit writes (real git)", () => {
  it(
    "an edit of theirs to a file the fetched commit changes: kept as a copy, named, and the clone put back",
    async () => {
      const { root, r, dest, old, next } = await setUp();
      await killedInCheckout(dest, old, next);
      // Git wrote the new file whole; the person then edited the one it was writing.
      await writeFile(join(dest, "src", "Limits.java"), "class Limits {}\n");
      await writeFile(join(dest, "src", "Ledger.java"), "class Ledger { /* mine */ }\n");
      const [res] = await createWorkspace(root).sync([r]);
      expect(res!.action).toBe("updated");
      expect(res!.sha).toBe(next);
      expect(realGit(dest, "status", "--porcelain")).toBe("");
      const copies = await keptCopies(dest);
      // Only what is neither commit's is copied: Limits.java was the fetched commit's own.
      expect(copies).toEqual({ "src/Ledger.java": "class Ledger { /* mine */ }\n" });
      expect(res!.kept).toHaveLength(1);
      expect(res!.kept![0]!.path).toBe("src/Ledger.java");
      expect(res!.kept![0]!.copy).toContain(join(dest, ".git", "atticus-put-back"));
      expect(res!.reason).toContain(
        `your version of src/Ledger.java was kept at ${res!.kept![0]!.copy}`,
      );
      expect(await readFile(res!.kept![0]!.copy, "utf8")).toBe("class Ledger { /* mine */ }\n");
      // A later sync never takes the copy away.
      const [again] = await createWorkspace(root).sync([r]);
      expect(again!.action).toBe("updated");
      expect(await keptCopies(dest)).toEqual(copies);
    },
    T,
  );

  it(
    "a file of theirs made and staged where the fetched commit adds one: refused, nothing changed",
    async () => {
      const { root, r, dest, old, next } = await setUp();
      await killedInCheckout(dest, old, next);
      await writeFile(join(dest, "src", "Limits.java"), "class Limits { /* mine */ }\n");
      realGit(dest, "add", "--", "src/Limits.java");
      const staged = realGit(dest, "ls-files", "-s", "--", "src/Limits.java");
      const [res] = await createWorkspace(root).sync([r]);
      expect(res!.action).toBe("failed");
      expect(res!.reason).toMatch(/Nothing was changed/);
      expect(res!.reason).toContain(SYNC_CHECKOUT_MARK);
      expect(res!.reason).toContain("src/Limits.java");
      expect(res!.reason).toMatch(/staged/);
      expect(res!.reason).toMatch(/restore --staged/);
      expect(await readFile(join(dest, "src", "Limits.java"), "utf8")).toBe(
        "class Limits { /* mine */ }\n",
      );
      expect(realGit(dest, "ls-files", "-s", "--", "src/Limits.java")).toBe(staged);
      expect(realGit(dest, "rev-parse", "HEAD")).toBe(old);
      expect(existsSync(join(dest, ".git", SYNC_CHECKOUT_MARK))).toBe(true);
      expect(await keptCopies(dest)).toEqual({});
    },
    T,
  );

  it(
    "an edit of theirs staged to a file the fetched commit changes: refused, nothing changed",
    async () => {
      const { root, r, dest, old, next } = await setUp();
      await killedInCheckout(dest, old, next);
      await writeFile(join(dest, "src", "Ledger.java"), "class Ledger { /* mine */ }\n");
      realGit(dest, "add", "--", "src/Ledger.java");
      const [res] = await createWorkspace(root).sync([r]);
      expect(res!.action).toBe("failed");
      expect(res!.reason).toMatch(/Nothing was changed/);
      expect(res!.reason).toContain("src/Ledger.java");
      expect(await readFile(join(dest, "src", "Ledger.java"), "utf8")).toBe(
        "class Ledger { /* mine */ }\n",
      );
      expect(realGit(dest, "rev-parse", "HEAD")).toBe(old);
      // Unstaged as the reason says (the file kept), the next sync puts the clone back.
      realGit(dest, "restore", "--staged", "--", "src/Ledger.java");
      const [again] = await createWorkspace(root).sync([r]);
      expect(again!.action).toBe("updated");
      expect(await keptCopies(dest)).toEqual({
        "src/Ledger.java": "class Ledger { /* mine */ }\n",
        "src/Limits.java": "class Lim",
      });
    },
    T,
  );

  it(
    "a checkout genuinely killed half-way still puts back, the half-written files kept as copies",
    async () => {
      const { root, r, dest, old, next } = await setUp();
      const { stop, inCheckout, done } = startStopped(root, dest, r);
      await inCheckout;
      stop.abort();
      const [res] = await done;
      expect(res!.action).toBe("stopped");
      expect(res!.reason).toMatch(/back as it was/);
      expect(realGit(dest, "rev-parse", "HEAD")).toBe(old);
      expect(realGit(dest, "status", "--porcelain")).toBe("");
      expect(existsSync(join(dest, ".git", SYNC_CHECKOUT_MARK))).toBe(false);
      expect(await keptCopies(dest)).toEqual({
        "src/Ledger.java": "class Ledger { int lim",
        "src/Limits.java": "class Lim",
      });
      expect(res!.reason).toMatch(/your version of src\/Ledger\.java was kept at /);
      expect(res!.kept?.map((k) => k.path).sort()).toEqual(["src/Ledger.java", "src/Limits.java"]);
      const [again] = await createWorkspace(root).sync([r]);
      expect(again!.action).toBe("updated");
      expect(again!.sha).toBe(next);
    },
    T,
  );
});

/** What a checkout killed part-way leaves: these files written (index too, if asked), the mark. */
async function killedWith(dest: string, old: string, next: string, files: Files, index = false) {
  realGit(dest, "fetch", "-q", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main");
  for (const [p, t] of Object.entries(files)) {
    await rm(join(dest, p), { recursive: true, force: true });
    if (t === null) continue;
    await mkdir(dirname(join(dest, p)), { recursive: true });
    await writeFile(join(dest, p), t);
  }
  if (index) realGit(dest, "read-tree", next);
  await writeFile(
    join(dest, ".git", SYNC_CHECKOUT_MARK),
    JSON.stringify({ head: old, target: next, branch: "main" }),
  );
}

/**
 * Beta.27 re-review (plumbing, round 2): a folder the fetched commit made a file (or a file it
 * made a folder) stuck the put-back: `rm --cached conf` met conf/app.yml still in the index
 * ("not removing recursively"). What the fetched commit added is taken out first, by its exact
 * index entry, and only then is what it changed put back.
 */
describe("a folder and a file swapped by the fetched commit (real git)", () => {
  const cases: [string, Tree, Tree, Files][] = [
    [
      "a folder that became a file",
      { "pom.xml": "<project/>\n", "conf/app.yml": "port: 1\n" },
      { conf: "port=1\n" },
      { conf: "port=" },
    ],
    [
      "a file that became a folder",
      { "pom.xml": "<project/>\n", conf: "port=1\n" },
      { conf: null, "conf/app.yml": "port: 1\n" },
      { conf: null, "conf/app.yml": "por" },
    ],
  ];
  for (const [what, first, second, killed] of cases)
    for (const index of [false, true])
      it(
        `${what}, killed ${index ? "after" : "before"} git wrote its index`,
        async () => {
          const { root, r, dest, old, next } = await setUp(first, second);
          await killedWith(dest, old, next, killed, index);
          const [res] = await createWorkspace(root).sync([r]);
          expect(res!.action).toBe("updated");
          expect(res!.sha).toBe(next);
          expect(realGit(dest, "status", "--porcelain", "--untracked-files=all")).toBe("");
          expect(existsSync(join(dest, ".git", SYNC_CHECKOUT_MARK))).toBe(false);
        },
        T,
      );

  // Beta.27 re-review (plumbing, round 3): on a file system without case (Windows, macOS) status
  // lists the one file twice (D README.md, AM readme.md), and its second copy failed (EEXIST),
  // so the mark stayed for ever, a copy folder left a sync. One copy a file, named after the
  // path the index has. Where the file system has case (Linux) core.ignorecase is git told
  // otherwise, and the half-written readme.md, hidden from status, is kept too.
  for (const index of [false, true])
    it(
      `a case-only rename with core.ignorecase, killed ${index ? "after" : "before"} git wrote its index`,
      async () => {
        const { root, r, dest, old, next } = await setUp(
          { "README.md": "# Ledger\n" },
          { "README.md": null, "readme.md": "# Ledger\n\nNew.\n" },
        );
        realGit(dest, "config", "core.ignorecase", "true");
        // The commit's own bytes are checked below: Git for Windows (and CI runners) set
        // core.autocrlf, which would check the file out with CRLF line ends.
        realGit(dest, "config", "core.autocrlf", "false");
        await killedWith(dest, old, next, { "README.md": null, "readme.md": "# Led" }, index);
        const [res] = await createWorkspace(root).sync([r]);
        expect(res!.action).toBe("updated");
        // Without case and before the index was written, the index names it README.md.
        const named = IGNORES_CASE && !index ? "README.md" : "readme.md";
        expect(res!.kept?.map((k) => k.path)).toEqual([named]);
        expect(await keptCopies(dest)).toEqual({ [named]: "# Led" });
        expect(await readdir(join(dest, ".git", "atticus-put-back"))).toHaveLength(1);
        expect(res!.sha).toBe(next);
        expect(realGit(dest, "status", "--porcelain", "--untracked-files=all")).toBe("");
        expect(realGit(dest, "ls-files")).toBe("readme.md");
        expect(await readFile(join(dest, "readme.md"), "utf8")).toBe("# Ledger\n\nNew.\n");
      },
      T,
    );

  // Two names for one file, as on a file system without case, made where it has case (a hard
  // link): copied once, under the name the index has.
  it.skipIf(IGNORES_CASE)(
    "a case-only rename whose two names are one file: one copy, named as the index has it",
    async () => {
      const { root, r, dest, old, next } = await setUp(
        { "README.md": "# Ledger\n" },
        { "README.md": null, "readme.md": "# Ledger\n\nNew.\n" },
      );
      realGit(dest, "config", "core.ignorecase", "true");
      await killedWith(dest, old, next, { "README.md": null, "readme.md": "# Led" }, true);
      await link(join(dest, "readme.md"), join(dest, "README.md"));
      const [res] = await createWorkspace(root).sync([r]);
      expect(res!.action).toBe("updated");
      expect(res!.kept?.map((k) => k.path)).toEqual(["readme.md"]);
      expect(await keptCopies(dest)).toEqual({ "readme.md": "# Led" });
      expect(realGit(dest, "status", "--porcelain", "--untracked-files=all")).toBe("");
      expect(existsSync(join(dest, ".git", SYNC_CHECKOUT_MARK))).toBe(false);
    },
    T,
  );
});

/**
 * Beta.27 re-review (plumbing, round 3): the put-back acted through a linked folder: the
 * emptied-folder cleanup removed an empty folder outside the clone, and a file reached through
 * the link was hashed, copied and called the person's. Nothing is done through a link.
 */
describe("a folder of the clone that is a link (real git)", () => {
  it.skipIf(process.platform === "win32")(
    "replaced by a folder: nothing outside the clone is removed, copied or called yours",
    async () => {
      const outside = await mkdtemp(join(tmpdir(), "atticus-sync-stop-outside-"));
      made.push(outside);
      await mkdir(join(outside, "b"));
      await mkdir(join(outside, "c"));
      await writeFile(join(outside, "c", "y"), "outside\n");
      const { root, r, dest, old, next } = await setUp(
        { "pom.xml": "<project/>\n", a: { link: outside } },
        { a: null, "a/b/x": "x\n", "a/c/y": "y\n" },
      );
      await killedWith(dest, old, next, {}, true);
      const [res] = await createWorkspace(root).sync([r]);
      expect(existsSync(join(outside, "b"))).toBe(true);
      expect(await readFile(join(outside, "c", "y"), "utf8")).toBe("outside\n");
      expect(res!.kept).toBeUndefined();
      expect(res!.reason ?? "").not.toMatch(/your version/);
      expect(await keptCopies(dest)).toEqual({});
      expect(res!.action).toBe("updated");
      expect(res!.sha).toBe(next);
      expect(realGit(dest, "status", "--porcelain", "--untracked-files=all")).toBe("");
    },
    T,
  );
});

/**
 * Beta.27 re-review (plumbing, round 3): a path that is a submodule in one commit and a file in
 * the other, a folder with files in it on disk (git doesn't look inside a submodule's folder):
 * putting the file back would delete the folder's files. Refused, nothing changed.
 */
describe("a submodule in one commit and a file in the other (real git)", () => {
  it(
    "a folder with files in it there: refused, nothing changed",
    async () => {
      const { root, r, dest, old, next } = await setUp(
        { "pom.xml": "<project/>\n", sub: "a file\n" },
        { sub: { gitlink: "1".repeat(40) } },
      );
      await killedWith(dest, old, next, { sub: null, "sub/mine.txt": "mine\n" }, true);
      const [res] = await createWorkspace(root).sync([r]);
      expect(res!.action).toBe("failed");
      expect(res!.reason).toMatch(/Nothing was changed/);
      expect(res!.reason).toContain("sub");
      expect(res!.reason).toContain(SYNC_CHECKOUT_MARK);
      expect(await readFile(join(dest, "sub", "mine.txt"), "utf8")).toBe("mine\n");
      expect(realGit(dest, "rev-parse", "HEAD")).toBe(old);
      expect(existsSync(join(dest, ".git", SYNC_CHECKOUT_MARK))).toBe(true);
    },
    T,
  );

  // Beta.27 re-review 5: a link (mode 120000) in one commit and a submodule in the other. The
  // link a stopped checkout leaves there is git's own (its text is one commit's blob): the clone
  // is put back, never refused as a person's link. A link of a person's there is still refused.
  const LINKED = "../shared/forge-common";
  const swaps: [string, Tree, Tree][] = [
    [
      "a link that became a submodule",
      { "pom.xml": "<project/>\n", sub: { link: LINKED } },
      { sub: { gitlink: "1".repeat(40) } },
    ],
    [
      "a submodule that became a link",
      { "pom.xml": "<project/>\n", sub: { gitlink: "1".repeat(40) } },
      { sub: { link: LINKED } },
    ],
  ];
  for (const [what, first, second] of swaps)
    for (const index of [false, true])
      it.skipIf(process.platform === "win32")(
        `${what}, git's own link left there, killed ${index ? "after" : "before"} git wrote its index`,
        async () => {
          const { root, r, dest, old, next } = await setUp(first, second);
          await killedWith(dest, old, next, {}, index);
          // git's checkout had written the link (or not yet taken it away)
          await rm(join(dest, "sub"), { recursive: true, force: true });
          await symlink(LINKED, join(dest, "sub"));
          const [res] = await createWorkspace(root).sync([r]);
          expect(res!.reason ?? "").not.toMatch(/is a link/);
          expect(res!.action).toBe("updated");
          expect(res!.sha).toBe(next);
          expect(res!.kept).toBeUndefined();
          expect(realGit(dest, "status", "--porcelain", "--untracked-files=all")).toBe("");
          expect(existsSync(join(dest, ".git", SYNC_CHECKOUT_MARK))).toBe(false);
        },
        T,
      );

  it.skipIf(process.platform === "win32")(
    "a link of a person's there (neither commit's): refused, nothing changed",
    async () => {
      const { root, r, dest, old, next } = await setUp(swaps[0]![1], swaps[0]![2]);
      await killedWith(dest, old, next, {}, true);
      await rm(join(dest, "sub"), { recursive: true, force: true });
      const outside = await mkdtemp(join(tmpdir(), "atticus-sync-stop-outside-"));
      made.push(outside);
      await writeFile(join(outside, "mine.txt"), "mine\n");
      await symlink(outside, join(dest, "sub"));
      const [res] = await createWorkspace(root).sync([r]);
      expect(res!.action).toBe("failed");
      expect(res!.reason).toMatch(/sub is a link/);
      expect(res!.reason).toMatch(/Nothing was changed/);
      expect((await lstat(join(dest, "sub"))).isSymbolicLink()).toBe(true);
      expect(await readFile(join(outside, "mine.txt"), "utf8")).toBe("mine\n");
      expect(realGit(dest, "rev-parse", "HEAD")).toBe(old);
      expect(existsSync(join(dest, ".git", SYNC_CHECKOUT_MARK))).toBe(true);
    },
    T,
  );

  // Beta.27 re-review 6: a file (100644) in one commit whose bytes are a link's text: git
  // never wrote a link there, so a link with that text is a person's.
  it.skipIf(process.platform === "win32")(
    "a link whose text is a file's bytes, where that commit has a file: refused, nothing changed",
    async () => {
      const { root, r, dest, old, next } = await setUp(
        { "pom.xml": "<project/>\n", sub: LINKED },
        { sub: { gitlink: "1".repeat(40) } },
      );
      await killedWith(dest, old, next, {}, true);
      await rm(join(dest, "sub"), { recursive: true, force: true });
      await symlink(LINKED, join(dest, "sub"));
      const [res] = await createWorkspace(root).sync([r]);
      expect(res!.action).toBe("failed");
      expect(res!.reason).toMatch(/sub is a link/);
      expect((await lstat(join(dest, "sub"))).isSymbolicLink()).toBe(true);
      expect(realGit(dest, "rev-parse", "HEAD")).toBe(old);
      expect(existsSync(join(dest, ".git", SYNC_CHECKOUT_MARK))).toBe(true);
    },
    T,
  );
});

// Beta.27 re-review 6: Git for Windows (core.symlinks=true) writes a link's target with `\`, so
// readlink's `..\shared\forge-common` is the blob `../shared/forge-common`; and only a path whose
// mode in that commit is 120000 is a link of git's, never a file whose bytes are the link's text.
describe("linkTextIsBlob: whether a link's text is git's own", () => {
  const BLOB = "../shared/forge-common";
  it("reads `\\` as `/` on Windows only", () => {
    expect(linkTextIsBlob("..\\shared\\forge-common", "120000", BLOB, "win32")).toBe(true);
    expect(linkTextIsBlob("../shared/forge-common", "120000", BLOB, "win32")).toBe(true);
    expect(linkTextIsBlob("..\\shared/forge-common", "120000", BLOB, "win32")).toBe(true);
    expect(linkTextIsBlob("..\\shared\\northwind-pay", "120000", BLOB, "win32")).toBe(false);
    // elsewhere a `\` is a character of the name like any other
    expect(linkTextIsBlob("..\\shared\\forge-common", "120000", BLOB, "linux")).toBe(false);
    expect(linkTextIsBlob(BLOB, "120000", BLOB, "linux")).toBe(true);
    expect(linkTextIsBlob(BLOB, "120000", BLOB, "darwin")).toBe(true);
  });
  it("takes a link as git's own only where that commit's mode for it is 120000", () => {
    for (const platform of ["linux", "win32"] as const) {
      expect(linkTextIsBlob(BLOB, "100644", BLOB, platform)).toBe(false);
      expect(linkTextIsBlob(BLOB, "100755", BLOB, platform)).toBe(false);
      expect(linkTextIsBlob(BLOB, "160000", BLOB, platform)).toBe(false);
      expect(linkTextIsBlob(BLOB, "120000", BLOB, platform)).toBe(true);
    }
  });
});

/**
 * Beta.27 re-review (plumbing, round 3): the emptied-folder cleanup takes only folders on the
 * way to a path the fetched commit added that the commit the clone was on hasn't got; it stops
 * at the first folder that commit has. An empty folder of a person's elsewhere stays.
 */
describe("the folders a stopped checkout left empty (real git)", () => {
  it(
    "only those the fetched commit made: never one the clone's commit has, nor one of a person's elsewhere",
    async () => {
      const { root, r, dest, old, next } = await setUp(
        { "pom.xml": "<project/>\n", "keep/x.txt": "x\n" },
        { "keep/x.txt": null, "keep/sub/z.txt": "z\n", "new/deep/f.txt": "f\n" },
      );
      await killedWith(dest, old, next, {
        "keep/x.txt": null,
        "keep/sub/z.txt": "z",
        "new/deep/f.txt": "f",
      });
      await mkdir(join(dest, "mine"));
      await mkdir(join(dest, "new", "mine"));
      // Whether keep/ (the clone's commit has it) is there when the put-back checks it out.
      const real = createGit();
      let keepThere: boolean | undefined;
      const git: GitRunner = async (args, cwd, o) => {
        if (args[0] === "checkout" && args.includes(old) && keepThere === undefined)
          keepThere =
            (await lstat(join(dest, "keep")).catch(() => undefined))?.isDirectory() ?? false;
        return real(args, cwd, o);
      };
      const [res] = await createWorkspace(root, git).sync([r]);
      expect(res!.action).toBe("updated");
      expect(keepThere).toBe(true);
      expect(existsSync(join(dest, "mine"))).toBe(true);
      expect(existsSync(join(dest, "new", "mine"))).toBe(true);
      expect(realGit(dest, "status", "--porcelain", "--untracked-files=all")).toBe("");
    },
    T,
  );
});

/**
 * Beta.27 re-review (plumbing, round 2): origin/<branch> fetched again since (checkoutBranch
 * fetches it, so does a person's own git fetch) read a sync's mark as not one. The commit it
 * fetched is honoured while the clone has it and it is in origin/<branch>'s history or reflog.
 */
describe("a mark whose fetched commit origin has moved past since (real git)", () => {
  it(
    "fetched again after more was pushed: honoured",
    async () => {
      const { root, r, dest, old, next, work, commit } = await setUp();
      await killedInCheckout(dest, old, next);
      await commit({ "src/Later.java": "class Later {}\n" });
      realGit(work, "push", "-q", "origin", "main");
      const latest = realGit(work, "rev-parse", "HEAD");
      realGit(dest, "fetch", "-q", "origin");
      const [res] = await createWorkspace(root).sync([r]);
      expect(res!.action).toBe("updated");
      expect(res!.sha).toBe(latest);
      expect(realGit(dest, "status", "--porcelain")).toBe("");
    },
    T,
  );

  it(
    "fetched again after a force-push (the commit only in origin's reflog): honoured",
    async () => {
      const { root, r, dest, old, next, work, commit } = await setUp();
      await killedInCheckout(dest, old, next);
      realGit(work, "reset", "-q", "--hard", old);
      await commit({ "src/Other.java": "class Other {}\n" });
      realGit(work, "push", "-q", "--force", "origin", "main");
      const rewritten = realGit(work, "rev-parse", "HEAD");
      realGit(dest, "fetch", "-q", "origin");
      expect(realGit(dest, "rev-parse", "refs/remotes/origin/main")).toBe(rewritten);
      const [res] = await createWorkspace(root).sync([r]);
      expect(res!.action).toBe("updated");
      expect(res!.sha).toBe(rewritten);
      expect(realGit(dest, "status", "--porcelain")).toBe("");
    },
    T,
  );

  it(
    "a commit the clone has that origin's branch never had: refused",
    async () => {
      const { root, r, dest, old, next } = await setUp();
      await killedInCheckout(dest, old, next);
      const tree = realGit(dest, "rev-parse", `${next}^{tree}`);
      const stray = realGit(dest, "commit-tree", tree, "-p", old, "-m", "stray");
      await writeFile(
        join(dest, ".git", SYNC_CHECKOUT_MARK),
        JSON.stringify({ head: old, target: stray, branch: "main" }),
      );
      const [res] = await createWorkspace(root).sync([r]);
      expect(res!.action).toBe("failed");
      expect(res!.reason).toMatch(/isn't one a sync writes/);
      await untouched(dest, old);
    },
    T,
  );
});

describe("a stop's words say what happened (real git)", () => {
  it(
    "stopped after the checkout was done and its mark gone: it says the clone was updated",
    async () => {
      const { root, r, dest, next } = await setUp();
      const real = createGit();
      const stop = new AbortController();
      let checkedOut = false;
      let markThere: boolean | undefined;
      const git: GitRunner = async (args, cwd, o) => {
        if (args[0] === "checkout" && o?.signal) checkedOut = true;
        if (checkedOut && o?.signal && args[0] === "rev-parse" && args[1] === "HEAD") {
          markThere = existsSync(join(dest, ".git", SYNC_CHECKOUT_MARK));
          stop.abort();
          throw new GitStoppedError(args);
        }
        return real(args, cwd, o);
      };
      const [res] = await createWorkspace(root, git, { signal: stop.signal }).sync([r]);
      expect(markThere).toBe(false);
      expect(res!.action).toBe("stopped");
      expect(res!.reason).toMatch(/was updated/);
      expect(res!.reason).not.toMatch(/as it was before/);
      expect(res!.sha).toBe(next);
      expect(realGit(dest, "rev-parse", "HEAD")).toBe(next);
      expect(realGit(dest, "status", "--porcelain")).toBe("");
    },
    T,
  );

  it(
    "the branch at the fetched commit, no reflog to show the sync moved it: refused, in words that claim nothing",
    async () => {
      const { root, r, dest, old, next } = await setUp();
      await killedInCheckout(dest, old, next);
      realGit(dest, "config", "core.logAllRefUpdates", "false");
      await rm(join(dest, ".git", "logs"), { recursive: true, force: true });
      realGit(dest, "checkout", "-q", "--force", "-B", "main", "refs/remotes/origin/main");
      const [res] = await createWorkspace(root).sync([r]);
      expect(res!.action).toBe("failed");
      expect(res!.reason).toMatch(/Nothing was changed/);
      expect(res!.reason).toMatch(/this clone's history can't show the sync left it/);
      expect(res!.reason).not.toMatch(/To keep it/);
      expect(res!.reason).toContain(`update-ref refs/heads/main ${old} ${next}`);
      expect(realGit(dest, "rev-parse", "HEAD")).toBe(next);
      expect(existsSync(join(dest, ".git", SYNC_CHECKOUT_MARK))).toBe(true);
      // Done as it says, the next sync puts the clone back and updates it.
      realGit(dest, "update-ref", "refs/heads/main", old, next);
      const [again] = await createWorkspace(root).sync([r]);
      expect(again!.action).toBe("updated");
      expect(again!.sha).toBe(next);
      expect(realGit(dest, "status", "--porcelain")).toBe("");
    },
    T,
  );
});
