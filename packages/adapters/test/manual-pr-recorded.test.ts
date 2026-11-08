import { describe, expect, it } from "vitest";
import { ManualGitHost, memoryStepStore, recordStep } from "../src/index.js";

/**
 * Seventh UX walk (tasks and manual steps): a manual Git host's PR goes by the number and link
 * the person recorded once they have, its steps are named by their branch, and its merge can be
 * recorded on the same step as its reviews.
 */

const A = (by = "pat") => ({ by, at: "2026-11-08T09:00:00Z", ref: "test" });
const now = () => "2026-11-08T09:00:00Z";
const META = "forge/forge-metarepo";
const CODE = "forge-ledger";
const handoff = {
  repo: META,
  head: "handoff/add-transfer-limit/plan",
  base: "main",
  title: "Add a daily transfer limit: Plan ready",
  body: "## Hand-off",
};
const task = {
  repo: CODE,
  head: "task/add-transfer-limit/1.1",
  base: "change/add-transfer-limit",
  title: "Add the limit check (task 1.1 of add-transfer-limit)",
  body: "Task 1.1",
};

async function opened(gh: ManualGitHost, store: ReturnType<typeof memoryStepStore>) {
  await gh.createPullRequest(task, A("bao"));
  const open = (await store.list({ action: "open-pull-request" }))[0]!;
  await recordStep(store, open.id, {
    by: "bao",
    values: { url: "https://git.forge.example/forge/forge-ledger/pull/7", number: "7" },
  });
  return open;
}

