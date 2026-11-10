import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MockGitHost } from "@maycombhq/adapters";
import { writeChangeRepos, type GitRunner } from "@maycombhq/workspace";
import {
  changeReport,
  raiseReleasePrs,
  readTaskDecision,
  recordTaskDecision,
  releasePrReasons,
  unmergedTaskBranches,
} from "../src/index.js";
import { approval, forgeMetarepo } from "./helpers.js";

/**
 * App-only audit (tasks, release): a change can't be released with no code. A task branch with
 * commits the change branch hasn't (here or on the Git host) holds Build ready, go/no-go and the
 * release PRs, naming the task and what to do; a person's decision with a reason lets it go.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE_CHANGE = join(HERE, "../../../fixtures/forge-change");
const ID = "add-transfer-limit";
const BRANCH = `change/${ID}`;
const TASK = `task/${ID}/1.1`;
const NOW = "2026-11-09T10:00:00Z";
const YES = approval("tia", NOW, `${ID}#release-prs`);
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Tia",
  GIT_AUTHOR_EMAIL: "tia@example.com",
  GIT_COMMITTER_NAME: "Tia",
  GIT_COMMITTER_EMAIL: "tia@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();

async function setup(state: "build" | "qa") {
  const root = await forgeMetarepo();
  const dir0 = join(root, "openspec/changes", ID);
  await cp(join(FORGE_CHANGE, "openspec/changes", ID), dir0, { recursive: true });
  const p = join(dir0, "change.yaml");
  const path = ["plan", "build", "qa"].slice(0, state === "build" ? 2 : 3);
  const entries = path
    .slice(1)
    .map(
      (to, i) =>
        `  - from: ${path[i]}\n    to: ${to}\n    at: 2026-10-2${i}T10:00:00Z\n    by: tia\n    reason: Moved on for the test`,
    )
    .join("\n");
  const text = await readFile(p, "utf8");
  await writeFile(
    p,
    text
      .replace(/^state: plan$/m, `state: ${state}`)
      .replace(/( {4}reason: Approve design merged\n)/, `$1${entries}\n`),
  );
  const repo = "forge-ledger";
  const host = join(root, ".hosts", `${repo}.git`);
  await mkdir(host, { recursive: true });
  git(host, "init", "-q", "--bare", "-b", "main");
  const worktree = `workspace/.worktrees/${ID}/${repo}`;
  const dir = join(root, worktree);
  await mkdir(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  await writeFile(join(dir, "README.md"), "x\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "start");
  git(dir, "remote", "add", "origin", host);
  git(dir, "push", "-q", "origin", "main");
  const baseSha = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "-b", BRANCH);
  // The hand-down commit only: what the audit's release PR carried.
  await writeFile(join(dir, "TASKS.md"), "1.1\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "Hand down task 1.1");
  // Task 1.1 drafted and committed on its task branch, never pushed or merged.
  git(dir, "branch", TASK);
  git(dir, "checkout", "-q", TASK);
  await writeFile(join(dir, "Limit.java"), "class Limit {}\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "Limit (task 1.1)");
  git(dir, "checkout", "-q", BRANCH);
  await writeChangeRepos(root, {
    schemaVersion: 3,
    change: ID,
    repos: [
      { id: repo, branch: BRANCH, base: "main", baseSha, worktree, build: { status: "not-run" } },
    ],
  });
  const taskDir = join(dir0, "tasks", "1.1");
  await mkdir(taskDir, { recursive: true });
  await writeFile(
    join(taskDir, "task-run.yaml"),
    [
      "schemaVersion: 1",
      `change: ${ID}`,
      "task: '1.1'",
      `repo: ${repo}`,
      "level: draft",
      "runtime: hand-off",
      "engine: atticus",
      "by: tia",
      `branch: ${TASK}`,
      `worktree: workspace/.worktrees/${ID}/.tasks/1.1/${repo}`,
      "state: unverified",
      "startedAt: 2026-11-09T09:00:00Z",
      "",
    ].join("\n"),
  );
  return { root, dir, host };
}

describe("task branches not merged into the change branch (app-only audit)", () => {
  it("holds the release PRs, naming the task and what to do, and pushes nothing", async () => {
    const { root, host } = await setup("qa");
    const un = await unmergedTaskBranches(root, ID);
    expect(un).toMatchObject([{ task: "1.1", repo: "forge-ledger", branch: TASK, commits: 1 }]);
    const reasons = await releasePrReasons(root, ID);
    const mine = reasons.filter((r) => r.code === "task-not-merged");
    expect(mine).toHaveLength(1);
    expect(mine[0]!.message).toContain(`Task 1.1's branch ${TASK} in forge-ledger has 1 commit`);
    expect(mine[0]!.message).toContain("Build and raise PR");
    const gh = new MockGitHost([{ repo: "forge-ledger" }]);
    const r = await raiseReleasePrs(root, ID, { gitHost: gh, approval: YES, now: NOW });
    expect(r.rows[0]).toMatchObject({ repo: "forge-ledger", outcome: "refused" });
    expect(r.rows[0]!.message).toContain("task 1.1");
    expect(gh.journal.some((j) => j.method === "createPullRequest")).toBe(false);
    // The change branch wasn't pushed for a release that has no code.
    expect(git(host, "branch", "--list", BRANCH)).toBe("");
  }, 120_000);

  it("lets them go once the task's work is in the change branch, here or on the Git host", async () => {
    const { root, dir } = await setup("qa");
    // Merged on the Git host (the task PR merged there); the branch here is behind.
    git(dir, "push", "-q", "origin", `${TASK}:${BRANCH}`);
    expect(await unmergedTaskBranches(root, ID)).toEqual([]);
    const gh = new MockGitHost([{ repo: "forge-ledger" }]);
    const r = await raiseReleasePrs(root, ID, { gitHost: gh, approval: YES, now: NOW });
    expect(r.rows[0]).toMatchObject({ outcome: "raised" });
  }, 120_000);

  it("holds Build ready while the task's work isn't merged", async () => {
    const { root, dir } = await setup("build");
    const rep = await changeReport(root, ID);
    expect(rep.blockers.map((b) => b.code)).toContain("task-not-merged");
    git(dir, "merge", "-q", "--ff-only", TASK);
    const after = await changeReport(root, ID);
    expect(after.blockers.map((b) => b.code)).not.toContain("task-not-merged");
  }, 120_000);

  it("a person's decision with a reason lets the task go, until its branch moves on", async () => {
    const { root, dir } = await setup("qa");
    await expect(
      recordTaskDecision(root, ID, "1.1", { by: "tia", at: NOW, reason: "  " }),
    ).rejects.toThrow(/reason/);
    const d = await recordTaskDecision(root, ID, "1.1", {
      by: "tia",
      at: NOW,
      reason: "Its work went into task 1.2 instead.",
    });
    expect(d).toMatchObject({
      task: "1.1",
      by: "tia",
      reason: "Its work went into task 1.2 instead.",
    });
    expect(await readTaskDecision(root, ID, "1.1")).toMatchObject({ commit: d.commit });
    expect(await unmergedTaskBranches(root, ID)).toEqual([]);
    // More work on the task branch after the decision: held again.
    git(dir, "checkout", "-q", TASK);
    await writeFile(join(dir, "More.java"), "class More {}\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "more");
    git(dir, "checkout", "-q", BRANCH);
    expect((await unmergedTaskBranches(root, ID)).map((x) => x.commits)).toEqual([2]);
  }, 120_000);

  it("holds a task branch in a second repo, though the task's record names the first", async () => {
    // Branch names are the same in every repo: forge-wallet's task/<id>/1.1 is its own work.
    const root = await mkdtemp(join(tmpdir(), "atticus-tb-"));
    const mk = (id: string) => ({
      id,
      branch: BRANCH,
      base: "main",
      worktree: `workspace/.worktrees/${ID}/${id}`,
      build: { status: "not-run" as const },
    });
    for (const r of ["forge-ledger", "forge-wallet"])
      await mkdir(join(root, `workspace/.worktrees/${ID}/${r}`), { recursive: true });
    await writeChangeRepos(root, {
      schemaVersion: 3,
      change: ID,
      repos: [mk("forge-ledger"), mk("forge-wallet")],
    });
    const t = join(root, "openspec/changes", ID, "tasks", "1.1");
    await mkdir(t, { recursive: true });
    await writeFile(
      join(t, "task-run.yaml"),
      `task: "1.1"\nrepo: forge-ledger\nbranch: ${TASK}\nstate: pr-open\n`,
    );
    const runner = (async (args: string[]) => {
      if (args[0] === "for-each-ref") return { stdout: `refs/heads/${TASK}\n`, stderr: "" };
      if (args[0] === "rev-parse") return { stdout: `${"a".repeat(40)}\n`, stderr: "" };
      if (args[0] === "rev-list") return { stdout: "2\n", stderr: "" };
      return { stdout: "", stderr: "" };
    }) as unknown as GitRunner;
    const un = await unmergedTaskBranches(root, ID, { git: runner, offline: true });
    expect(un.map((u) => [u.repo, u.task, u.commits, u.state])).toEqual([
      ["forge-ledger", "1.1", 2, "pr-open"],
      ["forge-wallet", "1.1", 2, undefined],
    ]);
  });

  it("counts a commit on the task branch after its PR merged (ticked), not what merged", async () => {
    const { root, dir } = await setup("qa");
    const tip = git(dir, "rev-parse", TASK);
    // Squash-merged on the Git host: the change branch has the task's work, not its commit.
    git(dir, "merge", "-q", "--squash", TASK);
    git(dir, "commit", "-q", "-m", "Limit (task 1.1) (#7)");
    const run = join(root, "openspec/changes", ID, "tasks", "1.1", "task-run.yaml");
    await writeFile(
      run,
      (await readFile(run, "utf8"))
        .replace("state: unverified", "state: pr-open")
        .concat(`commit: ${tip}\nticked: 2026-11-09T09:30:00Z\n`),
    );
    expect(await unmergedTaskBranches(root, ID)).toEqual([]);
    // A fix pushed to the task branch after the merge never reached the change branch.
    git(dir, "checkout", "-q", TASK);
    await writeFile(join(dir, "Fix.java"), "class Fix {}\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "fix after merge");
    git(dir, "checkout", "-q", BRANCH);
    expect((await unmergedTaskBranches(root, ID)).map((x) => [x.task, x.commits, x.state])).toEqual(
      [["1.1", 1, "pr-open"]],
    );
  }, 120_000);
});

describe("a page load never reaches the Git host (assess reads refs here only)", () => {
  /** Every ls-remote or fetch from the host runs its upload-pack: this one leaves a mark. */
  const watchHost = async (dir: string) => {
    const bin = await mkdtemp(join(tmpdir(), "atticus-up-"));
    const mark = join(bin, "reached");
    const script = join(bin, "upload-pack.sh");
    await writeFile(script, `#!/bin/sh\necho x >> "${mark}"\nexec git-upload-pack "$@"\n`);
    await chmod(script, 0o755);
    git(dir, "config", "remote.origin.uploadpack", script);
    return { reached: () => existsSync(mark), reset: () => rm(mark, { force: true }) };
  };

  it.skipIf(process.platform === "win32")(
    "assesses a build-phase change by the change branch here and the host's as last fetched",
    async () => {
      const { root, dir } = await setup("build");
      const host = await watchHost(dir);
      // The mark works: an ls-remote reaches the host.
      git(dir, "ls-remote", "origin");
      expect(host.reached()).toBe(true);
      await host.reset();
      // The task's work merged on the Git host only: not known here until a fetch.
      git(dir, "push", "-q", "origin", `${TASK}:${BRANCH}`);
      git(dir, "update-ref", "-d", `refs/remotes/origin/${BRANCH}`);
      await host.reset();
      const rep = await changeReport(root, ID);
      expect(host.reached()).toBe(false);
      expect(rep.blockers.map((b) => b.code)).toContain("task-not-merged");
      // Once fetched (the person's Sync), the host's change branch as last fetched lets it go.
      git(dir, "fetch", "-q", "origin", `+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`);
      await host.reset();
      const after = await changeReport(root, ID);
      expect(host.reached()).toBe(false);
      expect(after.blockers.map((b) => b.code)).not.toContain("task-not-merged");
    },
    120_000,
  );

  it.skipIf(process.platform === "win32")(
    "gives go/no-go's release PR reasons offline without reaching the host",
    async () => {
      const { root, dir } = await setup("qa");
      const host = await watchHost(dir);
      const reasons = await releasePrReasons(root, ID, { offline: true });
      expect(host.reached()).toBe(false);
      expect(reasons.map((r) => r.code)).toContain("task-not-merged");
    },
    120_000,
  );
});
