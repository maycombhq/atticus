import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ManualGitHost, MockGitHost, memoryStepStore, recordStep } from "@maycombhq/adapters";
import { readChangeRepos, writeChangeRepos } from "@maycombhq/workspace";
import {
  ChangeError,
  canAdvance,
  nothingToRelease,
  raiseReleasePrs,
  releasePrReasons,
  syncReleasePrs,
} from "../src/index.js";
import { approval, forgeMetarepo } from "./helpers.js";

/**
 * ADR 0184: the release PRs, change/<id> into each code repo's default branch. Offline: each
 * repo's "host" is a bare repository on disk, and the Git host is the mock (or the manual one).
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

const PATH = ["plan", "build", "qa", "release-ready", "released"];

/** The Forge change at a later state, with the history that leads there. */
async function changeAt(root: string, state: string) {
  const dir = join(root, "openspec/changes", ID);
  await cp(join(FORGE_CHANGE, "openspec/changes", ID), dir, { recursive: true });
  const p = join(dir, "change.yaml");
  const steps = PATH.slice(0, PATH.indexOf(state) + 1);
  const entries = steps
    .slice(1)
    .map(
      (to, i) =>
        `  - from: ${steps[i]}\n    to: ${to}\n    at: 2026-10-2${i}T10:00:00Z\n    by: tia\n    reason: Moved on for the test`,
    )
    .join("\n");
  const text = await readFile(p, "utf8");
  await writeFile(
    p,
    steps.length < 2
      ? text
      : text
          .replace(/^state: plan$/m, `state: ${state}`)
          .replace(/( {4}reason: Approve design merged\n)/, `$1${entries}\n`),
  );
}

/**
 * A code repo: a bare "host" with main, and the change's worktree on change/<id> with one commit
 * of its own (`work`), pushed to the host when `onHost`.
 */
