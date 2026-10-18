import { describe, expect, it } from "vitest";
import { ManualGitHost, memoryStepStore, recordStep } from "@maycombhq/adapters";
import { changeStore, handoff, newChange, syncHandoff } from "../src/index.js";
import { FEATURE_OWNERS, REPO, approval, copyPhase, forgeMetarepo } from "./helpers.js";

/**
 * A hand-off PR opened through the manual Git host has a placeholder link until the person
 * records the real one. `change sync` refreshes the hand-off's PR link and number from the
 * host, so change.yaml stops pointing at manual://.
 */
describe("change sync refreshes the hand-off's pull request", () => {
  it("replaces the manual:// placeholder with the link the person recorded", async () => {
    const root = await forgeMetarepo();
    const ID = "add-transfer-limit";
    await newChange(root, {
      title: "Add transfer limit",
      type: "feature",
      by: "pat",
      owners: FEATURE_OWNERS,
      systems: ["portal", "ledger"],
      now: "2026-10-19T09:00:00Z",
    });
    await copyPhase(root, ID, `${ID}/define`);
    const store = memoryStepStore();
    const gitHost = new ManualGitHost({ store, now: () => "2026-10-19T10:00:00Z" });
    const h = await handoff(root, ID, {
      gitHost,
      repo: REPO,
      by: "pat",
      approval: approval("pat", "2026-10-19T10:00:00Z"),
      now: "2026-10-19T10:00:00Z",
    });
    expect(h.pr.url).toBe(`manual://git-host/${REPO}/pull/1`);

    const [open] = await store.list({ action: "open-pull-request" });
    await recordStep(store, open!.id, {
      by: "pat",
      at: "2026-10-19T10:05:00Z",
      values: { url: `https://git.example.com/${REPO}/pull/41`, number: 41 },
    });
    const s = await syncHandoff(root, ID, { gitHost, repo: REPO, now: "2026-10-19T10:10:00Z" });
    expect(s.handoff.pr).toEqual({ number: 1, url: `https://git.example.com/${REPO}/pull/41` });
    const saved = (await changeStore(root).read(ID)).handoffs.at(-1)!;
    expect(saved.pr.url).toBe(`https://git.example.com/${REPO}/pull/41`);
  });
});
