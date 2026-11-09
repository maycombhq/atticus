import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ManualGitHost, MockGitHost, memoryStepStore } from "@maycombhq/adapters";
import { writeChangeRepos } from "@maycombhq/workspace";
import { raiseReleasePrs, releasePrReasons, syncReleasePrs } from "../src/index.js";
import { approval, forgeMetarepo } from "./helpers.js";

/**
 * Review round 48 (tasks and Git host): a release PR goes into the repo's own default branch on a
 * manual Git host, and a merged release PR stands only while the change branch is where it merged.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE_CHANGE = join(HERE, "../../../fixtures/forge-change");
const ID = "add-transfer-limit";
const BRANCH = `change/${ID}`;
const NOW = "2026-11-08T10:00:00Z";
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
const PATH = ["plan", "build", "qa"];

async function setup(def: string) {
  const root = await forgeMetarepo();
  const dir0 = join(root, "openspec/changes", ID);
  await cp(join(FORGE_CHANGE, "openspec/changes", ID), dir0, { recursive: true });
  const p = join(dir0, "change.yaml");
  const entries = PATH.slice(1)
    .map(
      (to, i) =>
        `  - from: ${PATH[i]}\n    to: ${to}\n    at: 2026-10-2${i}T10:00:00Z\n    by: tia\n    reason: Moved on for the test`,
    )
    .join("\n");
  const text = await readFile(p, "utf8");
  await writeFile(
    p,
    text
      .replace(/^state: plan$/m, "state: qa")
      .replace(/( {4}reason: Approve design merged\n)/, `$1${entries}\n`),
  );
  const repo = "forge-ledger";
  const host = join(root, ".hosts", `${repo}.git`);
  await mkdir(host, { recursive: true });
  git(host, "init", "-q", "--bare", "-b", def);
  const worktree = `workspace/.worktrees/${ID}/${repo}`;
  const dir = join(root, worktree);
  await mkdir(dir, { recursive: true });
  git(dir, "init", "-q", "-b", def);
  await writeFile(join(dir, "README.md"), "x\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "start");
  git(dir, "remote", "add", "origin", host);
  git(dir, "push", "-q", "origin", def);
  const baseSha = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "-b", BRANCH);
  await writeFile(join(dir, "Limit.java"), "class Limit {}\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "task 1.1");
  git(dir, "push", "-q", "origin", BRANCH);
  await writeChangeRepos(root, {
    schemaVersion: 3,
    change: ID,
    repos: [
      {
        id: repo,
        branch: BRANCH,
        base: def,
        baseSha,
        worktree,
        build: { status: "not-run" as const },
      },
    ],
  });
  return { root, dir, host };
}

async function commitAndPush(dir: string, file: string) {
  await writeFile(join(dir, file), `${file}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", file);
  git(dir, "push", "-q", "origin", BRANCH);
}

describe("release PRs (review round 48)", () => {
  it("on a manual Git host, goes into the default branch the repos manifest gives the repo", async () => {
    const { root } = await setup("develop");
    const manifest = join(root, "org-pack/profiles/forge/repos.manifest.yaml");
    const text = await readFile(manifest, "utf8");
    await writeFile(
      manifest,
      text.replace("  - id: forge-ledger\n", "  - id: forge-ledger\n    defaultBranch: develop\n"),
    );
    const store = memoryStepStore();
    const gh = new ManualGitHost({ store, root, settings: {} });
    const r = await raiseReleasePrs(root, ID, { gitHost: gh, approval: YES, now: NOW });
    expect(r.rows[0]).toMatchObject({ outcome: "raised" });
    expect(r.rows[0]!.message).toContain(`from ${BRANCH} into develop`);
    const steps = await store.list({ system: "git-host", action: "open-pull-request" });
    expect(steps[0]!.title).toBe(`Open a pull request in forge-ledger from ${BRANCH} into develop`);
  }, 120_000);

  it("raises again, and holds go/no-go, once the change branch moved past a merged release PR", async () => {
    const { root, dir } = await setup("main");
    const gh = new MockGitHost([{ repo: "forge-ledger" }]);
    await raiseReleasePrs(root, ID, { gitHost: gh, approval: YES, now: NOW });
    gh.review("forge-ledger", 1, "rev", "approved");
    await gh.merge("forge-ledger", 1, YES);
    await syncReleasePrs(root, ID, { gitHost: gh, now: NOW });
    expect(await releasePrReasons(root, ID)).toEqual([]);
    // Nothing moved: the merged PR is kept.
    const kept = await raiseReleasePrs(root, ID, { gitHost: gh, approval: YES, now: NOW });
    expect(kept.rows[0]).toMatchObject({ outcome: "kept" });

    // A QA fix lands on the change branch after the merge.
    await commitAndPush(dir, "Fix.java");
    const reasons = await releasePrReasons(root, ID);
    expect(reasons.map((x) => x.code)).toEqual(["release-pr-stale"]);
    expect(reasons[0]!.message).toContain(
      `forge-ledger: ${BRANCH} has commits since release PR #1 merged`,
    );
    const again = await raiseReleasePrs(root, ID, { gitHost: gh, approval: YES, now: NOW });
    expect(again.rows[0]).toMatchObject({ outcome: "raised", pr: { number: 2, state: "open" } });
    expect((await releasePrReasons(root, ID)).map((x) => x.code)).toEqual([
      "release-pr-not-merged",
    ]);
    gh.review("forge-ledger", 2, "rev", "approved");
    await gh.merge("forge-ledger", 2, YES);
    await syncReleasePrs(root, ID, { gitHost: gh, now: NOW });
    expect(await releasePrReasons(root, ID)).toEqual([]);
  }, 120_000);

  it("keeps a merged release PR when only the local change branch is behind the host's", async () => {
    const { root, dir } = await setup("main");
    const gh = new MockGitHost([{ repo: "forge-ledger" }]);
    // A task merged on the host that this worktree hasn't pulled.
    const other = join(root, ".other");
    git(root, "clone", "-q", "-b", BRANCH, join(root, ".hosts/forge-ledger.git"), other);
    await commitAndPush(other, "Task2.java");
    await raiseReleasePrs(root, ID, { gitHost: gh, approval: YES, now: NOW });
    gh.review("forge-ledger", 1, "rev", "approved");
    await gh.merge("forge-ledger", 1, YES);
    await syncReleasePrs(root, ID, { gitHost: gh, now: NOW });
    expect(git(dir, "rev-parse", BRANCH)).not.toBe(git(other, "rev-parse", BRANCH));
    expect(await releasePrReasons(root, ID)).toEqual([]);
    const kept = await raiseReleasePrs(root, ID, { gitHost: gh, approval: YES, now: NOW });
    expect(kept.rows[0]).toMatchObject({ outcome: "kept" });
  }, 120_000);
});
