import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fileStepStore } from "@maycombhq/adapters";
import { readChangeRepos, writeChangeRepos } from "@maycombhq/workspace";
import { changeReleasePrs } from "../src/change-commands.js";
import { todoDone } from "../src/todo-commands.js";

/**
 * App-only audit (manual Git host): recording a release PR's merge on its step ("Merged on the Git
 * host: yes") syncs the change as the steps say, without a separate Sync.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const FORGE_CHANGE = join(HERE, "../../../fixtures/forge-change");
const ID = "add-transfer-limit";
const BRANCH = `change/${ID}`;
const NOW = "2026-11-09T10:00:00Z";
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
const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
};

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "atticus-cli-release-manual-"));
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  const rt = join(root, "org-pack/runtime.yaml");
  await writeFile(
    rt,
    (await readFile(rt, "utf8")).replace("gitHost: { type: mock }", "gitHost: manual"),
  );
  const dir = join(root, "openspec/changes", ID);
  await cp(join(FORGE_CHANGE, "openspec/changes", ID), dir, { recursive: true });
  const text = await readFile(join(dir, "change.yaml"), "utf8");
  const steps = ["plan", "build", "qa", "release-ready"];
  const entries = steps
    .slice(1)
    .map(
      (to, i) =>
        `  - from: ${steps[i]}\n    to: ${to}\n    at: 2026-10-2${i}T10:00:00Z\n    by: tia\n    reason: Moved on for the test`,
    )
    .join("\n");
  await writeFile(
    join(dir, "change.yaml"),
    text
      .replace(/^state: plan$/m, "state: release-ready")
      .replace(/( {4}reason: Approve design merged\n)/, `$1${entries}\n`),
  );
  const host = join(root, ".hosts", "forge-ledger.git");
  await mkdir(host, { recursive: true });
  git(host, "init", "-q", "--bare", "-b", "main");
  const worktree = `workspace/.worktrees/${ID}/forge-ledger`;
  const wt = join(root, worktree);
  await mkdir(wt, { recursive: true });
  git(wt, "init", "-q", "-b", "main");
  await writeFile(join(wt, "README.md"), "# ledger\n");
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", "start");
  git(wt, "remote", "add", "origin", host);
  git(wt, "push", "-q", "origin", "main");
  const baseSha = git(wt, "rev-parse", "HEAD");
  git(wt, "checkout", "-q", "-b", BRANCH);
  await mkdir(dirname(join(wt, "src/Limit.java")), { recursive: true });
  await writeFile(join(wt, "src/Limit.java"), "class Limit {}\n");
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", "task 1.1");
  await writeChangeRepos(root, {
    schemaVersion: 3,
    change: ID,
    repos: [
      {
        id: "forge-ledger",
        branch: BRANCH,
        base: "main",
        baseSha,
        worktree,
        build: { status: "not-run" },
      },
    ],
  });
  return root;
}

describe("a release PR on a manual Git host (app-only audit)", () => {
  it("recording its merge on its step records the release PR merged, with no Sync", async () => {
    const root = await setup();
    const c = capture();
    expect(await changeReleasePrs(root, ID, { by: "tia", approve: true }, c.io, { now: NOW })).toBe(
      0,
    );
    const store = fileStepStore(root);
    const open = (await store.list({ system: "git-host", action: "open-pull-request" }))[0]!;
    const a = capture();
    expect(
      await todoDone(
        root,
        open.id,
        { by: "tia", result: ["url=https://git.forge.example/forge-ledger/pull/7", "number=7"] },
        a.io,
        { now: () => new Date(NOW), sync: { now: NOW } },
      ),
    ).toBe(0);
    const report = (await store.list({ system: "git-host", action: "report-pull-request" })).find(
      (s) => s.state === "open",
    )!;
    const b = capture();
    expect(
      await todoDone(
        root,
        report.id,
        { by: "tia", result: ["approvers=ari", "checksPassing=yes", "merged=yes"] },
        b.io,
        { now: () => new Date(NOW), sync: { now: NOW } },
      ),
    ).toBe(0);
    const repos = await readChangeRepos(root, ID);
    expect(repos?.repos[0]?.pr).toMatchObject({ number: 7, state: "merged" });
    expect(b.out.join("\n")).toMatch(/forge-ledger: release PR #7 .*merged/);
  }, 180_000);
});
