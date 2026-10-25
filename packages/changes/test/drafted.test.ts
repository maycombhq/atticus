import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { createGit } from "@maycombhq/workspace";
import {
  completeCaptures,
  gitHandoffPublisher,
  handoff,
  learnReport,
  loadChangeContext,
  newChange,
  syncHandoff,
} from "../src/index.js";
import { FEATURE_OWNERS, REPO, approval, copyPhase, forgeMetarepo, host } from "./helpers.js";

/**
 * H1: when a stage's hand-off PR is found merged, what Atticus drafted is kept beside what was
 * merged, with the commit of each, from the clone's own git. The Git host is the mock; the
 * "host's" repository is a bare repo on disk, and the team's edit on the PR is a commit pushed
 * to the hand-off branch from another clone, merged with a merge commit as a host does.
 */

const T = 120_000;
const ID = "add-transfer-limit";
const BRANCH = `handoff/${ID}/define`;
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_TERMINAL_PROMPT: "0",
};
const runner = createGit({ env: ENV });

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    env: ENV,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** A metarepo clone with a bare remote, and the change's feature stage done and handed off. */
async function handedOff() {
  const root = await forgeMetarepo();
  const remote = join(await mkdtemp(join(tmpdir(), "atticus-drafted-remote-")), "meta.git");
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "org-pack", ".github");
  git(root, "commit", "-q", "-m", "first");
  git(root, "init", "-q", "--bare", remote);
  git(root, "remote", "add", "origin", remote);
  git(root, "push", "-q", "origin", "main");
  await newChange(root, {
    title: "Add transfer limit",
    type: "feature",
    by: "pat",
    owners: FEATURE_OWNERS,
    systems: ["ledger", "portal"],
    now: "2026-10-19T09:00:00Z",
  });
  await copyPhase(root, ID, `${ID}/stages/define`);
  const gh = host();
  await handoff(root, ID, {
    gitHost: gh,
    repo: REPO,
    by: "pat",
    approval: approval("pat", "2026-10-19T10:00:00Z"),
    now: "2026-10-19T10:00:00Z",
    publisher: gitHandoffPublisher({ env: ENV }),
  });
  return { root, remote, gh, draft: git(root, "rev-parse", `refs/heads/${BRANCH}`) };
}

const FEATURE = `openspec/changes/${ID}/feature.yaml`;

/** On the host: a reviewer edits feature.yaml on the PR's branch, then the PR merges. */
async function teamEditsAndMerges(remote: string): Promise<{ edit: string; merge: string }> {
  const other = await mkdtemp(join(tmpdir(), "atticus-drafted-host-"));
  git(other, "clone", "-q", remote, ".");
  git(other, "checkout", "-q", BRANCH);
  const f = join(other, FEATURE);
  const text = await readFile(f, "utf8");
  await writeFile(
    f,
    text
      .replace(
        "The limit is checked where Ledger accepts a transfer.",
        "The limit is checked before Ledger accepts a transfer, against today's total.",
      )
      .replace(
        "gaps: []",
        "gaps:\n  - what: No daily total is kept per account.\n    why: The limit needs today's total.",
      ),
  );
  git(other, "commit", "-q", "-am", "Say where the limit is checked");
  const edit = git(other, "rev-parse", "HEAD");
  git(other, "checkout", "-q", "main");
  git(other, "merge", "-q", "--no-ff", BRANCH, "-m", `Merge pull request #1 from forge/${BRANCH}`);
  git(other, "push", "-q", "origin", "main");
  // The host deletes the merged branch.
  git(other, "push", "-q", "origin", "--delete", BRANCH);
  return { edit, merge: git(other, "rev-parse", "HEAD") };
}

function hostMerges(gh: ReturnType<typeof host>) {
  gh.review(REPO, 1, "ari", "approved");
  return gh.merge(REPO, 1, approval("ari", "2026-10-19T11:00:00Z"));
}

