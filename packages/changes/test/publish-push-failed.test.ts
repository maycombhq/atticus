import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitHandoffPublisher, handoffBranchPushed, pushHandoffBranch } from "../src/index.js";

/**
 * App-only audit (hand-off): a push that fails (a hook, the proxy, the host) keeps the hand-off's
 * commit on its branch here, so "push it yourself" names a branch that exists, and Push again
 * sends it, never forced.
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
const B = "handoff/c1/plan";
const YES = { by: "p", at: "2026-11-09T00:00:00Z", ref: "x" };

async function metarepo() {
  const t = await mkdtemp(join(tmpdir(), "atticus-pub-fail-"));
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
  // The host refuses every push from now on.
  const hook = join(bare, "hooks", "pre-receive");
  await writeFile(hook, "#!/bin/sh\necho 'refused by the host' >&2\nexit 1\n");
  await chmod(hook, 0o755);
  return { root, bare, hook };
}

describe("a hand-off branch whose push failed (app-only audit)", () => {
  it("is kept here at the hand-off's commit, said unpushed, and pushed again on the person's yes", async () => {
    const { root, bare, hook } = await metarepo();
    await writeFile(join(root, "a.txt"), "2\n");
    await expect(
      gitHandoffPublisher({ env: ENV }).publish({
        root,
        branch: B,
        base: "main",
        files: ["a.txt"],
        message: "hand-off",
        approval: YES,
      }),
    ).rejects.toThrow(/refused by the host|push/);
    const here = git(root, "rev-parse", B);
    expect(here).toMatch(/^[0-9a-f]{40}$/);
    expect(git(root, "show", `${B}:a.txt`)).toBe("2");
    expect(await handoffBranchPushed(root, B)).toBe(false);
    // Still refused: said with git's words, and the branch stays.
    await expect(pushHandoffBranch(root, B, { approval: YES, env: ENV })).rejects.toThrow(
      /push failed|declined/,
    );
    await writeFile(hook, "#!/bin/sh\nexit 0\n");
    const r = await pushHandoffBranch(root, B, { approval: YES, env: ENV });
    expect(r.commit).toBe(here);
    expect(git(bare, "rev-parse", B)).toBe(here);
    expect(await handoffBranchPushed(root, B)).toBe(true);
    // Without the person's yes, nothing is pushed.
    await expect(
      pushHandoffBranch(root, B, { approval: undefined as never, env: ENV }),
    ).rejects.toThrow();
  });
});
