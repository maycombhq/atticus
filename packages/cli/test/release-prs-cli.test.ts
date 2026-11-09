import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MockGitHost } from "@maycombhq/adapters";
import { readChangeRepos, writeChangeRepos } from "@maycombhq/workspace";
import { changeReleasePrs, changeSync } from "../src/change-commands.js";
import { personOnlyWhy } from "@maycombhq/ai";
import { startServer } from "@maycombhq/server";
import { uiRoutes } from "../src/ui-api.js";
import { uiRunRoutes } from "../src/ui-api-run.js";
import { confirmFor } from "./confirm-helpers.js";

/** ADR 0184: atticus change release-prs, and change sync reading the release PRs back. */

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const FORGE_CHANGE = join(HERE, "../../../fixtures/forge-change");
const ID = "add-transfer-limit";
const BRANCH = `change/${ID}`;
const NOW = "2026-11-08T10:00:00Z";
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

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

/** A metarepo with the Forge change at release-ready and one code repo with work on change/<id>. */
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "atticus-cli-release-prs-"));
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
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

describe("atticus change release-prs", () => {
  it("says what it would raise without --approve, raises on --approve, and sync reads it back", async () => {
    const root = await setup();
    const gh = new MockGitHost([{ repo: "forge-ledger" }]);
    const deps = { gitHost: gh, now: NOW };

    let c = capture();
    expect(await changeReleasePrs(root, ID, { by: "tia" }, c.io, deps)).toBe(0);
    expect(c.out).toEqual([
      `Would open a release PR from ${BRANCH} into each repo's default branch: forge-ledger.`,
      `Nothing was sent. To do it: atticus change release-prs ${ID} --approve. A person merges each PR on the Git host; atticus change sync records it.`,
    ]);
    expect(await gh.listPullRequests("forge-ledger", {})).toEqual([]);

    c = capture();
    expect(await changeReleasePrs(root, ID, { by: "tia", approve: true }, c.io, deps)).toBe(0);
    expect(c.out[0]).toBe(
      `forge-ledger: release PR #1 from ${BRANCH} into main is open: https://git.example.com/forge-ledger/pull/1 Pushed ${BRANCH}, which the Git host didn't have.`,
    );

    gh.review("forge-ledger", 1, "ari", "approved");
    await gh.merge("forge-ledger", 1, { by: "ari", at: NOW, ref: "host" });
    c = capture();
    // No hand-off PR is open: sync still reads the release PRs.
    expect(await changeSync(root, ID, {}, c.io, deps)).toBe(0);
    expect(c.out).toContain(
      "forge-ledger: release PR #1 is merged (https://git.example.com/forge-ledger/pull/1).",
    );
    expect((await readChangeRepos(root, ID))!.repos[0]!.pr!.state).toBe("merged");
  });

  it("needs a person: --by, and the Copilot session can't run it with --approve", async () => {
    const root = await setup();
    const c = capture();
    expect(await changeReleasePrs(root, ID, { approve: true }, c.io, {})).toBe(2);
    expect(personOnlyWhy(["change", "release-prs", ID, "--approve"])).toMatch(/release PR/);
    expect(personOnlyWhy(["change", "release-prs", ID])).toBeUndefined();
  });

  it("the Release page's button raises them over the API, and the gates say what waits", async () => {
    const root = await setup();
    const gh = new MockGitHost([{ repo: "forge-ledger" }]);
    const srv = await startServer({
      root,
      port: 0,
      user: "tia",
      extend: (r, ctx) => {
        const deps = { now: NOW, gitHost: gh };
        uiRunRoutes(uiRoutes(r, ctx, deps), ctx, deps);
      },
    });
    try {
      const call = async (path: string, method = "GET", body?: unknown) => {
        const r = await fetch(srv.url + path, {
          method,
          headers: {
            "X-Atticus-Token": srv.token,
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        const text = await r.text();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return { status: r.status, body: (text ? JSON.parse(text) : {}) as any };
      };
      let d = await call(`/api/release/${ID}`);
      expect(d.body.status.blockers.map((b: { code: string }) => b.code)).toContain(
        "release-pr-missing",
      );
      expect((await call(`/api/changes/${ID}/release-prs`, "POST", { x: 1 })).status).toBe(400);
      // ADR 0186: the session token alone raises nothing; the page's confirmation does.
      expect((await call(`/api/changes/${ID}/release-prs`, "POST", {})).status).toBe(403);
      expect(await gh.listPullRequests("forge-ledger", {})).toHaveLength(0);
      const yes = () =>
        confirmFor(srv, "release-prs", ID).then((confirmation) => ({ confirmation }));
      const raised = await call(`/api/changes/${ID}/release-prs`, "POST", await yes());
      expect(raised.status).toBe(201);
      expect(raised.body.lines[0]).toMatch(/^forge-ledger: release PR #1 from change\//);
      d = await call(`/api/release/${ID}`);
      expect(d.body.repos[0].pr).toMatchObject({ number: 1, state: "open" });
      expect(d.body.status.blockers.map((b: { code: string }) => b.code)).toContain(
        "release-pr-not-merged",
      );
      // Raised again: nothing new to open, still 201.
      expect((await call(`/api/changes/${ID}/release-prs`, "POST", await yes())).status).toBe(201);
      expect(await gh.listPullRequests("forge-ledger", {})).toHaveLength(1);
    } finally {
      await srv.close();
    }
  });
});