describe("manual Git host: the PR the person recorded", () => {
  it("names each PR's steps by its branch, so a task's never collide with the metarepo's", async () => {
    const store = memoryStepStore();
    const gh = new ManualGitHost({ store, now });
    await gh.createPullRequest(handoff, A("bao"));
    await gh.createPullRequest(task, A("bao"));
    const reports = await store.list({ action: "report-pull-request" });
    expect(reports.map((s) => s.id)).toEqual([
      "report-pr-handoff-add-transfer-limit-plan",
      "report-pr-task-add-transfer-limit-1-1",
    ]);
    // No number the person hasn't recorded is said: the PR is named by its branch.
    expect(reports[1]!.title).toBe(
      "Record the reviews and checks on the PR from task/add-transfer-limit/1.1 (Add the limit check (task 1.1 of add-transfer-limit)), and whether it merged",
    );
  });

  it("goes by the recorded number and link once the person records them", async () => {
    const store = memoryStepStore();
    const gh = new ManualGitHost({ store, now });
    const p = await gh.createPullRequest(task, A("bao"));
    expect(p).toMatchObject({ number: 1, url: "manual://git-host/forge-ledger/pull/1" });
    await recordStep(store, "open-pr-task-add-transfer-limit-1-1", {
      by: "bao",
      values: { url: "https://git.forge.example/forge/forge-ledger/pull/7", number: "7" },
    });
    const byRecorded = await gh.getPullRequest(CODE, 7);
    expect(byRecorded).toMatchObject({
      number: 7,
      url: "https://git.forge.example/forge/forge-ledger/pull/7",
      head: task.head,
      state: "open",
    });
    // A caller that kept the number Atticus gave first still finds it.
    expect((await gh.getPullRequest(CODE, 1)).number).toBe(7);
    // The next PR's own number doesn't take a number a person recorded.
    const next = await gh.createPullRequest(
      { ...task, head: "task/add-transfer-limit/1.2", title: "Task 1.2" },
      A("bao"),
    );
    expect(next.number).toBe(8);
  });

  it("records merged on the reviews step: the PR reads merged, with no Merge step", async () => {
    const store = memoryStepStore();
    const gh = new ManualGitHost({ store, now });
    await opened(gh, store);
    const report = (await store.list({ action: "report-pull-request" }))[0]!;
    expect(report.result.map((f) => [f.name, f.format, f.required])).toEqual([
      ["approvers", "handles", false],
      ["changesRequestedBy", "handles", false],
      ["checksPassing", "yes-no", true],
      ["merged", "yes-no", false],
    ]);
    await recordStep(store, report.id, {
      by: "bao",
      values: { approvers: "tia", checksPassing: "yes", merged: "yes" },
    });
    expect((await gh.getPullRequest(CODE, 7)).state).toBe("merged");
    expect((await gh.merge(CODE, 7, A("tia"))).state).toBe("merged");
    expect(await store.list({ action: "merge-pull-request" })).toEqual([]);
  });

  it("asks when a task's PR merges once its reviews are recorded without it", async () => {
    const store = memoryStepStore();
    const gh = new ManualGitHost({ store, now });
    await opened(gh, store);
    await recordStep(store, "report-pr-task-add-transfer-limit-1-1", {
      by: "bao",
      values: { approvers: "tia", checksPassing: "yes" },
    });
    expect((await gh.getPullRequest(CODE, 7)).state).toBe("open");
    const again = await store.list({ action: "report-pull-request", state: "open" });
    expect(again.map((s) => [s.id, s.title])).toEqual([
      [
        "report-pr-task-add-transfer-limit-1-1-2",
        "Record that PR #7 (Add the limit check (task 1.1 of add-transfer-limit)) merged, or its reviews again",
      ],
    ]);
    // Asked once: reading it again doesn't add another.
    await gh.getPullRequest(CODE, 7);
    expect((await store.list({ action: "report-pull-request", state: "open" })).length).toBe(1);
    await recordStep(store, again[0]!.id, {
      by: "bao",
      values: { checksPassing: "yes", merged: "yes" },
    });
    expect((await gh.getPullRequest(CODE, 7)).state).toBe("merged");
  });

  it("a hand-off's PR waits for its Merge step instead (the gate checks approvals first)", async () => {
    const store = memoryStepStore();
    const gh = new ManualGitHost({ store, now });
    await gh.createPullRequest(handoff, A("bao"));
    await recordStep(store, "open-pr-handoff-add-transfer-limit-plan", {
      by: "bao",
      values: { url: "https://git.forge.example/forge/forge-metarepo/pull/4", number: 4 },
    });
    await recordStep(store, "report-pr-handoff-add-transfer-limit-plan", {
      by: "bao",
      values: { approvers: "tia", checksPassing: "yes" },
    });
    await gh.getPullRequest(META, 4);
    expect(await store.list({ action: "report-pull-request", state: "open" })).toEqual([]);
    const refused = await gh.merge(META, 4, A("tia")).catch((e: Error) => e);
    expect((refused as Error).message).toBe(
      "git-host: a person merges PR #4 on the Git host: do step merge-pr-handoff-add-transfer-limit-plan (atticus todo), then sync again",
    );
  });

  it("skips a reviews step still open once the PR reads merged", async () => {
    const store = memoryStepStore();
    const gh = new ManualGitHost({ store, now });
    await gh.createPullRequest(handoff, A("bao"));
    await recordStep(store, "open-pr-handoff-add-transfer-limit-plan", {
      by: "bao",
      values: { url: "https://git.forge.example/forge/forge-metarepo/pull/4", number: 4 },
    });
    await recordStep(store, "report-pr-handoff-add-transfer-limit-plan", {
      by: "bao",
      values: { approvers: "tia", checksPassing: "yes" },
    });
    await gh.merge(META, 4, A("tia")).catch(() => undefined);
    await gh.comment(META, 4, "bao updated the hand-off for another review.", A("bao"));
    expect((await store.list({ action: "report-pull-request", state: "open" })).length).toBe(1);
    await recordStep(store, "merge-pr-handoff-add-transfer-limit-plan", { by: "tia" });
    expect((await gh.getPullRequest(META, 4)).state).toBe("merged");
    const left = await store.list({ action: "report-pull-request" });
    expect(left.map((s) => [s.state, s.recorded?.note])).toEqual([
      ["done", undefined],
      ["skipped", "PR #4 is merged on the Git host: nothing left to record."],
    ]);
  });
});
