import { describe, expect, it } from "vitest";
import { ManualGitHost, memoryStepStore, recordStep, type MockGitHost } from "@maycombhq/adapters";
import { ChangeError, changeStore, handoff, newChange, syncHandoff } from "../src/index.js";
import { FEATURE_OWNERS, REPO, approval, copyPhase, forgeMetarepo, host } from "./helpers.js";

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
    // Seventh UX walk: the PR goes by the number the person recorded, not Atticus's local one.
    expect(s.handoff.pr).toEqual({ number: 41, url: `https://git.example.com/${REPO}/pull/41` });
    const saved = (await changeStore(root).read(ID)).handoffs.at(-1)!;
    expect(saved.pr).toEqual({ number: 41, url: `https://git.example.com/${REPO}/pull/41` });

    // A sync after that still finds the PR by its recorded number.
    const again = await syncHandoff(root, ID, { gitHost, repo: REPO, now: "2026-10-19T10:20:00Z" });
    expect(again.handoff.pr.number).toBe(41);
  });
});

/**
 * Review round 44: a Git host that hands back another branch's PR for the number the hand-off
 * holds never moves the change on that PR, or rewrites its link to that PR's.
 */
describe("change sync uses only the hand-off's own PR", () => {
  const ID = "add-transfer-limit";
  const OTHER = "handoff/change-z/plan";

  async function raised(gitHost: MockGitHost) {
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
    const h = await handoff(root, ID, {
      gitHost,
      repo: REPO,
      by: "pat",
      approval: approval("pat", "2026-10-19T10:00:00Z"),
      now: "2026-10-19T10:00:00Z",
    });
    // Another change's PR, merged on the host.
    const z = await gitHost.createPullRequest(
      { repo: REPO, head: OTHER, base: "main", title: "Z", body: "z" },
      approval("lee", "2026-10-19T10:00:00Z"),
    );
    gitHost.review(REPO, z.number, "tia", "approved");
    await gitHost.merge(REPO, z.number, approval("tia", "2026-10-19T10:00:00Z"));
    // The host now answers the hand-off's number with Z's PR.
    const real = gitHost.getPullRequest.bind(gitHost);
    gitHost.getPullRequest = (repo, n) => real(repo, n === h.pr.number ? z.number : n);
    return { root, h, z };
  }

  it("reads its own PR by its branch instead, and the gate doesn't move", async () => {
    const gitHost = host();
    const { root, h } = await raised(gitHost);
    const s = await syncHandoff(root, ID, { gitHost, repo: REPO, now: "2026-10-19T10:10:00Z" });
    expect(s.merged).toBe(false);
    expect(s.handoff.pr).toEqual(h.pr);
    const saved = await changeStore(root).read(ID);
    expect(saved.state).toBe("define");
    expect(saved.handoffs.at(-1)!.pr).toEqual(h.pr);
  });

  it("refuses when the host has no PR from the hand-off's branch", async () => {
    const gitHost = host();
    const { root, h, z } = await raised(gitHost);
    gitHost.listPullRequests = async () => [];
    const err = await syncHandoff(root, ID, {
      gitHost,
      repo: REPO,
      now: "2026-10-19T10:10:00Z",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChangeError);
    expect((err as Error).message).toBe(
      `PR #${h.pr.number} on the Git host is from ${OTHER}, not handoff/${ID}/define, and no PR from handoff/${ID}/define was found: Atticus uses only the hand-off's own PR. Check the PR's number on the Git host (on a manual host, on its step: atticus todo), then sync again.`,
    );
    const saved = await changeStore(root).read(ID);
    expect(saved.state).toBe("define");
    expect(saved.handoffs.at(-1)!.pr).toEqual(h.pr);
    expect(z.number).not.toBe(h.pr.number);
  });
});
