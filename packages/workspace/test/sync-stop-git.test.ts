import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

async function setUp() {
  const dir = await mkdtemp(join(tmpdir(), "atticus-sync-stop-git-"));
  made.push(dir);
  const root = join(dir, "metarepo");
  await mkdir(root);
  realGit(root, "init", "-q");
  const work = join(dir, "src", "forge-ledger");
  await mkdir(join(work, "src"), { recursive: true });
  realGit(work, "init", "-q", "-b", "main");
  const commit = async (files: Record<string, string>) => {
    for (const [p, t] of Object.entries(files)) await writeFile(join(work, p), t);
    realGit(work, "add", "-A");
    realGit(work, "commit", "-q", "-m", "update");
  };
  await commit({ "pom.xml": "<project/>\n", "src/Ledger.java": "class Ledger {}\n" });
  const url = join(dir, "remotes", "forge-ledger.git");
  realGit(dir, "clone", "-q", "--bare", work, url);
  realGit(work, "remote", "add", "origin", url);
  const r = ManifestRepo.parse({ id: "forge-ledger", url, type: "service", owner: "team" });
  const [first] = await createWorkspace(root).sync([r]);
  expect(first!.action).toBe("cloned");
  const dest = baseClonePath(root, "forge-ledger");
  const old = realGit(dest, "rev-parse", "HEAD");
  await commit({
    "src/Ledger.java": "class Ledger { int limit; }\n",
    "src/Limits.java": "class Limits {}\n",
  });
  realGit(work, "push", "-q", "origin", "main");
  const next = realGit(work, "rev-parse", "HEAD");
  return { root, r, dest, old, next };
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
      expect(res!.reason).toBeUndefined();
      expect(res!.action).toBe("updated");
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