async function codeRepo(root: string, repo: string, o: { work?: boolean; onHost?: boolean } = {}) {
  const host = join(root, ".hosts", `${repo}.git`);
  await mkdir(host, { recursive: true });
  git(host, "init", "-q", "--bare", "-b", "main");
  const worktree = `workspace/.worktrees/${ID}/${repo}`;
  const dir = join(root, worktree);
  await mkdir(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  await writeFile(join(dir, "README.md"), `# ${repo}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "start");
  git(dir, "remote", "add", "origin", host);
  git(dir, "push", "-q", "origin", "main");
  const baseSha = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "-b", BRANCH);
  if (o.work !== false) {
    await writeFile(join(dir, "Limit.java"), "class Limit {}\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "task 1.1");
  }
  if (o.onHost) git(dir, "push", "-q", "origin", BRANCH);
  return { id: repo, branch: BRANCH, base: "main", baseSha, worktree, host, dir };
}

async function setup(
  state: string,
  repos: { id: string; work?: boolean; onHost?: boolean; branch?: string }[],
) {
  const root = await forgeMetarepo();
  await changeAt(root, state);
  const made = [];
  for (const r of repos)
    made.push({ ...(await codeRepo(root, r.id, r)), ...(r.branch ? { branch: r.branch } : {}) });
  await writeChangeRepos(root, {
    schemaVersion: 3,
    change: ID,
    repos: made.map((r) => ({
      id: r.id,
      branch: r.branch,
      base: r.base,
      baseSha: r.baseSha,
      worktree: r.worktree,
      build: { status: "not-run" as const },
    })),
  });
  return { root, repos: made };
}

describe("release PRs (ADR 0184)", () => {
  it("opens one PR per repo from the change branch into its default branch and records it", async () => {
    const { root, repos } = await setup("release-ready", [
      { id: "forge-ledger" },
      { id: "forge-portal-bff", onHost: true },
    ]);
    const host = new MockGitHost([{ repo: "forge-ledger" }, { repo: "forge-portal-bff" }]);
    // The host's change branch moved on by a merged task PR; the worktree's copy is behind it.
    const bff = repos[1]!;
    const onHostBefore = git(bff.host, "rev-parse", `refs/heads/${BRANCH}`);
    await writeFile(join(bff.dir, "Local.java"), "class Local {}\n");
    git(bff.dir, "add", "-A");
    git(bff.dir, "commit", "-q", "-m", "local only");

    const r = await raiseReleasePrs(root, ID, { gitHost: host, approval: YES, now: NOW });
    expect(r.rows.map((x) => [x.repo, x.outcome])).toEqual([
      ["forge-ledger", "raised"],
      ["forge-portal-bff", "raised"],
    ]);
    for (const id of ["forge-ledger", "forge-portal-bff"]) {
      const [pr] = await host.listPullRequests(id, {});
      expect(pr).toMatchObject({ head: BRANCH, base: "main", state: "open" });
    }
    // Pushed only where the host lacked it, and only the change branch; never over the host's.
    const ledger = repos[0]!;
    expect(git(ledger.host, "rev-parse", `refs/heads/${BRANCH}`)).toBe(
      git(ledger.dir, "rev-parse", BRANCH),
    );
    expect(git(ledger.host, "rev-parse", "refs/heads/main")).toBe(ledger.baseSha);
    expect(git(bff.host, "rev-parse", `refs/heads/${BRANCH}`)).toBe(onHostBefore);

    const saved = await readChangeRepos(root, ID);
    expect(saved!.repos.map((x) => x.pr)).toEqual([
      {
        url: "https://git.example.com/forge-ledger/pull/1",
        number: 1,
        state: "open",
        updatedAt: NOW,
      },
      {
        url: "https://git.example.com/forge-portal-bff/pull/1",
        number: 1,
        state: "open",
        updatedAt: NOW,
      },
    ]);

    // Raised again: the open PRs are kept, nothing new is opened.
    const again = await raiseReleasePrs(root, ID, { gitHost: host, approval: YES, now: NOW });
    expect(again.rows.map((x) => x.outcome)).toEqual(["kept", "kept"]);
    expect(await host.listPullRequests("forge-ledger", {})).toHaveLength(1);
  });

  it("needs the person's approval and a change past its build", async () => {
    const { root } = await setup("build", [{ id: "forge-ledger" }]);
    const host = new MockGitHost([{ repo: "forge-ledger" }]);
    await expect(
      raiseReleasePrs(root, ID, { gitHost: host, approval: undefined as never }),
    ).rejects.toThrow(/approval/);
    await expect(
      raiseReleasePrs(root, ID, { gitHost: host, approval: YES }),
    ).rejects.toBeInstanceOf(ChangeError);
    expect(await host.listPullRequests("forge-ledger", {})).toEqual([]);
  });

  it("refuses a protected change branch and a branch that isn't the change branch", async () => {
    const { root, repos } = await setup("released", [
      { id: "forge-ledger" },
      { id: "forge-portal-bff", branch: "feature/limits" },
    ]);
    const host = new MockGitHost([
      { repo: "forge-ledger", protectedBranches: ["main", BRANCH] },
      { repo: "forge-portal-bff" },
    ]);
    const r = await raiseReleasePrs(root, ID, { gitHost: host, approval: YES, now: NOW });
    expect(r.rows.map((x) => [x.repo, x.outcome])).toEqual([
      ["forge-ledger", "refused"],
      ["forge-portal-bff", "refused"],
    ]);
    expect(r.rows[0]!.message).toMatch(/is protected/);
    expect(r.rows[1]!.message).toMatch(/not change\/add-transfer-limit/);
    expect(await host.listPullRequests("forge-ledger", {})).toEqual([]);
    // Nothing pushed.
    expect(() =>
      git(repos[0]!.host, "rev-parse", "--verify", "-q", `refs/heads/${BRANCH}`),
    ).toThrow();
    expect((await readChangeRepos(root, ID))!.repos.every((x) => !x.pr)).toBe(true);
  });

  it("says when a change branch has nothing to release", async () => {
    const { root } = await setup("release-ready", [{ id: "forge-ledger", work: false }]);
    const host = new MockGitHost([{ repo: "forge-ledger" }]);
    const r = await raiseReleasePrs(root, ID, { gitHost: host, approval: YES, now: NOW });
    expect(r.rows.map((x) => x.outcome)).toEqual(["nothing"]);
    expect(await host.listPullRequests("forge-ledger", {})).toEqual([]);
    // Recorded, so go/no-go doesn't wait for a PR that can't exist.
    expect([...(await nothingToRelease(root, ID))]).toEqual(["forge-ledger"]);
    expect(await releasePrReasons(root, ID)).toEqual([]);
    // Work lands later: raised again, it gets its PR and leaves the list.
    const dir = join(root, `workspace/.worktrees/${ID}/forge-ledger`);
    await writeFile(join(dir, "Late.java"), "class Late {}\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "late task");
    const again = await raiseReleasePrs(root, ID, { gitHost: host, approval: YES, now: NOW });
    expect(again.rows.map((x) => x.outcome)).toEqual(["raised"]);
    expect([...(await nothingToRelease(root, ID))]).toEqual([]);
  });

  it("voids a nothing-to-release entry once the change branch moved, here or on the host (final review)", async () => {
    const { root, repos } = await setup("release-ready", [{ id: "forge-ledger", work: false }]);
    const host = new MockGitHost([{ repo: "forge-ledger" }]);
    await raiseReleasePrs(root, ID, { gitHost: host, approval: YES, now: NOW });
    expect([...(await nothingToRelease(root, ID))]).toEqual(["forge-ledger"]);
    const { dir } = repos[0]!;
    const recorded = git(dir, "rev-parse", BRANCH);
    // Work lands on the local change branch, and nobody raised again: go/no-go waits for its PR.
    await writeFile(join(dir, "Late.java"), "class Late {}\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "late task");
    expect([...(await nothingToRelease(root, ID))]).toEqual([]);
    expect((await releasePrReasons(root, ID)).map((x) => x.code)).toEqual(["release-pr-missing"]);
    // Back at the recorded commit here, but the host's change branch has a task merged into it.
    git(dir, "reset", "-q", "--hard", recorded);
    expect([...(await nothingToRelease(root, ID))]).toEqual(["forge-ledger"]);
    const merged = git(dir, "commit-tree", `${recorded}^{tree}`, "-p", recorded, "-m", "task");
    git(dir, "push", "-q", "origin", `${merged}:refs/heads/${BRANCH}`);
    expect(git(dir, "rev-parse", BRANCH)).toBe(recorded);
    expect([...(await nothingToRelease(root, ID))]).toEqual([]);
    expect((await releasePrReasons(root, ID)).map((x) => x.code)).toEqual(["release-pr-missing"]);
  });

  it("Sync records a PR merged on the host and the build its checks say", async () => {
    const { root } = await setup("release-ready", [{ id: "forge-ledger" }]);
    const host = new MockGitHost([{ repo: "forge-ledger" }]);
    await raiseReleasePrs(root, ID, { gitHost: host, approval: YES, now: NOW });
    host.review("forge-ledger", 1, "ari", "approved");
    host.setChecks("forge-ledger", 1, [{ name: "build", status: "passed" }]);
    await host.merge("forge-ledger", 1, approval("ari", NOW, "host"));
    const s = await syncReleasePrs(root, ID, { gitHost: host, now: "2026-11-08T11:00:00Z" });
    expect(s.rows[0]!.message).toMatch(/is merged, checks passed/);
    const [r] = (await readChangeRepos(root, ID))!.repos;
    expect(r!.pr).toMatchObject({ number: 1, state: "merged" });
    expect(r!.build.status).toBe("passed");
  });

  it("Sync reads only the change branch's own PR, never another PR by the same number (round 44)", async () => {
    const { root } = await setup("release-ready", [{ id: "forge-ledger" }]);
    const host = new MockGitHost([{ repo: "forge-ledger" }]);
    // PR #1 on the host is another branch's, merged; the release PR is #2.
    await host.createPullRequest(
      {
        repo: "forge-ledger",
        head: "feature/other",
        base: "main",
        title: "Other",
        body: "",
      },
      approval("ari", NOW, "other"),
    );
    host.review("forge-ledger", 1, "ari", "approved");
    await host.merge("forge-ledger", 1, approval("ari", NOW, "host"));
    await raiseReleasePrs(root, ID, { gitHost: host, approval: YES, now: NOW });
    const cr = (await readChangeRepos(root, ID))!;
    expect(cr.repos[0]!.pr!.number).toBe(2);
    // The number goes wrong (say, recorded by hand as #1).
    await writeChangeRepos(root, {
      ...cr,
      repos: cr.repos.map((r) => ({ ...r, pr: { ...r.pr!, number: 1 } })),
    });
    await syncReleasePrs(root, ID, { gitHost: host, now: NOW });
    expect((await readChangeRepos(root, ID))!.repos[0]!.pr).toMatchObject({
      number: 2,
      state: "open",
    });
  });

  it("a manual Git host records the PR as a step, and Sync takes the link the person recorded", async () => {
    const { root } = await setup("release-ready", [{ id: "forge-ledger", onHost: true }]);
    const store = memoryStepStore();
    const host = new ManualGitHost({ store, now: () => NOW });
    const r = await raiseReleasePrs(root, ID, { gitHost: host, approval: YES, now: NOW });
    expect(r.rows[0]!.message).toMatch(/a step for you/);
    expect((await readChangeRepos(root, ID))!.repos[0]!.pr).toMatchObject({
      url: "manual://git-host/forge-ledger/pull/1",
      number: 1,
    });
    const [open] = await store.list({ action: "open-pull-request" });
    expect(open!.inputs).toMatchObject({ head: BRANCH, base: "main" });
    await recordStep(store, open!.id, {
      by: "tia",
      at: NOW,
      values: { url: "https://git.example.com/forge/forge-ledger/pull/12", number: 12 },
    });
    await syncReleasePrs(root, ID, { gitHost: host, now: NOW });
    expect((await readChangeRepos(root, ID))!.repos[0]!.pr).toMatchObject({
      url: "https://git.example.com/forge/forge-ledger/pull/12",
      state: "open",
    });
  });

  it("go/no-go waits for every repo's release PR, merged unless the org pack says otherwise", async () => {
    const { root } = await setup("release-ready", [{ id: "forge-ledger" }]);
    expect((await releasePrReasons(root, ID)).map((x) => x.code)).toEqual(["release-pr-missing"]);
    const ready = await canAdvance(ID, root);
    expect(ready.reasons.map((x) => x.code)).toContain("release-pr-missing");

    const host = new MockGitHost([{ repo: "forge-ledger" }]);
    await raiseReleasePrs(root, ID, { gitHost: host, approval: YES, now: NOW });
    expect((await releasePrReasons(root, ID)).map((x) => x.code)).toEqual([
      "release-pr-not-merged",
    ]);

    await mkdir(join(root, "org-pack/process"), { recursive: true });
    await writeFile(
      join(root, "org-pack/process/ci.yaml"),
      "schemaVersion: 1\narchive:\n  requireMergedPrs: false\n",
    );
    expect(await releasePrReasons(root, ID)).toEqual([]);
  });
});
