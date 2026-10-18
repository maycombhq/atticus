import { describe, expect, it } from "vitest";
import {
  AdapterError,
  ManualGitHost,
  MockGitHost,
  memoryStepStore,
  recordStep,
  type GitHost,
} from "../src/index.js";

/**
 * C4 `GitHost.closePullRequest` (ADR 0041): closing a PR is a write, so it needs an approval;
 * the mock closes it, and the manual host makes it a step for a person.
 */

const REPO = "forge/forge-metarepo";
const A = (by = "ari", at = "2026-10-20T09:00:00Z") => ({ by, at, ref: "return to PO" });
const pr = {
  repo: REPO,
  head: "handoff/add-transfer-limit/design",
  base: "main",
  title: "Add transfer limit: Approve design",
  body: "## Hand-off",
};

describe("closing a pull request", () => {
  it("the mock closes an open PR, with an approval, and refuses a merged one", async () => {
    const gh = new MockGitHost([{ repo: REPO }]);
    const host: GitHost = gh;
    const p = await gh.createPullRequest(pr, A());
    await expect(host.closePullRequest!(REPO, p.number, undefined as never)).rejects.toBeInstanceOf(
      AdapterError,
    );
    const closed = await host.closePullRequest!(REPO, p.number, A());
    expect(closed.state).toBe("closed");
    expect(gh.journal.at(-1)).toMatchObject({
      method: "closePullRequest",
      args: [REPO, p.number],
      approval: { by: "ari" },
    });
    expect((await gh.getPullRequest(REPO, p.number)).state).toBe("closed");

    const q = await gh.createPullRequest({ ...pr, head: "handoff/x/plan" }, A());
    gh.review(REPO, q.number, "tia", "approved");
    await gh.merge(REPO, q.number, A());
    await expect(gh.closePullRequest(REPO, q.number, A())).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("the manual host makes closing a step, and the PR reads closed once a person does it", async () => {
    const store = memoryStepStore();
    const gh = new ManualGitHost({ store, now: () => "2026-10-20T09:00:00Z" });
    const p = await gh.createPullRequest(pr, A("pat"));
    const r = await gh.closePullRequest(REPO, p.number, A());
    expect(r.state).not.toBe("closed");
    const [step] = await store.list({ action: "close-pull-request" });
    expect(step).toMatchObject({
      id: `close-pr-${p.number}`,
      change: "add-transfer-limit",
      approval: { by: "ari" },
      state: "open",
    });
    // Asking again doesn't make a second step.
    await gh.closePullRequest(REPO, p.number, A());
    expect(await store.list({ action: "close-pull-request" })).toHaveLength(1);
    // The person opened the PR earlier, and now closes it.
    const [opened] = await store.list({ action: "open-pull-request" });
    await recordStep(store, opened!.id, {
      by: "pat",
      values: { url: `https://git.example.com/${REPO}/pull/7`, number: 7 },
    });
    await recordStep(store, step!.id, { by: "ari" });
    expect((await gh.getPullRequest(REPO, p.number)).state).toBe("closed");
  });
});
