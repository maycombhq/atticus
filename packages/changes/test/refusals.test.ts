import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { toCanonicalYaml } from "@maycombhq/core";
import type { GitHost, PullRequest } from "@maycombhq/adapters";
import {
  canAdvance,
  changeReport,
  changeStore,
  handoff,
  newChange,
  returnToPo,
  syncHandoff,
} from "../src/index.js";
import {
  FEATURE_OWNERS,
  REPO,
  ROLES_WITH_PRIVACY,
  approval,
  copyPhase,
  forgeMetarepo,
  passedRound,
  host,
} from "./helpers.js";

const ID = "add-transfer-limit";
const T = (h: string) => `2026-10-19T${h}:00Z`;

/** A feature change created and taken through Define, so it sits in Design. */
async function inDesign(
  root: string,
  gh: ReturnType<typeof host>,
  owners: Record<string, string[]> = FEATURE_OWNERS,
) {
  await newChange(root, {
    title: "Add transfer limit",
    type: "feature",
    by: "pat",
    owners,
    systems: ["ledger", "portal"],
    now: T("09:00"),
  });
  await copyPhase(root, ID, `${ID}/define`);
  await handoff(root, ID, {
    gitHost: gh,
    repo: REPO,
    by: "pat",
    approval: approval("pat", T("10:00")),
    now: T("10:00"),
  });
  gh.review(REPO, 1, "pat", "approved");
  await syncHandoff(root, ID, {
    gitHost: gh,
    repo: REPO,
    approval: approval("pat", T("11:00")),
    now: T("11:00"),
  });
  await copyPhase(root, ID, `${ID}/design`);
  await passedRound(root, ID, "design");
}

function finding(over: Record<string, unknown>) {
  return {
    schemaVersion: 1,
    id: "f1",
    kind: "issue",
    change: ID,
    gate: "design",
    round: 1,
    rule: "forge-arch-x",
    layer: "org",
    lens: "architecture",
    severity: "blocking",
    artifact: "design.md",
    locator: { heading: "Approach" },
    summary: "Something is wrong.",
    why: "Because.",
    fix: { text: "Fix it." },
    evidence: [{ source: "artifact", path: "design.md" }],
    waivable: true,
    state: "open",
    createdAt: T("12:00"),
    ...over,
  };
}

