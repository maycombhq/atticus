import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { catchUpChangeBranch, SpecKitError } from "../src/index.js";
import { git } from "./helpers.js";

/**
 * Final review (git and tasks): catching the change branch up with the Git host's moves
 * change/<id> only. A person who switched the change worktree to a branch of their own keeps
 * that branch as it is.
 */

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};
const g = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "init.defaultBranch=main", ...a], {
    cwd,
    encoding: "utf8",
    env: ENV,
  }).trim();

const made: string[] = [];
afterEach(async () => {
  for (const d of made.splice(0)) await rm(d, { recursive: true, force: true });
});

/**
 * A base clone of forge-web with change/c1 in its change worktree, a local bare "remote", and
 * a second clone standing for the Git host's side. `handDown` adds a local hand-down commit
 * whose files the host's branch then carries (a squash-merged task PR); otherwise the local
 * branch is simply behind the host's.
 */
async function setup(o: { handDown: boolean }) {
  const base = await mkdtemp(join(tmpdir(), "atticus-catch-up-"));
  made.push(base);
  const root = join(base, "meta");
  const bare = join(base, "forge-web.git");
  const other = join(base, "other");
  await mkdir(root);
  g(base, "init", "-q", "--bare", "-b", "main", bare);
  g(base, "clone", "-q", bare, other);
  await writeFile(join(other, "a.txt"), "a\n");
  g(other, "add", "-A");
  g(other, "commit", "-q", "-m", "a");
  g(other, "push", "-q", "origin", "HEAD:main");
  const clone = join(root, "workspace", "forge-web");
  g(base, "clone", "-q", bare, clone);
  const wt = join(root, "workspace/.worktrees/c1/forge-web");
  g(clone, "worktree", "add", "-q", "-b", "change/c1", wt, "origin/main");
  g(other, "checkout", "-q", "-b", "change/c1", "origin/main");
  if (o.handDown) {
    await mkdir(join(wt, "specs/t1"), { recursive: true });
    await writeFile(join(wt, "specs/t1/plan.md"), "plan\n");
    g(wt, "add", "-A");
    g(
      wt,
      "commit",
      "-q",
      "-m",
      "Hand down task t1 of c1: x",
      "-m",
      "Atticus-Change: c1\nAtticus-Task: t1",
    );
    await mkdir(join(other, "specs/t1"), { recursive: true });
    await writeFile(join(other, "specs/t1/plan.md"), "plan\n");
  }
  await writeFile(join(other, "code.txt"), "task\n");
  g(other, "add", "-A");
  g(other, "commit", "-q", "-m", "task t1 (squash)");
  g(other, "push", "-q", "origin", "change/c1");
  return { root, clone, wt, hostTip: g(other, "rev-parse", "HEAD") };
}

async function spike(wt: string) {
  g(wt, "checkout", "-q", "-b", "my-spike");
  await writeFile(join(wt, "spike.txt"), "my spike\n");
  g(wt, "add", "-A");
  g(wt, "commit", "-q", "-m", "my spike work");
  return g(wt, "rev-parse", "my-spike");
}

describe("catching the change branch up when the person switched its worktree", () => {
  for (const handDown of [true, false])
    it(`leaves the person's own branch as it is and moves change/c1 alone (${handDown ? "local hand-down commits" : "behind the host's"})`, async () => {
      const { root, clone, wt, hostTip } = await setup({ handDown });
      const mine = await spike(wt);
      const note = await catchUpChangeBranch(root, "c1", "t2", "forge-web", wt, git);
      expect(note).toMatch(/^Brought change\/c1 in forge-web up to the Git host's first/);
      expect(g(wt, "rev-parse", "my-spike")).toBe(mine);
      expect(g(wt, "symbolic-ref", "HEAD")).toBe("refs/heads/my-spike");
      expect(g(wt, "log", "-1", "--format=%s")).toBe("my spike work");
      expect(g(wt, "status", "--porcelain")).toBe("");
      expect(g(clone, "rev-parse", "refs/heads/change/c1")).toBe(hostTip);
    });

  it("refuses when change/c1 is checked out in another worktree, and moves nothing", async () => {
    const { root, clone, wt } = await setup({ handDown: true });
    const mine = await spike(wt);
    const elsewhere = join(root, "workspace/.elsewhere");
    made.push(elsewhere);
    g(clone, "worktree", "add", "-q", elsewhere, "change/c1");
    const local = g(clone, "rev-parse", "refs/heads/change/c1");
    const err = await catchUpChangeBranch(root, "c1", "t2", "forge-web", wt, git).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SpecKitError);
    expect((err as Error).message).toBe(
      "change/c1 in forge-web is behind the Git host's (tasks merged there), but the change worktree workspace/.worktrees/c1/forge-web has my-spike checked out, not change/c1, and change/c1 is checked out in another worktree: Atticus doesn't move a branch you're working on. Switch workspace/.worktrees/c1/forge-web back to change/c1 (commit your work on my-spike first), then run task t2 again.",
    );
    expect(g(wt, "rev-parse", "my-spike")).toBe(mine);
    expect(g(clone, "rev-parse", "refs/heads/change/c1")).toBe(local);
  });
});
