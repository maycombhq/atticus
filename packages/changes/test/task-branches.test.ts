import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MockGitHost } from "@maycombhq/adapters";
import { writeChangeRepos } from "@maycombhq/workspace";
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
});