async function writeFinding(root: string, f: ReturnType<typeof finding>) {
  const dir = join(root, "openspec/changes", ID, "review", String(f.gate), String(f.round));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${String(f.id)}.yaml`), toCanonicalYaml(f));
}

describe("refusals", () => {
  it("refuses a hand-off with a missing or empty artifact", async () => {
    const root = await forgeMetarepo();
    const gh = host();
    await newChange(root, {
      title: "Add transfer limit",
      type: "feature",
      by: "pat",
      now: T("09:00"),
    });
    await copyPhase(root, ID, `${ID}/define`);
    await writeFile(
      join(root, "openspec/changes", ID, "proposal.md"),
      "# Proposal\n\n<!-- todo -->\n",
    );
    const e = await handoff(root, ID, {
      gitHost: gh,
      repo: REPO,
      by: "pat",
      approval: approval("pat", T("10:00")),
    }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: "refused" });
    expect((e as { reasons: unknown[] }).reasons).toEqual([
      expect.objectContaining({ code: "unfilled-artifact", artifact: "proposal" }),
    ]);
    expect(gh.journal).toEqual([]);
  });

  it("lets waived blocking findings and risks through, but stops open blocking findings and gaps", async () => {
    const root = await forgeMetarepo();
    const gh = host();
    await inDesign(root, gh);
    const by = { by: "ari", at: T("12:10") };
    await writeFinding(root, finding({ id: "old-round", round: 1 }));
    await writeFinding(
      root,
      finding({
        id: "waived",
        round: 2,
        state: "waived",
        resolution: { action: "waive", reason: "Accepted for now.", ...by },
      }),
    );
    await writeFinding(
      root,
      finding({ id: "a-risk", round: 2, severity: "risk", waivable: false }),
    );
    expect((await canAdvance(ID, root)).reasons.map((r) => r.code)).toEqual(["no-handoff"]);

    await writeFinding(
      root,
      finding({
        id: "gap",
        round: 2,
        kind: "knowledge-gap",
        severity: "gap",
        waivable: false,
        question: { text: "What is the Ledger timeout?", owner: "team-ledger" },
      }),
    );
    const r = await canAdvance(ID, root);
    expect(r.reasons.map((x) => [x.code, x.finding])).toEqual([
      ["open-gap", "gap"],
      ["no-handoff", undefined],
    ]);
  });

  it("reports an unreadable finding file instead of ignoring it", async () => {
    const root = await forgeMetarepo();
    const gh = host();
    await inDesign(root, gh);
    const dir = join(root, "openspec/changes", ID, "review/design/1");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "bad.yaml"), "schemaVersion: 1\nid: bad\n");
    const r = await canAdvance(ID, root);
    expect(r.reasons[0]).toMatchObject({ code: "bad-finding" });
  });

  it("refuses Design when personal data is touched and roles.yaml has no privacy role", async () => {
    const root = await forgeMetarepo({ personal: ["ledger-db.account.holder-name"] });
    const gh = host();
    await inDesign(root, gh);
    const report = await changeReport(root, ID);
    expect(report.privacy).toMatchObject({
      touched: true,
      records: [{ id: "ledger-db.account.holder-name", classification: "personal" }],
      role: "privacy-officer",
      roleDefined: false,
      phase: "design",
    });
    const e = await handoff(root, ID, {
      gitHost: gh,
      repo: REPO,
      by: "ari",
      approval: approval("ari", T("12:30")),
    }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: "refused" });
    expect((e as { reasons: { code: string; message: string }[] }).reasons).toEqual([
      expect.objectContaining({ code: "privacy-role-missing" }),
    ]);
    expect((e as { reasons: { message: string }[] }).reasons[0]!.message).toBe(
      "This change touches personal data (ledger-db.account.holder-name), so the privacy-officer role must approve it, but roles.yaml doesn't define that role.",
    );
  });

  it("requires the privacy role's approval when roles.yaml defines it", async () => {
    const root = await forgeMetarepo({
      personal: ["ledger-db.account.holder-name"],
      roles: ROLES_WITH_PRIVACY,
    });
    const gh = host();
    await inDesign(root, gh, { ...FEATURE_OWNERS, "privacy-officer": ["priya"] });
    await handoff(root, ID, {
      gitHost: gh,
      repo: REPO,
      by: "ari",
      approval: approval("ari", T("12:30")),
      now: T("12:30"),
    });
    expect((await changeReport(root, ID)).required.map((r) => r.label)).toEqual([
      "architect (change type feature, gate design)",
      "privacy-officer (personal data)",
    ]);
    gh.review(REPO, 2, "avery", "approved");
    const s = await syncHandoff(root, ID, {
      gitHost: gh,
      repo: REPO,
      approval: approval("avery", T("13:00")),
      now: T("13:00"),
    });
    expect(s.merged).toBe(false);
    expect(s.reasons).toEqual([
      expect.objectContaining({ code: "approval-missing", role: "privacy-officer" }),
    ]);
    gh.review(REPO, 2, "priya", "approved");
    expect(
      await syncHandoff(root, ID, {
        gitHost: gh,
        repo: REPO,
        approval: approval("avery", T("14:00")),
        now: T("14:00"),
      }),
    ).toMatchObject({ merged: true, state: "plan" });
  });

  it("names a role nobody holds on the change", async () => {
    const root = await forgeMetarepo();
    const gh = host();
    const noArchitect = Object.fromEntries(
      Object.entries(FEATURE_OWNERS).filter(([role]) => role !== "architect"),
    );
    await inDesign(root, gh, noArchitect);
    await handoff(root, ID, {
      gitHost: gh,
      repo: REPO,
      by: "ari",
      approval: approval("ari", T("12:30")),
      now: T("12:30"),
    });
    const r = await canAdvance(ID, root);
    expect(r.reasons[0]!.message).toBe(
      "Needs approval from architect (change type feature, gate design). Nobody holds architect on this change; add them under owners in change.yaml.",
    );
  });

  it("keeps the same PR when changes are requested, and updates it on the next hand-off", async () => {
    const root = await forgeMetarepo();
    const gh = host();
    await inDesign(root, gh);
    await handoff(root, ID, {
      gitHost: gh,
      repo: REPO,
      by: "ari",
      approval: approval("ari", T("12:30")),
      now: T("12:30"),
    });
    gh.review(REPO, 2, "avery", "changes-requested");
    const s = await syncHandoff(root, ID, {
      gitHost: gh,
      repo: REPO,
      approval: approval("avery", T("13:00")),
      now: T("13:00"),
    });
    expect(s).toMatchObject({ merged: false, state: "design" });
    expect(s.reasons[0]).toMatchObject({ code: "changes-requested", person: "avery" });
    let c = await changeStore(root).read(ID);
    expect(c.handoffs.at(-1)!.state).toBe("changes-requested");

    const again = await handoff(root, ID, {
      gitHost: gh,
      repo: REPO,
      by: "ari",
      approval: approval("ari", T("13:30")),
      now: T("13:30"),
    });
    expect(again.pr.number).toBe(2);
    expect(gh.journal.filter((j) => j.method === "createPullRequest")).toHaveLength(2);
    expect(gh.journal.at(-1)).toMatchObject({
      method: "comment",
      args: [REPO, 2, expect.any(String)],
    });
    c = await changeStore(root).read(ID);
    expect(c.handoffs.at(-1)!.state).toBe("open");
    expect(c.handoffs).toHaveLength(2);
  });

  it("returns a change to the product owner, closing the PR where the host can, then resubmits from Define", async () => {
    const root = await forgeMetarepo();
    const mock = host();
    const closed = new Set<number>();
    // The C4 Git host interface has no close yet; a host that offers one is used.
    const gh: GitHost & { closePullRequest(repo: string, n: number): Promise<PullRequest> } = {
      getRepo: (r) => mock.getRepo(r),
      getPullRequest: async (r, n) => {
        const pr = await mock.getPullRequest(r, n);
        return closed.has(n) ? { ...pr, state: "closed" } : pr;
      },
      listPullRequests: (r, q) => mock.listPullRequests(r, q),
      createPullRequest: (i, a) => mock.createPullRequest(i, a),
      comment: (r, n, b, a) => mock.comment(r, n, b, a),
      merge: (r, n, a) => mock.merge(r, n, a),
      closePullRequest: async (r, n) => {
        closed.add(n);
        return { ...(await mock.getPullRequest(r, n)), state: "closed" };
      },
    };
    await inDesign(root, mock);
    await handoff(root, ID, {
      gitHost: gh,
      repo: REPO,
      by: "ari",
      approval: approval("ari", T("12:30")),
      now: T("12:30"),
    });
    const r = await returnToPo(root, ID, {
      gitHost: gh,
      repo: REPO,
      by: "ari",
      reason: "The default limit is still open",
      approval: approval("ari", T("13:00")),
      now: T("13:00"),
    });
    expect(r).toMatchObject({ state: "returned", closedOnHost: true });
    expect(closed.has(2)).toBe(true);
    let c = await changeStore(root).read(ID);
    expect(c.state).toBe("returned");
    expect(c.handoffs.at(-1)!.state).toBe("closed");
    expect(c.history.at(-1)).toMatchObject({
      from: "design",
      to: "returned",
      by: "ari",
      pr: 2,
      reason: "Returned to the product owner (The default limit is still open)",
    });

    await handoff(root, ID, {
      gitHost: gh,
      repo: REPO,
      by: "pat",
      approval: approval("pat", T("15:00")),
      now: T("15:00"),
    });
    c = await changeStore(root).read(ID);
    expect(c.state).toBe("define");
    expect(c.history.at(-1)).toMatchObject({
      from: "returned",
      to: "define",
      reason: "Resubmitted",
    });
    expect(c.handoffs.at(-1)).toMatchObject({ phase: "define", state: "open", pr: { number: 3 } });
  });

  it("returns a change when the host can't close PRs, and says so", async () => {
    const root = await forgeMetarepo();
    const gh = host();
    // A Git host plugin from before C4 closePullRequest (ADR 0041) has no close.
    const noClose: GitHost = {
      getRepo: (r) => gh.getRepo(r),
      getPullRequest: (r, n) => gh.getPullRequest(r, n),
      listPullRequests: (r, q) => gh.listPullRequests(r, q),
      createPullRequest: (i, a) => gh.createPullRequest(i, a),
      comment: (r, n, b, a) => gh.comment(r, n, b, a),
      merge: (r, n, a) => gh.merge(r, n, a),
    };
    await inDesign(root, gh);
    await handoff(root, ID, {
      gitHost: gh,
      repo: REPO,
      by: "ari",
      approval: approval("ari", T("12:30")),
      now: T("12:30"),
    });
    const r = await returnToPo(root, ID, {
      gitHost: noClose,
      repo: REPO,
      by: "ari",
      reason: "Scope unclear",
      approval: approval("ari", T("13:00")),
      now: T("13:00"),
    });
    expect(r).toMatchObject({ state: "returned", closedOnHost: false });
    expect(gh.journal.at(-1)).toMatchObject({
      method: "comment",
      args: [REPO, 2, expect.any(String)],
    });
  });

  it("refuses to return a change without an open hand-off, and refuses writes without approval", async () => {
    const root = await forgeMetarepo();
    const gh = host();
    await newChange(root, {
      title: "Add transfer limit",
      type: "feature",
      by: "pat",
      now: T("09:00"),
    });
    await expect(
      returnToPo(root, ID, {
        gitHost: gh,
        repo: REPO,
        by: "ari",
        reason: "x",
        approval: approval("ari", T("10:00")),
      }),
    ).rejects.toMatchObject({ code: "refused" });
    await copyPhase(root, ID, `${ID}/define`);
    await expect(
      handoff(root, ID, {
        gitHost: gh,
        repo: REPO,
        by: "pat",
        approval: { by: "pat", at: "not a time", ref: "x" },
      }),
    ).rejects.toMatchObject({ code: "not-approved" });
  });
});
