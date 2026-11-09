import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockGitHost } from "@maycombhq/adapters";
import { MockRuntime } from "@maycombhq/ai";
import { raiseTaskPr, readTaskRun, runTask } from "../src/index.js";
import { CHANGE, git, sh, speckitRoot } from "./helpers.js";

const T = 180_000;
const NOW = new Date("2026-11-08T09:00:00Z");
const now = () => NOW;
const APPROVAL = { by: "dev", at: "2026-11-08T09:00:00Z", ref: "task PR (review round 42)" };
const ok = async () => ({ exitCode: 0, stdout: "BUILD OK", stderr: "" });
const answer =
  (file: string, field = "ok") =>
  () =>
    `Done.\n\n=== file: ${file}\npackage forge.ledger;\n\nclass X { boolean ${field}; }\n=== end file\n`;
const LIMITS = "src/main/java/forge/ledger/TransferLimits.java";

/** Draft a task at the draft level: built and committed on its task branch. */
async function draft(root: string, task: string, file = LIMITS, field = "ok") {
  return runTask(root, CHANGE, task, {
    level: "draft",
    by: "dev",
    runtime: new MockRuntime(answer(file, field), { now }),
    git,
    now,
    commands: ok,
  });
}

const remoteRef = (bare: string, ref: string) => {
  try {
    return sh(bare, "rev-parse", "--verify", "-q", ref);
  } catch {
    return undefined;
  }
};

