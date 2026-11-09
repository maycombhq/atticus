import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AdapterError, MockGitHost } from "@maycombhq/adapters";
import { MockRuntime } from "@maycombhq/ai";
import { previewTaskRun, raiseTaskPr, readTaskRun, runTask } from "../src/index.js";
import { CHANGE, git, sh, speckitRoot } from "./helpers.js";

/**
 * Review round 48 (tasks and Git host): a task run again after its PR was closed or merged
 * never raises the earlier commits again, and a task PR the host opened without saying so is
 * recorded on the next raise.
 */

const T = 180_000;
const now = () => new Date("2026-11-08T09:00:00Z");
const APPROVAL = { by: "dev", at: "2026-11-08T09:00:00Z", ref: "review round 48" };
const ok = async () => ({ exitCode: 0, stdout: "BUILD OK", stderr: "" });
const BRANCH = `task/${CHANGE}/1.2`;
const REJECTED = "src/main/java/forge/ledger/Rejected.java";
const SECOND = "src/main/java/forge/ledger/Second.java";
const answer = (file: string, body: string) =>
  new MockRuntime(() => `Done.\n\n=== file: ${file}\n${body}\n=== end file\n`, { now });

const run = (root: string, host: MockGitHost, file: string, body: string) =>
  runTask(root, CHANGE, "1.2", {
    level: "pr",
    by: "dev",
    approval: APPROVAL,
    runtime: answer(file, body),
    git,
    gitHost: host,
    now,
    commands: ok,
  });

describe("a task run again after its PR was closed or merged (review round 48)", () => {
  it(
    "refuses while the task branch still holds the closed PR's commits, and raises nothing",
    async () => {
      const { root, remotes } = await speckitRoot({ repos: ["forge-ledger"] });
      const host = new MockGitHost([{ repo: "forge-ledger" }]);
      const r1 = await run(root, host, REJECTED, "class Rejected {}");
      expect(r1.state).toBe("pr-open");
      await host.closePullRequest("forge-ledger", r1.pr!.number, APPROVAL);
      const tip = sh(remotes["forge-ledger"]!, "rev-parse", `refs/heads/${BRANCH}`);

      const message = `Task 1.2's earlier PR ${r1.pr!.url} is closed, and its branch ${BRANCH} still has the commits that PR carried (1 not in change/${CHANGE}): running the task again would raise them again.`;
      await expect(run(root, host, SECOND, "class Second {}")).rejects.toThrow(message);
      await expect(previewTaskRun(root, CHANGE, "1.2", { gitHost: host })).rejects.toThrow(message);
      const err = (await run(root, host, SECOND, "class Second {}").catch(
        (e: unknown) => e,
      )) as Error;
      expect(err.message).toContain(`delete ${BRANCH} on the Git host`);
      expect(err.message).toContain(
        `worktree remove ${join(root, "workspace/.worktrees", CHANGE, ".tasks/1.2/forge-ledger")}`,
      );
      expect(err.message).toContain(`branch -D ${BRANCH}`);
      // Nothing was pushed, opened, deleted or moved.
      expect(host.journal.filter((c) => c.method === "createPullRequest")).toHaveLength(1);
      expect(sh(remotes["forge-ledger"]!, "rev-parse", `refs/heads/${BRANCH}`)).toBe(tip);
      expect(await readTaskRun(root, CHANGE, "1.2")).toMatchObject({
        state: "pr-open",
        pr: r1.pr,
      });
    },
    T,
  );

  it(
    "starts fresh from the change branch when the merged PR's commits are all in it",
    async () => {
      const { root, remotes } = await speckitRoot({ repos: ["forge-ledger"] });
      const bare = remotes["forge-ledger"]!;
      const host = new MockGitHost([{ repo: "forge-ledger" }]);
      const r1 = await run(root, host, REJECTED, "class Rejected {}");
      // A person merges the PR on the host (a merge that keeps its commits).
      sh(bare, "update-ref", `refs/heads/change/${CHANGE}`, `refs/heads/${BRANCH}`);
      host.review("forge-ledger", r1.pr!.number, "tia", "approved");
      await host.merge("forge-ledger", r1.pr!.number, APPROVAL);
      // Another task merged into the change branch on the host after it.
      const other = await mkdtemp(join(tmpdir(), "atticus-r48-"));
      sh(other, "clone", "-q", "-b", `change/${CHANGE}`, bare, "w");
      await writeFile(join(other, "w", "Other.md"), "another task\n");
      sh(join(other, "w"), "add", "-A");
      sh(join(other, "w"), "commit", "-q", "-m", "task 1.1 merged");
      sh(join(other, "w"), "push", "-q", "origin", `change/${CHANGE}`);

      const r2 = await run(root, host, SECOND, "class Second {}");
      expect(r2.state).toBe("pr-open");
      expect(r2.notes).toContain(`Its earlier PR ${r1.pr!.url} is merged.`);
      expect(r2.pr!.number).toBe(2);
      // The new PR starts from the change branch as the host has it, and carries only new work.
      const files = sh(bare, "diff", "--name-only", `change/${CHANGE}`, BRANCH);
      expect(files).toBe(SECOND);
    },
    T,
  );
});

describe("a task PR opened on the host without the answer (review round 48)", () => {
  it(
    "records the open PR from the task branch into the change branch on the next raise",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      const drafted = await runTask(root, CHANGE, "1.2", {
        level: "draft",
        by: "dev",
        runtime: answer("src/main/java/forge/ledger/TransferLimits.java", "class X {}"),
        git,
        now,
        commands: ok,
      });
      expect(drafted.state).toBe("built");
      const host = new MockGitHost([{ repo: "forge-ledger" }]);
      const real = host.createPullRequest.bind(host);
      let first = true;
      host.createPullRequest = async (i, a) => {
        const pr = await real(i, a);
        if (first) {
          first = false;
          throw new AdapterError("git-host", "unavailable", "timeout reading the response");
        }
        return pr;
      };
      const r1 = await raiseTaskPr(root, CHANGE, "1.2", {
        approval: APPROVAL,
        git,
        gitHost: host,
        now,
      });
      expect(r1.state).toBe("built");
      const r2 = await raiseTaskPr(root, CHANGE, "1.2", {
        approval: APPROVAL,
        git,
        gitHost: host,
        now,
      });
      expect(r2.state).toBe("pr-open");
      expect(r2.pr).toEqual({ number: 1, url: "https://git.example.com/forge-ledger/pull/1" });
      expect(r2.notes).toContain(
        `PR #1 from ${BRANCH} into change/${CHANGE} was already open on the Git host; recorded it (https://git.example.com/forge-ledger/pull/1).`,
      );
      expect((await host.listPullRequests("forge-ledger", {})).length).toBe(1);
    },
    T,
  );

  it(
    "keeps the task built when the open PR from its branch goes into another base",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      await runTask(root, CHANGE, "1.2", {
        level: "draft",
        by: "dev",
        runtime: answer("src/main/java/forge/ledger/TransferLimits.java", "class X {}"),
        git,
        now,
        commands: ok,
      });
      const host = new MockGitHost([{ repo: "forge-ledger" }]);
      await host.createPullRequest(
        { repo: "forge-ledger", head: BRANCH, base: "release/x", title: "t", body: "" },
        APPROVAL,
      );
      const r = await raiseTaskPr(root, CHANGE, "1.2", {
        approval: APPROVAL,
        git,
        gitHost: host,
        now,
      });
      expect(r.state).toBe("built");
      expect(r.notes.at(-1)).toMatch(/^The PR wasn't raised: git-host: an open PR from/);
    },
    T,
  );
});
