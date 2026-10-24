import { existsSync } from "node:fs";
import { cp } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  archiveChange,
  canAdvance,
  changeReport,
  handoff,
  newChange,
  syncHandoff,
} from "../src/index.js";
import {
  FEATURE_OWNERS,
  FIXTURES,
  REPO,
  approval,
  copyPhase,
  forgeMetarepo,
  passedRound,
  host,
  readText,
} from "./helpers.js";

const ID = "add-transfer-limit";
const codes = (r: { reasons: { code: string }[] }) => r.reasons.map((x) => x.code);

describe("a Forge feature from Define to Release against the mock Git host", () => {
  it("walks every phase, refusing what isn't ready, and ends with the expected change.yaml", async () => {
    const root = await forgeMetarepo();
    const dir = join(root, "openspec/changes", ID);
    const gh = host();
    const base = { gitHost: gh, repo: REPO };

    // ---- Define
    const created = await newChange(root, {
      title: "Add transfer limit",
      type: "feature",
      by: "pat",
      owners: FEATURE_OWNERS,
      systems: ["portal", "ledger"],
      now: "2026-10-19T09:00:00Z",
    });
    expect(created.id).toBe(ID);
    expect(created.state).toBe("define");
    expect(await readText(join(dir, "brief.md"))).toBe(
      await readText(join(FIXTURES, ID, "expected/brief.md")),
    );
    expect(parse(await readText(join(dir, ".openspec.yaml")))).toEqual({
      schema: "spec-driven",
      created: "2026-10-19",
    });

    const fresh = await canAdvance(ID, root);
    expect(fresh.ok).toBe(false);
    expect(fresh.reasons.map((r) => [r.code, r.artifact])).toEqual([
      ["unfilled-artifact", "brief"],
      ["missing-artifact", "proposal"],
      ["missing-artifact", "specs"],
      ["no-handoff", undefined],
    ]);
    await expect(
      handoff(root, ID, { ...base, by: "pat", approval: approval("pat", "2026-10-19T09:30:00Z") }),
    ).rejects.toMatchObject({ code: "refused" });
    expect(gh.journal.filter((j) => j.method === "createPullRequest")).toHaveLength(0);

    await copyPhase(root, ID, `${ID}/define`);
    const h1 = await handoff(root, ID, {
      ...base,
      by: "pat",
      approval: approval("pat", "2026-10-19T10:00:00Z"),
      now: "2026-10-19T10:00:00Z",
    });
    expect(h1.pr.number).toBe(1);
    const created1 = gh.journal.find((j) => j.method === "createPullRequest")!;
    expect(created1.args[0]).toMatchObject({
      repo: REPO,
      head: "handoff/add-transfer-limit/define",
      base: "main",
      title: "Add transfer limit: Send to architecture",
      body: await readText(join(FIXTURES, ID, "expected/pr-define.md")),
    });
    expect(created1.approval?.by).toBe("pat");

    const waiting = await syncHandoff(root, ID, {
      ...base,
      approval: approval("pat", "2026-10-19T10:30:00Z"),
      now: "2026-10-19T10:30:00Z",
    });
    expect(waiting.merged).toBe(false);
    expect(codes(waiting)).toEqual(["approval-missing"]);

    // pat raised it, so pat's own approval doesn't count: a PR asks someone else to review.
    gh.review(REPO, 1, "pat", "approved");
    const own = await syncHandoff(root, ID, {
      ...base,
      approval: approval("pat", "2026-10-19T10:45:00Z"),
      now: "2026-10-19T10:45:00Z",
    });
    expect(own.merged).toBe(false);
    expect(own.reasons).toEqual([
      expect.objectContaining({ code: "self-approval", person: "pat" }),
    ]);
    gh.review(REPO, 1, "ari", "approved");
    const s1 = await syncHandoff(root, ID, {
      ...base,
      approval: approval("pat", "2026-10-19T11:00:00Z"),
      now: "2026-10-19T11:00:00Z",
    });
    expect(s1).toMatchObject({ merged: true, state: "design" });

    // ---- Design: a blocking finding in the newest round stops the hand-off
    await copyPhase(root, ID, `${ID}/design`);
    await cp(join(FIXTURES, ID, "review/design/1"), join(dir, "review/design/1"), {
      recursive: true,
    });
    const blocked = await handoff(root, ID, {
      ...base,
      by: "ari",
      approval: approval("ari", "2026-10-19T12:00:00Z"),
      now: "2026-10-19T12:00:00Z",
    }).catch((e: unknown) => e);
    expect(blocked).toMatchObject({ code: "refused" });
    expect((blocked as { reasons: { code: string; finding?: string }[] }).reasons).toEqual([
      expect.objectContaining({ code: "blocking-finding", finding: "row-lock-missing" }),
    ]);

    await cp(join(FIXTURES, ID, "review/design/2"), join(dir, "review/design/2"), {
      recursive: true,
    });
    const report = await changeReport(root, ID);
    expect(report.risk).toEqual({
      score: 6,
      level: "medium",
      factors: [
        { factor: "type", detail: "change type feature", points: 2 },
        { factor: "systems", detail: "2 systems touched (ledger, portal)", points: 1 },
        { factor: "data-store", detail: "data store ledger-db", points: 2 },
        { factor: "interface", detail: "interface if-d99f508a2ac9b6e0 planned-modify", points: 1 },
      ],
    });
    expect(report.tests.required).toEqual(["unit", "contract", "integration", "regression"]);
    expect(report.privacy.touched).toBe(false);

    await handoff(root, ID, {
      ...base,
      by: "ari",
      approval: approval("ari", "2026-10-19T12:30:00Z"),
      now: "2026-10-19T12:30:00Z",
    });
    const pending = await canAdvance(ID, root);
    expect(codes(pending)).toEqual(["pr-not-merged"]);
    // change status names the PR to merge, not a role to ask.
    expect((await changeReport(root, ID)).nextStep).toBe(
      "Merge PR #2 once it is approved (https://git.example.com/forge/forge-metarepo/pull/2); syncing then moves the change on.",
    );

    // The person who raised the design hand-off can't approve it.
    gh.review(REPO, 2, "ari", "approved");
    const self = await syncHandoff(root, ID, {
      ...base,
      approval: approval("ari", "2026-10-19T13:00:00Z"),
      now: "2026-10-19T13:00:00Z",
    });
    expect(self.merged).toBe(false);
    expect(self.reasons).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "self-approval", person: "ari" })]),
    );
    gh.review(REPO, 2, "avery", "approved");
    expect(
      await syncHandoff(root, ID, {
        ...base,
        approval: approval("avery", "2026-10-19T14:00:00Z"),
        now: "2026-10-19T14:00:00Z",
      }),
    ).toMatchObject({ merged: true, state: "plan" });

    // ---- Plan
    await copyPhase(root, ID, `${ID}/plan`);
    await handoff(root, ID, {
      ...base,
      by: "bao",
      approval: approval("bao", "2026-10-19T15:00:00Z"),
      now: "2026-10-19T15:00:00Z",
    });
    gh.review(REPO, 3, "tia", "approved");
    expect(
      await syncHandoff(root, ID, {
        ...base,
        approval: approval("tia", "2026-10-19T16:00:00Z"),
        now: "2026-10-19T16:00:00Z",
      }),
    ).toMatchObject({ merged: true, state: "build" });

    // ---- Build: the host refuses to merge while a check fails
    await copyPhase(root, ID, `${ID}/build`);
    await handoff(root, ID, {
      ...base,
      by: "dev",
      approval: approval("dev", "2026-10-20T09:00:00Z"),
      now: "2026-10-20T09:00:00Z",
    });
    gh.review(REPO, 4, "dee", "approved");
    gh.setChecks(REPO, 4, [{ name: "tests", status: "failed" }]);
    const refused = await syncHandoff(root, ID, {
      ...base,
      approval: approval("dee", "2026-10-20T10:00:00Z"),
      now: "2026-10-20T10:00:00Z",
    });
    expect(refused.merged).toBe(false);
    expect(refused.reasons[0]).toMatchObject({ code: "host-refused" });
    expect(refused.reasons[0]!.message).toContain("tests failed");
    gh.setChecks(REPO, 4, [{ name: "tests", status: "passed" }]);
    expect(
      await syncHandoff(root, ID, {
        ...base,
        approval: approval("dee", "2026-10-20T11:00:00Z"),
        now: "2026-10-20T11:00:00Z",
      }),
    ).toMatchObject({ merged: true, state: "qa" });

    // ---- QA
    await handoff(root, ID, {
      ...base,
      by: "quinn",
      approval: approval("quinn", "2026-10-20T12:00:00Z"),
      now: "2026-10-20T12:00:00Z",
    });
    gh.review(REPO, 5, "tia", "approved");
    expect(
      await syncHandoff(root, ID, {
        ...base,
        approval: approval("quinn", "2026-10-20T13:00:00Z"),
        now: "2026-10-20T13:00:00Z",
      }),
    ).toMatchObject({ merged: true, state: "release-ready" });

    // ---- Release: go / no-go is the release hand-off PR (ADR 0073).
    // The Forge profile makes the release gate mandatory: the critic has reviewed it.
    await passedRound(root, ID, "release");
    await handoff(root, ID, {
      ...base,
      by: "tia",
      approval: approval("tia", "2026-10-20T14:00:00Z"),
      now: "2026-10-20T14:00:00Z",
    });
    gh.review(REPO, 6, "dana", "approved");
    gh.review(REPO, 6, "sam", "approved");
    expect(
      await syncHandoff(root, ID, {
        ...base,
        approval: approval("dana", "2026-10-20T15:00:00Z"),
        now: "2026-10-20T15:00:00Z",
      }),
    ).toMatchObject({ merged: true, state: "released" });

    await archiveChange(root, ID, { by: "dana", now: "2026-10-20T16:00:00Z" });

    expect(await readText(join(dir, "change.yaml"))).toBe(
      await readText(join(FIXTURES, ID, "expected/change.yaml")),
    );
    // Atticus checks the host's own merge rules first, so a refused merge is never attempted.
    expect(gh.journal.filter((j) => j.method === "merge").map((j) => j.args[1])).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    expect(gh.journal.every((j) => j.method.startsWith("get") || j.approval)).toBe(true);
    expect(existsSync(join(dir, "change.yaml.tmp"))).toBe(false);
  });
});

