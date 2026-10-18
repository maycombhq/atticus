import { describe, expect, it } from "vitest";
import { ManualGitHost, MockGitHost, memoryStepStore, type GitHost } from "@maycombhq/adapters";
import { handoff, newChange, returnToPo } from "../src/index.js";
import { FEATURE_OWNERS, REPO, approval, copyPhase, forgeMetarepo } from "./helpers.js";

/** Return to PO closes the hand-off PR through C4 closePullRequest (ADR 0041). */

const ID = "add-transfer-limit";

async function handedOff(gitHost: GitHost): Promise<string> {
  const root = await forgeMetarepo();
  await newChange(root, {
    title: "Add transfer limit",
    type: "feature",
    by: "pat",
    owners: FEATURE_OWNERS,
    systems: ["portal", "ledger"],
    now: "2026-10-19T09:00:00Z",
  });
  await copyPhase(root, ID, `${ID}/define`);
  await handoff(root, ID, {
    gitHost,
    repo: REPO,
    by: "pat",
    approval: approval("pat", "2026-10-19T10:00:00Z"),
    now: "2026-10-19T10:00:00Z",
  });
  return root;
}

const back = (root: string, gitHost: GitHost) =>
  returnToPo(root, ID, {
    gitHost,
    repo: REPO,
    by: "ari",
    reason: "Scope unclear",
    approval: approval("ari", "2026-10-19T11:00:00Z"),
    now: "2026-10-19T11:00:00Z",
  });

describe("return to PO and the hand-off PR", () => {
  it("closes the PR on a host that can, with the returner's approval", async () => {
    const gh = new MockGitHost([{ repo: REPO }]);
    const root = await handedOff(gh);
    const r = await back(root, gh);
    expect(r).toMatchObject({ state: "returned", closedOnHost: true });
    expect(gh.journal.at(-1)).toMatchObject({
      method: "closePullRequest",
      args: [REPO, 1],
      approval: { by: "ari" },
    });
    expect((await gh.getPullRequest(REPO, 1)).state).toBe("closed");
  });

  it("leaves closing to a person on the manual host, as a step", async () => {
    const store = memoryStepStore();
    const gh = new ManualGitHost({ store, now: () => "2026-10-19T11:00:00Z" });
    const root = await handedOff(gh);
    const r = await back(root, gh);
    expect(r).toMatchObject({ state: "returned", closedOnHost: false });
    expect((await store.list({ action: "close-pull-request" })).map((s) => s.id)).toEqual([
      "close-pr-1",
    ]);
  });
});
