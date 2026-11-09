import { describe, expect, it } from "vitest";
import { ManualGitHost, memoryStepStore, recordStep } from "../src/index.js";

/**
 * App-only audit (manual Git host): a "Post a comment on the PR" step left open once the PR is
 * merged (or closed) on the host has nothing left to do: it is closed with why, as its reviews
 * step is, the next time Atticus reads the PR.
 */
const REPO = "forge/forge-metarepo";
const NOW = "2026-11-09T09:00:00Z";
const A = (by = "pat") => ({ by, at: NOW, ref: "hand-off" });
const pr = {
  repo: REPO,
  head: "handoff/add-transfer-limit/plan",
  base: "main",
  title: "Add transfer limit: Plan ready",
  body: "## Hand-off",
};

describe("a comment step on a manual Git host's PR", () => {
  it("is closed with why once the PR reads merged", async () => {
    const store = memoryStepStore();
    const gh = new ManualGitHost({ store, now: () => NOW });
    const p = await gh.createPullRequest(pr, A());
    const [open] = await store.list({ action: "open-pull-request" });
    await recordStep(store, open!.id, {
      by: "pat",
      at: NOW,
      values: { url: "https://git.forge.example/forge/forge-metarepo/pull/9", number: 9 },
    });
    await gh.comment(REPO, p.number, "pat updated the hand-off for another review.", A());
    const [comment] = await store.list({ action: "comment-pull-request" });
    expect(comment?.state).toBe("open");
    const report = (await store.list({ action: "report-pull-request" })).find(
      (s) => s.state === "open",
    )!;
    await recordStep(store, report.id, {
      by: "pat",
      at: NOW,
      values: { approvers: ["ari"], checksPassing: true, merged: true },
    });
    expect((await gh.getPullRequest(REPO, p.number)).state).toBe("merged");
    const after = (await store.list({ action: "comment-pull-request" }))[0]!;
    expect(after.state).toBe("skipped");
    expect(after.recorded?.note).toMatch(/is merged on the Git host: nothing left to post/);
  });
});
