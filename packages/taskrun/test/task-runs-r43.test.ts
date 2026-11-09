import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockGitHost, type GitHost } from "@maycombhq/adapters";
import { MockRuntime } from "@maycombhq/ai";
import { previewTaskRun, raiseTaskPr, readTaskRun, runTask, taskPrState } from "../src/index.js";
import { CHANGE, FORGE, git, sh, speckitRoot } from "./helpers.js";

const T = 180_000;
const now = () => new Date("2026-11-08T09:00:00Z");
const APPROVAL = { by: "dev", at: "2026-11-08T09:00:00Z", ref: "task runs (review round 43)" };
const ok = async () => ({ exitCode: 0, stdout: "BUILD OK", stderr: "" });
const EVENTS = "src/main/java/forge/ledger/LedgerEvents.java";
const LIMITS = "src/main/java/forge/ledger/TransferLimits.java";

/** An answer that writes a file exactly as it already is: the task's worktree doesn't change. */
async function sameAnswer() {
  const text = await readFile(join(FORGE, "repos/forge-ledger", EVENTS), "utf8");
  return new MockRuntime(() => `Same.\n\n=== file: ${EVENTS}\n${text}=== end file\n`, { now });
}

async function draft(root: string, task: string) {
  return runTask(root, CHANGE, task, {
    level: "draft",
    by: "dev",
    runtime: new MockRuntime(
      () =>
        `Done.\n\n=== file: ${LIMITS}\npackage forge.ledger;\n\nclass X { boolean a; }\n=== end file\n`,
      { now },
    ),
    git,
    now,
    commands: ok,
  });
}

/** Review round 43: a build with nothing to commit, and a task PR merged or closed on the host. */
describe("task runs (review round 43)", () => {
  it(
    "an answer that changes nothing needs a person, with no commit and nothing to raise",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      const r = await runTask(root, CHANGE, "1.2", {
        level: "draft",
        by: "dev",
        runtime: await sameAnswer(),
        git,
        now,
        commands: ok,
      });
      expect(r.state).toBe("needs-person");
      expect(r.commit).toBeUndefined();
      expect(r.notes.at(-1)).toMatch(
        /^The AI's answer changed nothing in task\/add-transfer-limit\/1\.2, so there is nothing to commit: run the task again, or do it by hand in /,
      );
      expect(r.notes).not.toContain("Nothing to commit.");
      const host = new MockGitHost([{ repo: "forge-ledger" }]);
      await expect(
        raiseTaskPr(root, CHANGE, "1.2", { approval: APPROVAL, git, gitHost: host, now }),
      ).rejects.toThrow(/has no passing build to raise \(it is needs-person\)/);
      expect(await host.listPullRequests("forge-ledger", {})).toEqual([]);
    },
    T,
  );

  it(
    "at the pr level, an answer that changes nothing opens no PR",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      const host = new MockGitHost([{ repo: "forge-ledger" }]);
      const r = await runTask(root, CHANGE, "1.2", {
        level: "pr",
        by: "dev",
        approval: APPROVAL,
        runtime: await sameAnswer(),
        git,
        gitHost: host,
        now,
        commands: ok,
      });
      expect(r.state).toBe("needs-person");
      expect(r.pr).toBeUndefined();
      expect(r.notes.at(-1)).toMatch(/^The AI's answer changed nothing/);
      expect(r.notes.join(" ")).not.toContain("No PR:");
      expect(await host.listPullRequests("forge-ledger", {})).toEqual([]);
    },
    T,
  );

  it(
    "says a task PR's state on the host: open, then closed; nothing when the host can't say",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      await draft(root, "1.2");
      const host = new MockGitHost([{ repo: "forge-ledger" }]);
      // Before its PR: nothing to ask.
      expect(await taskPrState(root, CHANGE, "1.2", { gitHost: host })).toBeUndefined();
      const r1 = await raiseTaskPr(root, CHANGE, "1.2", {
        approval: APPROVAL,
        git,
        gitHost: host,
        now,
      });
      expect(await taskPrState(root, CHANGE, "1.2", { gitHost: host })).toBe("open");
      host.failNext("unavailable", "getPullRequest");
      expect(await taskPrState(root, CHANGE, "1.2", { gitHost: host })).toBeUndefined();
      // A host that doesn't answer in time is the recorded state too.
      const slow = {
        getPullRequest: () => new Promise(() => {}),
      } as unknown as GitHost;
      expect(
        await taskPrState(root, CHANGE, "1.2", { gitHost: slow, timeoutMs: 50 }),
      ).toBeUndefined();
      await host.closePullRequest("forge-ledger", r1.pr!.number, APPROVAL);
      expect(await taskPrState(root, CHANGE, "1.2", { gitHost: host })).toBe("closed");
      // The record isn't changed by asking.
      expect((await readTaskRun(root, CHANGE, "1.2"))?.state).toBe("pr-open");
    },
    T,
  );

  it(
    "the dry run asks the Git host it is given about a task's PR: closed, it lets the task run again",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      await draft(root, "1.2");
      const host = new MockGitHost([{ repo: "forge-ledger" }]);
      const r1 = await raiseTaskPr(root, CHANGE, "1.2", {
        approval: APPROVAL,
        git,
        gitHost: host,
        now,
      });
      await expect(previewTaskRun(root, CHANGE, "1.2", { gitHost: host })).rejects.toThrow(
        /^Task 1\.2's PR is open/,
      );
      await host.closePullRequest("forge-ledger", r1.pr!.number, APPROVAL);
      // Review round 48: not while the task branch still has the closed PR's commits.
      await expect(previewTaskRun(root, CHANGE, "1.2", { gitHost: host })).rejects.toThrow(
        /^Task 1\.2's earlier PR \S+ is closed, and its branch/,
      );
      const clone = join(root, "workspace/forge-ledger");
      sh(clone, "worktree", "remove", "--force", join(root, r1.worktree));
      sh(clone, "branch", "-D", `task/${CHANGE}/1.2`);
      const p = await previewTaskRun(root, CHANGE, "1.2", { gitHost: host });
      expect(p).toMatchObject({ task: "1.2", repo: "forge-ledger" });
    },
    T,
  );
});
