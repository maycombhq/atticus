import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitHandoffPublisher } from "../src/index.js";

/**
 * Review round 48 (tasks and Git host): publishing a hand-off never moves the person's own local
 * hand-off branch from under them: not one checked out, not one with commits of their own.
 */

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};
const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", a, { cwd, env: ENV, encoding: "utf8" }).trim();
const B = "handoff/c1/build";
const YES = { by: "p", at: "2026-11-08T00:00:00Z", ref: "x" };

async function metarepo() {
  const t = await mkdtemp(join(tmpdir(), "atticus-pub-"));
  const bare = join(t, "meta.git");
  await mkdir(bare);
  git(bare, "init", "-q", "--bare", "-b", "main");
  const root = join(t, "meta");
  await mkdir(root);
  git(root, "init", "-q", "-b", "main");
  await writeFile(join(root, "a.txt"), "1\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "start");
  git(root, "remote", "add", "origin", bare);
  git(root, "push", "-q", "origin", "main");
  return { root, bare };
}

const publish = (root: string) =>
  gitHandoffPublisher({ env: ENV }).publish({
    root,
    branch: B,
    base: "main",
    files: ["a.txt"],
    message: "hand-off",
    approval: YES,
  });

describe("the local hand-off branch when publishing (review round 48)", () => {
  it("leaves a checked-out hand-off branch with the person's unpushed commit as it is", async () => {
    const { root, bare } = await metarepo();
    git(root, "checkout", "-q", "-b", B);
    await writeFile(join(root, "mine.txt"), "person's unpushed fix\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "person's fix");
    const mine = git(root, "rev-parse", "HEAD");
    await writeFile(join(root, "a.txt"), "2\n");
    const { commit } = await publish(root);
    expect(git(bare, "rev-parse", B)).toBe(commit);
    expect(git(root, "rev-parse", B)).toBe(mine);
    expect(git(root, "rev-parse", "HEAD")).toBe(mine);
    expect(git(root, "status", "--porcelain")).toBe("M a.txt");
  });

  it("leaves a branch with commits of its own that isn't checked out, and moves one that's behind", async () => {
    const { root, bare } = await metarepo();
    git(root, "branch", B);
    git(root, "checkout", "-q", B);
    await writeFile(join(root, "mine.txt"), "mine\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "mine");
    const mine = git(root, "rev-parse", "HEAD");
    git(root, "checkout", "-q", "main");
    await writeFile(join(root, "a.txt"), "2\n");
    const first = await publish(root);
    expect(git(root, "rev-parse", B)).toBe(mine);
    expect(git(bare, "rev-parse", B)).toBe(first.commit);

    // A branch with nothing of its own beyond where the publish started follows the commit.
    git(root, "branch", "-f", B, first.commit);
    await writeFile(join(root, "a.txt"), "3\n");
    const second = await publish(root);
    expect(second.changed).toBe(true);
    expect(git(root, "rev-parse", B)).toBe(second.commit);
    expect(git(bare, "rev-parse", B)).toBe(second.commit);
    // Nothing new: the remote's branch is where it was.
    const third = await publish(root);
    expect(third).toEqual({ commit: second.commit, changed: false });
  });

  it("makes the local branch when there is none", async () => {
    const { root } = await metarepo();
    await writeFile(join(root, "a.txt"), "2\n");
    const { commit } = await publish(root);
    expect(git(root, "rev-parse", B)).toBe(commit);
    expect(git(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });
});