describe("keeping the draft beside what merged (H1)", () => {
  it(
    "keeps the stage's files as the draft commit had them and as the merge commit has them, with both commits",
    async () => {
      const { root, remote, gh, draft } = await handedOff();
      const drafted = await readFile(join(root, FEATURE), "utf8");
      const { merge } = await teamEditsAndMerges(remote);
      await hostMerges(gh);
      // The person's clone has fetched the host (a local path: no network) but not pulled.
      git(root, "fetch", "-q", "origin");
      const before = gh.journal.length;

      const r = await syncHandoff(root, ID, {
        gitHost: gh,
        repo: REPO,
        now: "2026-10-19T12:00:00Z",
        git: runner,
      });
      expect(r.merged).toBe(true);
      expect(r.capture).toMatchObject({
        change: ID,
        stage: "feature",
        phase: "define",
        pr: { number: 1 },
        branch: BRANCH,
        base: "main",
        state: "captured",
        drafted: { from: "git", commit: draft },
        merged: { commit: merge, how: "message" },
      });
      expect(r.capture!.files.map((f) => [f.path, f.status])).toEqual([
        ["feature.md", "same"],
        ["feature.yaml", "edited"],
      ]);
      const dir = join(root, "openspec/changes", ID, "stage");
      expect(await readFile(join(dir, "feature.drafted/feature.yaml"), "utf8")).toBe(drafted);
      const merged = await readFile(join(dir, "feature.merged/feature.yaml"), "utf8");
      expect(merged).toContain("against today's total");
      expect(merged).toBe(git(remote, "show", `main:${FEATURE}`) + "\n");
      const file = parse(await readFile(join(dir, "feature.capture.yaml"), "utf8"));
      expect(file.merged.commit).toBe(merge);
      // The loop state, the brief and change.yaml are never part of the draft.
      expect(file.files.map((f: { path: string }) => f.path)).toEqual([
        "feature.md",
        "feature.yaml",
      ]);
      // The sync read the PR from the Git host and nothing more; the rest came from the clone.
      expect(gh.journal.slice(before).map((c) => c.method)).toEqual(["getPullRequest"]);
    },
    T,
  );

  it(
    "finds the draft through the merge commit when the hand-off branch is gone from the clone",
    async () => {
      const { root, remote, gh, draft } = await handedOff();
      git(root, "update-ref", "-d", `refs/heads/${BRANCH}`);
      git(root, "update-ref", "-d", `refs/remotes/origin/${BRANCH}`);
      await teamEditsAndMerges(remote);
      await hostMerges(gh);
      git(root, "fetch", "-q", "--prune", "origin");
      const r = await syncHandoff(root, ID, {
        gitHost: gh,
        repo: REPO,
        now: "2026-10-19T12:00:00Z",
        git: runner,
      });
      expect(r.capture).toMatchObject({
        state: "captured",
        drafted: { from: "git", commit: draft },
      });
    },
    T,
  );

  it(
    "waits for a merge that isn't in the clone yet, and completes after a fetch",
    async () => {
      const { root, remote, gh } = await handedOff();
      const { merge } = await teamEditsAndMerges(remote);
      await hostMerges(gh);
      const r = await syncHandoff(root, ID, {
        gitHost: gh,
        repo: REPO,
        now: "2026-10-19T12:00:00Z",
        git: runner,
      });
      expect(r.capture).toMatchObject({ state: "waiting-for-merge", files: [] });
      expect(r.capture!.note).toBe(
        "The merge of PR #1 isn't in this clone yet: pull main, then run atticus change learn.",
      );
      expect((await learnReport(root)).pending).toEqual([
        expect.objectContaining({ change: ID, stage: "feature", state: "waiting-for-merge" }),
      ]);

      git(root, "fetch", "-q", "origin");
      const done = await completeCaptures(root, await loadChangeContext(root), {
        now: "2026-10-19T13:00:00Z",
        git: runner,
      });
      expect(done.map((d) => [d.capture.stage, d.capture.state, d.capture.merged?.commit])).toEqual(
        [["feature", "captured", merge]],
      );
      // Run again: nothing left to do.
      expect(
        await completeCaptures(root, await loadChangeContext(root), {
          now: "2026-10-19T14:00:00Z",
          git: runner,
        }),
      ).toEqual([]);
      const report = await learnReport(root);
      expect(report.pending).toEqual([]);
      expect(
        report.changes[0]!.stages[0]!.files.find((f) => f.path === "feature.yaml"),
      ).toMatchObject({
        // The why reworded (1 changed), and "gaps: []" became a gap of two lines (1 changed, 2 added).
        status: "edited",
        added: 2,
        removed: 0,
        changed: 2,
      });
    },
    T,
  );

  it("keeps nothing in a metarepo that isn't a git clone, and the sync goes on as before", async () => {
    const root = await forgeMetarepo();
    await newChange(root, {
      title: "Add transfer limit",
      type: "feature",
      by: "pat",
      owners: FEATURE_OWNERS,
      systems: ["ledger", "portal"],
      now: "2026-10-19T09:00:00Z",
    });
    await copyPhase(root, ID, `${ID}/stages/define`);
    const gh = host();
    await handoff(root, ID, {
      gitHost: gh,
      repo: REPO,
      by: "pat",
      approval: approval("pat", "2026-10-19T10:00:00Z"),
      now: "2026-10-19T10:00:00Z",
    });
    await hostMerges(gh);
    const r = await syncHandoff(root, ID, {
      gitHost: gh,
      repo: REPO,
      now: "2026-10-19T12:00:00Z",
      git: runner,
    });
    expect(r.merged).toBe(true);
    expect(r.capture).toBeUndefined();
  });
});