/** Review round 42: the task PR path after a first PR is merged, fails, or moves on. */
describe("task PRs (review round 42)", () => {
  it(
    "raises a second task's PR after the first was merged on the host: the change branch is never pushed over",
    async () => {
      const { root, remotes } = await speckitRoot({ repos: ["forge-ledger"] });
      const bare = remotes["forge-ledger"]!;
      const host = new MockGitHost([{ repo: "forge-ledger" }]);
      const a = await draft(root, "1.1", "src/main/java/forge/ledger/A.java");
      const b = await draft(root, "1.2", "src/main/java/forge/ledger/B.java");
      expect(remoteRef(bare, `refs/heads/change/${CHANGE}`)).toBeUndefined();
      const r1 = await raiseTaskPr(root, CHANGE, "1.1", {
        approval: APPROVAL,
        git,
        gitHost: host,
        now,
      });
      expect(r1.state).toBe("pr-open");
      // The first raise gave the PR its base: the change branch as it was here.
      const base = remoteRef(bare, `refs/heads/change/${CHANGE}`);
      expect(base).toBeDefined();
      // A person merges task 1.1's PR into the change branch on the host.
      sh(bare, "update-ref", `refs/heads/change/${CHANGE}`, `refs/heads/${a.branch}`);
      const r2 = await raiseTaskPr(root, CHANGE, "1.2", {
        approval: APPROVAL,
        git,
        gitHost: host,
        now,
      });
      expect(r2.notes.at(-1)).toContain("PR raised by dev");
      expect(r2.state).toBe("pr-open");
      // The host's change branch keeps the merge; the PR goes into it.
      expect(remoteRef(bare, `refs/heads/change/${CHANGE}`)).toBe(a.commit);
      expect(remoteRef(bare, `refs/heads/${b.branch}`)).toBe(b.commit);
      const pr = await host.getPullRequest("forge-ledger", r2.pr!.number);
      expect(pr).toMatchObject({ head: b.branch, base: `change/${CHANGE}` });
    },
    T,
  );

  it(
    "pushes the change branch and the task branch together or not at all",
    async () => {
      const { root, remotes } = await speckitRoot({ repos: ["forge-ledger"] });
      const bare = remotes["forge-ledger"]!;
      const d = await draft(root, "1.2");
      // The remote takes no change branch (a hook refuses it): the task branch isn't pushed alone.
      const hook = join(bare, "hooks", "pre-receive");
      await writeFile(
        hook,
        `#!/bin/sh\nwhile read old new ref; do case "$ref" in refs/heads/change/*) echo "change branches are made on the host" >&2; exit 1;; esac; done\nexit 0\n`,
      );
      await chmod(hook, 0o755);
      const host = new MockGitHost([{ repo: "forge-ledger" }]);
      const r = await raiseTaskPr(root, CHANGE, "1.2", {
        approval: APPROVAL,
        git,
        gitHost: host,
        now,
      });
      expect(r.state).toBe("built");
      expect(remoteRef(bare, `refs/heads/${d.branch}`)).toBeUndefined();
      expect(remoteRef(bare, `refs/heads/change/${CHANGE}`)).toBeUndefined();
      expect(r.notes.at(-1)).toMatch(/^The PR wasn't raised: git push failed/);
    },
    T,
  );

  it(
    "keeps a task raisable when its PR can't be opened, and raises it on the next click",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      const d = await draft(root, "1.2");
      const host = new MockGitHost([{ repo: "forge-ledger" }]);
      host.failNext("unavailable", "createPullRequest");
      const r1 = await raiseTaskPr(root, CHANGE, "1.2", {
        approval: APPROVAL,
        git,
        gitHost: host,
        now,
      });
      expect(r1.state).toBe("built");
      expect(r1.commit).toBe(d.commit);
      expect(r1.notes.at(-1)).toMatch(
        /^The PR wasn't raised: .*createPullRequest.* The build still passes: fix that and raise the task's PR again/,
      );
      expect((await readTaskRun(root, CHANGE, "1.2"))?.state).toBe("built");
      const r2 = await raiseTaskPr(root, CHANGE, "1.2", {
        approval: APPROVAL,
        git,
        gitHost: host,
        now,
      });
      expect(r2.state).toBe("pr-open");
      expect(r2.pr?.number).toBe(1);
    },
    T,
  );

  it(
    "keeps a pr-level run's build when its push is refused, so its PR can be raised afterwards",
    async () => {
      const { root, remotes } = await speckitRoot({ repos: ["forge-ledger"] });
      const hook = join(remotes["forge-ledger"]!, "hooks", "pre-receive");
      await writeFile(hook, `#!/bin/sh\necho "the proxy is down" >&2\nexit 1\n`);
      await chmod(hook, 0o755);
      const host = new MockGitHost([{ repo: "forge-ledger" }]);
      const r = await runTask(root, CHANGE, "1.2", {
        level: "pr",
        by: "dev",
        approval: APPROVAL,
        runtime: new MockRuntime(answer(LIMITS), { now }),
        git,
        gitHost: host,
        now,
        commands: ok,
      });
      expect(r.state).toBe("built");
      expect(r.notes.at(-1)).toMatch(/^The PR wasn't raised: git push failed.*hook declined/);
      await writeFile(hook, `#!/bin/sh\nexit 0\n`);
      const raised = await raiseTaskPr(root, CHANGE, "1.2", {
        approval: APPROVAL,
        git,
        gitHost: host,
        now,
      });
      expect(raised.state).toBe("pr-open");
    },
    T,
  );

  it(
    "refuses to raise a branch with commits the build didn't check, and changes nothing",
    async () => {
      const { root, remotes } = await speckitRoot({ repos: ["forge-ledger"] });
      const d = await draft(root, "1.2");
      const wt = join(root, d.worktree);
      await writeFile(join(wt, "EXTRA.txt"), "not built\n");
      sh(wt, "add", "EXTRA.txt");
      sh(wt, "commit", "-qm", "after the build");
      const head = sh(wt, "rev-parse", "HEAD");
      const host = new MockGitHost([{ repo: "forge-ledger" }]);
      const before = await readTaskRun(root, CHANGE, "1.2");
      await expect(
        raiseTaskPr(root, CHANGE, "1.2", { approval: APPROVAL, git, gitHost: host, now }),
      ).rejects.toThrow(
        `Task 1.2's branch ${d.branch} has commits that weren't built (it is at ${head.slice(0, 12)}; the build passed at ${d.commit!.slice(0, 12)}): run the task again so its build checks them, or push ${d.branch} and open its PR into change/${CHANGE} yourself.`,
      );
      expect(await readTaskRun(root, CHANGE, "1.2")).toEqual(before);
      expect(remoteRef(remotes["forge-ledger"]!, `refs/heads/${d.branch}`)).toBeUndefined();
      expect(host.journal.filter((c) => c.method === "createPullRequest")).toHaveLength(0);
    },
    T,
  );

  it(
    "refuses to run a task again while its PR is open, and runs it once the PR is closed",
    async () => {
      const { root, remotes } = await speckitRoot({ repos: ["forge-ledger"] });
      await draft(root, "1.2", LIMITS, "a");
      const host = new MockGitHost([{ repo: "forge-ledger" }]);
      const r1 = await raiseTaskPr(root, CHANGE, "1.2", {
        approval: APPROVAL,
        git,
        gitHost: host,
        now,
      });
      expect(r1.state).toBe("pr-open");
      const again = () =>
        runTask(root, CHANGE, "1.2", {
          level: "draft",
          by: "dev",
          runtime: new MockRuntime(answer(LIMITS, "b"), { now }),
          git,
          gitHost: host,
          now,
          commands: ok,
        });
      await expect(again()).rejects.toThrow(
        `Task 1.2's PR is open (${r1.pr!.url}): running the task again would start over beside it. Merge or close the PR first, then run the task again.`,
      );
      const kept = await readTaskRun(root, CHANGE, "1.2");
      expect(kept).toMatchObject({ state: "pr-open", pr: r1.pr });
      // Closed on the host: review round 48, its branch still has the closed PR's commits, so
      // the task is refused until the person removes them (Atticus deletes nothing).
      await host.closePullRequest("forge-ledger", r1.pr!.number, APPROVAL);
      await expect(again()).rejects.toThrow(
        `Task 1.2's earlier PR ${r1.pr!.url} is closed, and its branch task/${CHANGE}/1.2 still has the commits that PR carried`,
      );
      const clone = join(root, "workspace/forge-ledger");
      sh(clone, "worktree", "remove", "--force", join(root, r1.worktree));
      sh(clone, "branch", "-D", `task/${CHANGE}/1.2`);
      sh(remotes["forge-ledger"]!, "update-ref", "-d", `refs/heads/task/${CHANGE}/1.2`);
      // Then the task runs again, and says what became of the earlier PR.
      const r2 = await again();
      expect(r2.state).toBe("built");
      expect(r2.notes).toContain(`Its earlier PR ${r1.pr!.url} is closed.`);
    },
    T,
  );

  it(
    "refuses a re-run of a pr-open task when the Git host can't say whether its PR is still open",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      await draft(root, "1.2", LIMITS, "a");
      const host = new MockGitHost([{ repo: "forge-ledger" }]);
      const r1 = await raiseTaskPr(root, CHANGE, "1.2", {
        approval: APPROVAL,
        git,
        gitHost: host,
        now,
      });
      host.failNext("unavailable", "getPullRequest");
      await expect(
        runTask(root, CHANGE, "1.2", {
          level: "draft",
          by: "dev",
          runtime: new MockRuntime(answer(LIMITS, "b"), { now }),
          git,
          gitHost: host,
          now,
          commands: ok,
        }),
      ).rejects.toThrow(
        new RegExp(
          `^Task 1\\.2's PR is open \\(${r1.pr!.url.replace(/[.]/g, "\\.")}\\).*Atticus couldn't ask the Git host whether it still is`,
        ),
      );
      expect((await readTaskRun(root, CHANGE, "1.2"))?.pr).toEqual(r1.pr);
    },
    T,
  );
});
