import { expect, it } from "vitest";
import { changeStore, handoff, newChange } from "../src/index.js";
import { FEATURE_OWNERS, REPO, approval, copyPhase, forgeMetarepo, host } from "./helpers.js";

/**
 * ADR 0189: a hand-off is reviewed by the next role. The define hand-off names the change's
 * architects (the audit: "### Reviewers - None"), and one with no next owner says whom to name.
 */

const ID = "add-transfer-limit";
const T = (h: string) => `2026-10-19T${h}:00Z`;

it("names the next role's owners as the define hand-off's reviewers, in its PR too", async () => {
  const root = await forgeMetarepo();
  const gh = host();
  await newChange(root, {
    title: "Add transfer limit",
    type: "feature",
    by: "pat",
    owners: FEATURE_OWNERS,
    systems: ["ledger", "portal"],
    now: T("09:00"),
  });
  await copyPhase(root, ID, `${ID}/define`);
  const h = await handoff(root, ID, {
    gitHost: gh,
    repo: REPO,
    by: "pat",
    approval: approval("pat", T("10:00")),
    now: T("10:00"),
  });
  expect(h.reviewers).toEqual(expect.arrayContaining(["ari", "avery"]));
  const pr = await gh.getPullRequest(REPO, h.pr.number);
  expect(pr.body).toContain("- @ari (architect)");
  expect((await changeStore(root).read(ID)).handoffs[0]!.reviewers).toContain("ari");
});

it("says whom to name when the change names no next owner", async () => {
  const root = await forgeMetarepo();
  const gh = host();
  await newChange(root, {
    title: "Add transfer limit",
    type: "feature",
    by: "pat",
    owners: { "product-owner": ["pat"] },
    systems: ["ledger", "portal"],
    now: T("09:00"),
  });
  await copyPhase(root, ID, `${ID}/define`);
  const h = await handoff(root, ID, {
    gitHost: gh,
    repo: REPO,
    by: "pat",
    approval: approval("pat", T("10:00")),
    now: T("10:00"),
  });
  const pr = await gh.getPullRequest(REPO, h.pr.number);
  if (h.reviewers.length === 0)
    expect(pr.body).toContain("name the architect under the change's owners");
});
