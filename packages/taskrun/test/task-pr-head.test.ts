import { describe, expect, it } from "vitest";
import { MockGitHost } from "@maycombhq/adapters";
import { MockRuntime } from "@maycombhq/ai";
import { previewTaskRun, raiseTaskPr, runTask, taskPrState } from "../src/index.js";
import { CHANGE, git, speckitRoot } from "./helpers.js";

/**
 * Review round 44: a Git host that answers a task's PR number with another branch's PR (a manual
 * host's recorded number equal to another PR's, a number a person got wrong) never decides
 * whether the task is held: the task's own PR is read by its branch instead.
 */

const T = 180_000;
const now = () => new Date("2026-11-08T09:00:00Z");
const APPROVAL = { by: "dev", at: "2026-11-08T09:00:00Z", ref: "task PRs (review round 44)" };
const ok = async () => ({ exitCode: 0, stdout: "BUILD OK", stderr: "" });
const LIMITS = "src/main/java/forge/ledger/TransferLimits.java";
const OTHER = `task/${CHANGE}/1.3`;

/** Task 1.2 drafted and its PR raised; another branch's PR closed; the host mixes them up. */
async function mixedUp() {
  const { root } = await speckitRoot({ repos: ["forge-ledger"] });
  await runTask(root, CHANGE, "1.2", {
    level: "draft",
    by: "dev",
    runtime: new MockRuntime(
      () => `Done.\n\n=== file: ${LIMITS}\npackage forge.ledger;\n\nclass X {}\n=== end file\n`,
      { now },
    ),
    git,
    now,
    commands: ok,
  });
  const host = new MockGitHost([{ repo: "forge-ledger" }]);
  const r = await raiseTaskPr(root, CHANGE, "1.2", { approval: APPROVAL, git, gitHost: host, now });
  const other = await host.createPullRequest(
    { repo: "forge-ledger", head: OTHER, base: `change/${CHANGE}`, title: "1.3", body: "" },
    APPROVAL,
  );
  await host.closePullRequest("forge-ledger", other.number, APPROVAL);
  const real = host.getPullRequest.bind(host);
  host.getPullRequest = (repo, n) => real(repo, n === r.pr!.number ? other.number : n);
  return { root, host };
}

describe("a task's PR is only ever its own branch's (review round 44)", () => {
  it(
    "reads the task's PR by its branch when the host answers with another's: still open",
    async () => {
      const { root, host } = await mixedUp();
      expect(await taskPrState(root, CHANGE, "1.2", { gitHost: host })).toBe("open");
      await expect(previewTaskRun(root, CHANGE, "1.2", { gitHost: host })).rejects.toThrow(
        /^Task 1\.2's PR is open/,
      );
    },
    T,
  );

  it(
    "says nothing, and keeps the task held, when the host has no PR from the task's branch",
    async () => {
      const { root, host } = await mixedUp();
      host.listPullRequests = async () => [];
      expect(await taskPrState(root, CHANGE, "1.2", { gitHost: host })).toBeUndefined();
      const err = await previewTaskRun(root, CHANGE, "1.2", { gitHost: host }).catch(
        (e: unknown) => e,
      );
      expect((err as Error).message).toContain(
        `(Atticus couldn't ask the Git host whether it still is: PR #1 on the Git host is from ${OTHER}, not task/${CHANGE}/1.2, and no PR from task/${CHANGE}/1.2 was found.)`,
      );
    },
    T,
  );
});