describe("an emergency fix: build, release, then post-release review", () => {
  it("skips Define and Design, refuses the raiser's own approval, and ends in archived", async () => {
    const root = await forgeMetarepo();
    const id = "fix-northwind-timeout";
    const dir = join(root, "openspec/changes", id);
    const gh = host();
    const base = { gitHost: gh, repo: REPO };

    const c = await newChange(root, {
      title: "Fix Northwind timeout",
      type: "emergency-fix",
      by: "dev",
      owners: {
        developer: ["dev", "dee"],
        "delivery-lead": ["dana", "dev"],
        sre: ["sam"],
        architect: ["ari"],
      },
      systems: ["northwind-pay", "ledger"],
      touches: { interfaces: [{ id: "if-e7344c9455608119", status: "planned-modify" }] },
      now: "2026-10-21T02:00:00Z",
    });
    expect(c.state).toBe("build");
    expect(await readText(join(dir, "brief.md"))).toBe(
      await readText(join(FIXTURES, id, "expected/brief.md")),
    );

    const report = await changeReport(root, id);
    expect(report.risk.level).toBe("high");
    expect(report.risk.score).toBe(8);
    expect(report.risk.factors.map((f) => f.factor)).toEqual([
      "type",
      "systems",
      "vendor",
      "interface",
    ]);
    expect(report.tests.required).toEqual(["unit", "regression"]);

    await copyPhase(root, id, `${id}/build`);
    await handoff(root, id, {
      ...base,
      by: "dev",
      approval: approval("dev", "2026-10-21T02:30:00Z"),
      now: "2026-10-21T02:30:00Z",
    });
    gh.review(REPO, 1, "dee", "approved");
    expect(
      await syncHandoff(root, id, {
        ...base,
        approval: approval("dee", "2026-10-21T02:45:00Z"),
        now: "2026-10-21T02:45:00Z",
      }),
    ).toMatchObject({ merged: true, state: "release-ready" });

    await passedRound(root, id, "release");
    await handoff(root, id, {
      ...base,
      by: "dee",
      approval: approval("dee", "2026-10-21T03:00:00Z"),
      now: "2026-10-21T03:00:00Z",
    });
    // No roles are asked for: the release hand-off PR is go / no-go, and the Git host decides who may approve it.
    expect(Object.keys(await changeReport(root, id))).not.toContain("required");

    // dee raised the release hand-off, so dee's own approval doesn't count.
    gh.review(REPO, 2, "dee", "approved");
    const self = await syncHandoff(root, id, {
      ...base,
      approval: approval("dee", "2026-10-21T03:10:00Z"),
      now: "2026-10-21T03:10:00Z",
    });
    expect(self.merged).toBe(false);
    expect(self.reasons).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "self-approval", person: "dee" })]),
    );

    for (const who of ["dana", "sam"]) gh.review(REPO, 2, who, "approved");
    expect(
      await syncHandoff(root, id, {
        ...base,
        approval: approval("dana", "2026-10-21T03:20:00Z"),
        now: "2026-10-21T03:20:00Z",
      }),
    ).toMatchObject({ merged: true, state: "post-release-review" });

    await archiveChange(root, id, { by: "dana", now: "2026-10-22T09:00:00Z" });
    expect(await readText(join(dir, "change.yaml"))).toBe(
      await readText(join(FIXTURES, id, "expected/change.yaml")),
    );
  });
});

describe("a hand-off PR that reviews itself (WP7.4)", () => {
  it("ends the PR body with the review the caller composed", async () => {
    const root = await forgeMetarepo();
    const gh = host();
    await newChange(root, {
      title: "Add transfer limit",
      type: "feature",
      by: "pat",
      owners: FEATURE_OWNERS,
      systems: ["portal", "ledger"],
      now: "2026-10-19T09:00:00Z",
    });
    await copyPhase(root, ID, `${ID}/define`);
    const review =
      "### What it changes\n\n```mermaid\nflowchart LR\n```\n\n### Findings still open\n\nNone open.";
    await handoff(root, ID, {
      gitHost: gh,
      repo: REPO,
      by: "pat",
      approval: approval("pat", "2026-10-19T10:00:00Z"),
      now: "2026-10-19T10:00:00Z",
      review,
    });
    const body = (
      gh.journal.find((j) => j.method === "createPullRequest")!.args[0] as { body: string }
    ).body;
    expect(body.trimEnd().endsWith(review)).toBe(true);
    expect(body).toContain("### Privacy");
  });
});
