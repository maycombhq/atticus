import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { checkoutsStamp } from "../src/ui-api-trust.js";

/**
 * beta.23, Windows: Map › Trust and each change's cockpit are kept until a checkout moves. The
 * stamp read folders' times, which git moves as it reads (index.lock), so on Windows every Home
 * load worked them out again. It moves on a commit or a checkout, not on a read.
 */
const g = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], {
    cwd,
    encoding: "utf8",
  });
let dir = "";
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function adopted() {
  dir = await mkdtemp(join(tmpdir(), "atticus-stamp-"));
  // A repo adopted in place: its own checkout is the one read.
  await mkdir(join(dir, ".atticus", "org-pack"), { recursive: true });
  g(dir, "init", "-q", "-b", "main");
  await writeFile(join(dir, "a.txt"), "1\n");
  g(dir, "add", "-A");
  g(dir, "commit", "-q", "-m", "one");
  return dir;
}

it("stays the same while git only reads, its lock files coming and going", async () => {
  const root = await adopted();
  const before = await checkoutsStamp(root);
  await writeFile(join(root, ".git", "index.lock"), "");
  await rm(join(root, ".git", "index.lock"));
  g(root, "status", "--porcelain");
  g(root, "rev-parse", "HEAD");
  g(root, "log", "-1", "--format=%H");
  expect(await checkoutsStamp(root)).toBe(before);
});

it("moves on a commit", async () => {
  const root = await adopted();
  const before = await checkoutsStamp(root);
  await writeFile(join(root, "a.txt"), "2\n");
  g(root, "commit", "-q", "-am", "two");
  expect(await checkoutsStamp(root)).not.toBe(before);
});

it("moves on a checkout of another branch at the same commit", async () => {
  const root = await adopted();
  const before = await checkoutsStamp(root);
  g(root, "checkout", "-q", "-b", "other");
  expect(await checkoutsStamp(root)).not.toBe(before);
});

/**
 * The cockpit reads a change's task and change branches (`task/<id>/<task>`, `change/<id>`),
 * committed to in worktrees of the clone, never its checked-out branch: their refs, each
 * worktree's HEAD and reflog, and the host's as last fetched are stamped too.
 */
async function withWorktree() {
  const root = await adopted();
  g(root, "branch", "change/add-limit");
  const wt = join(dir, ".wt");
  g(root, "worktree", "add", "-q", "-b", "task/add-limit/1.1", wt, "change/add-limit");
  return { root, wt };
}

it("moves on a commit to a task branch in a worktree of the clone", async () => {
  const { root, wt } = await withWorktree();
  const before = await checkoutsStamp(root);
  await writeFile(join(wt, "b.txt"), "1\n");
  g(wt, "add", "-A");
  g(wt, "commit", "-q", "-m", "task work");
  expect(await checkoutsStamp(root)).not.toBe(before);
});

it("moves when a change branch moves, though nothing has it checked out", async () => {
  const { root } = await withWorktree();
  const before = await checkoutsStamp(root);
  await writeFile(join(root, "a.txt"), "3\n");
  g(root, "commit", "-q", "-am", "three");
  const mid = await checkoutsStamp(root);
  g(root, "branch", "-f", "change/add-limit", "HEAD");
  expect(mid).not.toBe(before);
  expect(await checkoutsStamp(root)).not.toBe(mid);
});

it("moves when a fetch moves the host's change branch as last fetched", async () => {
  const { root } = await withWorktree();
  g(root, "update-ref", "refs/remotes/origin/change/add-limit", "HEAD~0");
  const before = await checkoutsStamp(root);
  await writeFile(join(root, "a.txt"), "4\n");
  g(root, "commit", "-q", "-am", "four");
  const mid = await checkoutsStamp(root);
  g(root, "update-ref", "refs/remotes/origin/change/add-limit", "HEAD");
  expect(await checkoutsStamp(root)).not.toBe(mid);
  expect(mid).not.toBe(before);
});

it("stays the same while git only reads in a worktree", async () => {
  const { root, wt } = await withWorktree();
  const before = await checkoutsStamp(root);
  g(wt, "status", "--porcelain");
  g(wt, "log", "-1", "--format=%H");
  g(root, "for-each-ref", "refs/heads/task/");
  expect(await checkoutsStamp(root)).toBe(before);
});
