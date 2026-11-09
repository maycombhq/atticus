import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AdapterError, MockGitHost } from "@maycombhq/adapters";
import {
  changeStore,
  handoff,
  newChange,
  returnToPo,
  type HandoffPublisher,
} from "../src/index.js";
import { FEATURE_OWNERS, REPO, approval, copyPhase, forgeMetarepo } from "./helpers.js";

/**
 * Review round 48 (tasks and Git host): raising a hand-off again is safe. A PR the host opened
 * without the answer reaching Atticus is recorded, a resubmit waits for the returned PR to be
 * closed on the host, and a re-run that changes nothing posts no "updated" comment.
 */

const ID = "add-transfer-limit";
const BRANCH = `handoff/${ID}/define`;

async function drafted(): Promise<string> {
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
  return root;
}

const raise = (root: string, gitHost: MockGitHost, publisher?: HandoffPublisher) =>
  handoff(root, ID, {
    gitHost,
    repo: REPO,
    by: "pat",
    approval: approval("pat", "2026-10-19T10:00:00Z"),
    now: "2026-10-19T10:00:00Z",
    ...(publisher ? { publisher } : {}),
  });

const comments = (gh: MockGitHost) => gh.journal.filter((c) => c.method === "comment");

describe("hand-off PRs raised again (review round 48)", () => {
  it("records the open PR the host made when its answer was lost", async () => {
    const root = await drafted();
    const gh = new MockGitHost([{ repo: REPO }]);
    const real = gh.createPullRequest.bind(gh);
    let first = true;
    gh.createPullRequest = async (i, a) => {
      const pr = await real(i, a);
      if (first) {
        first = false;
        throw new AdapterError("git-host", "unavailable", "timeout reading the response");
      }
      return pr;
    };
    await expect(raise(root, gh)).rejects.toThrow(/timeout reading the response/);
    const h = await raise(root, gh);
    expect(h).toMatchObject({ phase: "define", branch: BRANCH, state: "open", pr: { number: 1 } });
    expect((await gh.listPullRequests(REPO, {})).length).toBe(1);
    const change = await changeStore(root).read(ID);
    expect(change.handoffs.map((x) => x.pr.number)).toEqual([1]);
  });

  it("refuses a resubmit while the returned hand-off's PR is still open on the host", async () => {
    const root = await drafted();
    const gh = new MockGitHost([{ repo: REPO }]);
    await raise(root, gh);
    // A host that can't close PRs: Return to PO asks a person to, with a comment.
    const close = gh.closePullRequest.bind(gh);
    (gh as { closePullRequest?: unknown }).closePullRequest = undefined;
    const back = await returnToPo(root, ID, {
      gitHost: gh,
      repo: REPO,
      by: "ari",
      reason: "Scope unclear",
      approval: approval("ari", "2026-10-19T11:00:00Z"),
      now: "2026-10-19T11:00:00Z",
    });
    expect(back.closedOnHost).toBe(false);
    const published: string[] = [];
    const publisher: HandoffPublisher = {
      publish: async (i) => {
        published.push(i.branch);
        return { commit: "a".repeat(40) };
      },
    };
    await expect(raise(root, gh, publisher)).rejects.toThrow(
      `PR #1 from ${BRANCH} is still open on the Git host (https://git.example.com/${REPO}/pull/1): close it there first (the return asked for that), then resubmit the change.`,
    );
    expect(published).toEqual([]);
    expect((await changeStore(root).read(ID)).state).toBe("returned");
    await close(REPO, 1, approval("ari", "2026-10-19T11:00:00Z"));
    const h = await raise(root, gh, publisher);
    expect(h.pr.number).toBe(2);
    expect(published).toEqual([BRANCH]);
  });

  it("posts no 'updated' comment when a re-run changed nothing, and one when it did", async () => {
    const root = await drafted();
    const gh = new MockGitHost([{ repo: REPO }]);
    await raise(root, gh);
    await raise(root, gh);
    expect(comments(gh)).toHaveLength(0);
    await appendFile(join(root, "openspec/changes", ID, "brief.md"), "\nOne more line.\n");
    await raise(root, gh);
    expect(comments(gh)).toHaveLength(1);
    expect(comments(gh)[0]!.args[2]).toBe("pat updated the hand-off for another review.");
  });

  it("takes the publisher's word that the branch didn't move", async () => {
    const root = await drafted();
    const gh = new MockGitHost([{ repo: REPO }]);
    let changed = true;
    const publisher: HandoffPublisher = {
      publish: async () => ({ commit: "b".repeat(40), changed }),
    };
    await raise(root, gh, publisher);
    changed = false;
    await appendFile(join(root, "openspec/changes", ID, "brief.md"), "\nOne more line.\n");
    await raise(root, gh, publisher);
    expect(comments(gh)).toHaveLength(0);
    changed = true;
    await raise(root, gh, publisher);
    expect(comments(gh)).toHaveLength(1);
  });
});
