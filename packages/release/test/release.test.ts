import { existsSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { HandoffRuntime } from "@maycombhq/ai";
import {
  deploymentPlan,
  evidencePack,
  findMeasure,
  loadRelease,
  measureId,
  measuresOf,
  outcomesView,
  recordOutcome,
  releaseForecast,
  releaseNotes,
  securityReview,
  writeEvidencePack,
  ReleaseError,
} from "../src/index.js";
import {
  EXPECTED,
  ID,
  NOW,
  changeDir,
  expected,
  forgeJudge,
  forgeRoot,
  moveTo,
} from "./helpers.js";

/** Compare a generated document with its golden file (UPDATE_GOLDEN=1 rewrites it after a review). */
function golden(name: string, text: string) {
  const path = join(EXPECTED, name);
  if (process.env.UPDATE_GOLDEN === "1" || !existsSync(path)) writeFileSync(path, text);
  expect(text).toBe(expected(name));
}

const plain = async () =>
  loadRelease(await forgeRoot(), ID, { now: NOW, runtime: forgeJudge().runtime });

describe("deployment plan", () => {
  it("orders the seeded change's repos from its dependencies, as worked out by hand", async () => {
    const want = parse(expected("plan.yaml")) as {
      steps: {
        n: number;
        repo: string;
        kind: string;
        after: number[];
        earliest: string;
        waits: string[];
      }[];
      request: Record<string, unknown>;
      unplaced: string[];
      external: { system: string; beforeStep: number };
      sections: Record<string, string>;
      rollbackGaps: number;
      earliest: string;
    };
    const p = await deploymentPlan(await plain());
    expect(
      p.steps.map((s) => ({
        n: s.n,
        repo: s.repo,
        kind: s.kind,
        after: s.after,
        earliest: s.earliest,
        waits: s.waitsOn.map((w) => w.heading),
      })),
    ).toEqual(want.steps);
    expect(p.steps[1]!.waitsOn[0]).toMatchObject(want.request);
    expect(p.unplaced.map((u) => u.id)).toEqual(want.unplaced);
    expect(p.external).toEqual([expect.objectContaining(want.external)]);
    expect(Object.fromEntries(p.sections.map((s) => [s.name, s.text ? s.source : "gap"]))).toEqual(
      want.sections,
    );
    expect(p.steps.filter((s) => s.rollback.gap).length).toBe(want.rollbackGaps);
    expect(p.earliest).toBe(want.earliest);
    expect(p.before).toEqual([]);
  });

  it("says why each step sits where it does, and what deploys in it", async () => {
    const p = await deploymentPlan(await plain());
    const [mig, route, ledger, bff, ui] = p.steps;
    expect(mig!.why).toEqual(["First: the schema is expanded before any code reads it."]);
    expect(mig!.what).toEqual([
      "ledger-db.account: add column daily_limit numeric(18,2) not null default 1000 (V3__add_daily_limit.sql)",
      "ledger-db.limit_change: new table limit_change (id bigint, account_id bigint, old_limit numeric(18,2), new_limit numeric(18,2), changed_by_email varchar(200), changed_at timestamp) (no migration file named)",
    ]);
    expect(route!.what).toEqual(["New gateway route gw-northwind-v2 for POST /v2/velocity-checks"]);
    expect(ledger!.why).toEqual([
      "After step 1: ledger-api reads or writes ledger-db.account, so the migration (expand) runs first.",
      "After step 1: ledger-api reads or writes ledger-db.limit_change, so the migration (expand) runs first.",
      "After step 2: ledger-api calls POST /v2/velocity-checks through gw-northwind-v2, so the route goes first.",
    ]);
    expect(bff!.why).toContain(
      "After step 3: portal-bff calls ledger-api's new GET /accounts/{id}/limit, so ledger-api deploys first.",
    );
    expect(ui!.why).toEqual([
      "After step 3: story s2-show-remaining depends on s1-refuse-over-limit.",
    ]);
    expect(ledger!.what).toContain(
      "Task 1.3 Call Northwind Pay's velocity check, with tests (story s4-velocity-check)",
    );
    expect(mig!.rollback.gap).toMatch(/^No rollback step written for ledger-db\.account/);
  });

  it("flags what it can't place, missing sections and a migration with no file, in words", async () => {
    const p = await deploymentPlan(await plain());
    expect(p.gaps).toContain(
      "data.md:8: the change to ledger-db.limit_change names no migration file, so the migration step can't say what runs.",
    );
    expect(p.gaps).toContain(
      "audit-svc (callee of POST /audit/events) has no repo in the catalog or the repos manifest, so Atticus can't place its deploy.",
    );
    expect(p.gaps).toContain(
      "risk-engine (callee of POST /risk/assess) isn't in the catalog or the repos manifest, so Atticus can't place its deploy.",
    );
    expect(p.gaps.some((g) => g.startsWith("design.md has no readiness section"))).toBe(true);
    expect(p.notes).toContain("design.md's rollout doesn't mention step 2 (forge-gateway).");
    expect(p.findings).toEqual([]);
  });

  it("reads rollback steps and the release sections from design.md, and shows the release lens's open findings", async () => {
    const root = await forgeRoot({ released: true });
    const p = await deploymentPlan(
      await loadRelease(root, ID, { now: NOW, runtime: forgeJudge().runtime }),
    );
    const by = (repo: string, kind = "code") =>
      p.steps.find((s) => s.repo === repo && s.kind === kind)!;
    expect(by("forge-ledger", "migration").rollback).toEqual({
      text: "V3__add_daily_limit.sql is expand-only, so rolling back needs no down migration.",
      source: "design.md:13",
    });
    expect(by("forge-ledger").rollback.source).toBe("design.md:12");
    expect(by("forge-portal-bff").rollback.text).toBe(
      "Roll back the other repos by redeploying their previous release.",
    );
    expect(by("forge-gateway", "gateway-route").rollback.gap).toMatch(/gw-northwind-v2/);
    expect(p.sections.map((s) => [s.name, s.heading ?? "", !!s.gap])).toEqual([
      ["rollout", "Rollout and rollback", false],
      ["rollback", "Rollout and rollback", false],
      ["readiness", "Readiness", false],
      ["verification", "Verification", false],
      ["hypercare", "Hypercare", false],
    ]);
    expect(p.findings).toEqual([
      expect.objectContaining({
        rule: "snow-drafts-present",
        path: "review/plan/1/f-no-firewall-request.yaml",
      }),
    ]);
    // the request was filed on 2026-10-20 (step done), so it is expected 5 working days later
    expect(by("forge-gateway", "gateway-route").waitsOn[0]).toMatchObject({
      state: "filed",
      number: "SR-1042",
      readyBy: "2026-10-27",
      waitDays: 4,
    });
  });
});

describe("forecast", () => {
  it("is the earliest day the request lead times allow, with no target outside an initiative", async () => {
    const f = await releaseForecast(await plain());
    expect(f).toMatchObject({
      ready: "2026-10-28",
      basis: "requests",
      status: "no-target",
      waitDays: 5,
      tasks: { total: 5, open: 5, done: 0, waitingOnRequests: ["1.3"] },
    });
    expect(f.drivers[0]).toMatchObject({ until: "2026-10-28", days: 5 });
    expect(f.notes).toContain(
      "add-transfer-limit isn't part of an initiative, so it has no target date.",
    );
    expect(f.notes.some((n) => /5 of 5 tasks are open/.test(n))).toBe(true);
  });

  it("uses the initiative's critical path and target when the change belongs to one", async () => {
    const root = await forgeRoot({ initiative: true });
    const f = await releaseForecast(
      await loadRelease(root, ID, { now: NOW, runtime: forgeJudge().runtime }),
    );
    // gateway 10-21 + 5 = 10-28; build + 10 = 11-11; release-ready + 3 = 11-16, due 11-12
    expect(f).toMatchObject({
      ready: "2026-11-16",
      basis: "initiative",
      status: "at-risk",
      target: {
        date: "2026-11-12",
        source: "initiatives/daily-limits/plan.yaml item release-ready.ledger due",
      },
      initiative: {
        id: "daily-limits",
        item: {
          key: "release-ready.ledger",
          milestone: "release-ready",
          projectedFinish: "2026-11-16",
        },
        criticalPath: ["gateway-route", "build.ledger", "release-ready.ledger"],
      },
    });
  });

  it("says released once the change is released", async () => {
    const root = await forgeRoot();
    await moveTo(root, ["build", "qa", "release-ready", "released"]);
    const f = await releaseForecast(
      await loadRelease(root, ID, { now: NOW, runtime: forgeJudge().runtime }),
    );
    expect(f).toMatchObject({ status: "released", ready: "2026-10-20", basis: "released" });
  });
});

describe("release notes", () => {
  it("writes business notes from the brief and proposal", async () => {
    const n = await releaseNotes(await plain(), "business");
    golden("notes-business.md", n.markdown);
    expect(n.sections.map((s) => s.heading)).toEqual([
      "Why",
      "What changes",
      "Who it affects",
      "Not included",
      "Known limitations",
      "Still open",
    ]);
  });

  it("adds API and data changes for technical readers, breaking or not", async () => {
    const n = await releaseNotes(await plain(), "technical");
    golden("notes-technical.md", n.markdown);
    expect(n.api.map((a) => [a.operation, a.change, a.breaking])).toEqual([
      ["POST /transfers", "modify", "yes"],
      ["GET /accounts/{id}/limit", "new", "no"],
      ["POST /v2/velocity-checks", "new", "no"],
      ["POST /audit/events", "modify", "check"],
      ["POST /risk/assess", "new", "no"],
    ]);
  });

  it("lists waived findings as known limitations", async () => {
    const root = await forgeRoot({ released: true });
    const n = await releaseNotes(
      await loadRelease(root, ID, { now: NOW, runtime: forgeJudge().runtime }),
      "business",
    );
    expect(n.limitations).toEqual([
      {
        summary: "POST /audit/events has no integration pattern.",
        reason: "Audit calls stay direct until the audit gateway exists next quarter.",
        by: "avery",
        at: "2026-10-20T10:00:00Z",
        source: "review/design/1/f-audit-no-pattern.yaml",
      },
    ]);
  });
});

describe("security review draft", () => {
  it("drafts the review from the catalog and the change", async () => {
    const s = await securityReview(await plain());
    golden("security.md", s.markdown);
    expect(s.interfaces.map((i) => [i.operation, i.auth, i.authSource ?? ""])).toEqual([
      ["POST /transfers", "oauth2", "catalog Interface if-d99f508a2ac9b6e0"],
      [
        "GET /accounts/{id}/limit",
        "oauth2",
        "catalog GatewayRoute gw-ledger-v1 policy VerifyOAuth",
      ],
      ["POST /v2/velocity-checks", "mtls", "interfaces.md:15"],
      ["POST /audit/events", "not stated", ""],
      ["POST /risk/assess", "not stated", ""],
    ]);
    expect(s.fields.find((f) => f.field === "ledger-db.limit_change.changed_by_email")).toEqual({
      field: "ledger-db.limit_change.changed_by_email",
      classification: "internal",
      classificationSource: "data.md:13",
      personal: "yes",
      personalLooking: true,
      source: "data.md:8",
    });
    expect(s.vendors).toEqual([
      {
        system: "northwind-pay",
        name: "Northwind Pay",
        isNew: false,
        operations: ["POST /v2/velocity-checks"],
        existing: 1,
      },
    ]);
    expect(s.signOff.gates[0]).toMatchObject({ gate: "design", handoff: { state: "merged" } });
    expect(s.signOff.how).toMatch(/merging a PR is its sign-off/);
  });

  it("asks for no role: roles.yaml is ignored for the sign-off (ADR 0073)", async () => {
    const root = await forgeRoot();
    const roles = join(root, "org-pack/roles.yaml");
    await writeFile(
      roles,
      (await readFile(roles, "utf8")).replace(
        "enabledOptional: [data-architect, sre]",
        "enabledOptional: [data-architect, sre, security-reviewer]",
      ),
    );
    const s = await securityReview(
      await loadRelease(root, ID, { now: NOW, runtime: forgeJudge().runtime }),
    );
    expect(s.signOff).not.toHaveProperty("role");
    expect(s.gaps.join("\n")).not.toContain("security-reviewer");
    expect(s.markdown).not.toContain("security-reviewer");
  });
});

describe("evidence pack", () => {
  it("collects everything an approval board needs, each item with its source", async () => {
    const root = await forgeRoot({ released: true });
    await moveTo(root, ["build", "qa", "release-ready", "released"]);
    const e = await evidencePack(
      await loadRelease(root, ID, { now: NOW, runtime: forgeJudge().runtime }),
    );
    golden("evidence.md", e.markdown);
    expect(e.files.map((f) => f.path)).toContain("review/design/1/f-audit-no-pattern.yaml");
    expect(e.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);
  });

  it("writes the pack to a folder with a manifest and a copy of every file", async () => {
    const root = await forgeRoot();
    const ctx = await loadRelease(root, ID, { now: NOW, runtime: forgeJudge().runtime });
    const out = join(root, "pack");
    const written = await writeEvidencePack(ctx, out);
    expect(written.slice(0, 2)).toEqual(["evidence.md", "manifest.json"]);
    const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8")) as {
      files: { path: string }[];
    };
    expect(written).toContain("files/brief.md");
    expect(manifest.files.length).toBe(written.length - 2);
    expect(await readFile(join(out, "files/brief.md"), "utf8")).toBe(
      await readFile(join(changeDir(root), "brief.md"), "utf8"),
    );
  });
});

describe("outcomes", () => {
  it("turns the brief's success measures into measures with stable ids", async () => {
    const ctx = await plain();
    expect(measuresOf(ctx)).toEqual({
      source: "brief.md:29",
      measures: [
        {
          id: "no-transfer-over-a-limit-is-accepted",
          n: 1,
          measure: "No transfer over a limit is accepted",
          source: "brief.md:31",
        },
        {
          id: "support-reversals-for-drained-accounts-drop-to-zero",
          n: 2,
          measure: "Support reversals for drained accounts drop to zero",
          source: "brief.md:31",
        },
      ],
    });
    expect(measureId("a".repeat(30) + " " + "b".repeat(40))).toBe("a".repeat(30));
    expect(findMeasure(measuresOf(ctx).measures, "2")?.n).toBe(2);
  });

  it("refuses a value before release, in words", async () => {
    const ctx = await plain();
    await expect(recordOutcome(ctx, { measure: "1", value: "0", by: "pat" })).rejects.toThrow(
      "Outcomes are measured after release; add-transfer-limit is plan.",
    );
    const v = await outcomesView(ctx);
    expect(v).toMatchObject({
      canRecord: false,
      why: "Outcomes are measured after release; add-transfer-limit is plan.",
    });
  });

  it("records values after release in review/outcomes.yaml, as the person who measured", async () => {
    const root = await forgeRoot();
    await moveTo(root, ["build", "qa", "release-ready", "released"]);
    const ctx = await loadRelease(root, ID, { now: NOW, runtime: forgeJudge().runtime });
    const r = await recordOutcome(ctx, {
      measure: "support-reversals-for-drained-accounts-drop-to-zero",
      value: "0 reversals in October",
      by: "@pat",
      note: "From the support queue export",
    });
    expect(r).toMatchObject({ written: "review/outcomes.yaml", value: { by: "pat", at: NOW } });
    await recordOutcome(await loadRelease(root, ID, { now: "2026-11-02T09:00:00Z" }), {
      measure: "2",
      value: "0 reversals",
      by: "sam",
    });
    expect(await readFile(join(changeDir(root), "review/outcomes.yaml"), "utf8")).toBe(
      expected("outcomes.yaml"),
    );
    const v = await outcomesView(
      await loadRelease(root, ID, { now: NOW, runtime: forgeJudge().runtime }),
    );
    expect(v.canRecord).toBe(true);
    expect(v.measures[1]!.latest).toEqual({
      value: "0 reversals",
      by: "sam",
      at: "2026-11-02T09:00:00Z",
    });
    expect(v.measures[0]!.values).toEqual([]);
    await expect(
      recordOutcome(ctx, { measure: "no such measure", value: "1", by: "pat" }),
    ).rejects.toBeInstanceOf(ReleaseError);
  });
});

describe("loading", () => {
  it("says there is no such change", async () => {
    await expect(
      loadRelease(await forgeRoot(), "nope", { now: NOW, runtime: forgeJudge().runtime }),
    ).rejects.toThrow("There is no change nope.");
  });
});

describe("judgments of meaning (ADR 0117 addendum)", () => {
  it("asks the judge once, keeps its verdicts in judgments/, and reads them back without a model", async () => {
    const root = await forgeRoot({ released: true });
    const judge = forgeJudge();
    const first = await loadRelease(root, ID, { now: NOW, runtime: judge.runtime });
    const n = await releaseNotes(first, "technical");
    const p = await deploymentPlan(first);
    const s = await securityReview(first);
    const calls = judge.calls();
    expect(calls).toBeGreaterThan(0);
    // Each prompt is the judge's closed question, the texts wrapped as data.
    expect(judge.prompts[0]).toContain("Answer with one of these words, nothing else:");
    expect(n.api.find((a) => a.operation === "POST /transfers")).toMatchObject({
      breaking: "yes",
      judgedBy: "model",
    });
    // A judge that couldn't tell is not a guess: a person checks.
    expect(n.api.find((a) => a.operation === "POST /audit/events")).toMatchObject({
      breaking: "check",
      why: expect.stringMatching(/^A judge couldn't tell whether callers must change/),
    });
    // The catalog's change kind settles a new operation: the veto, never sent.
    expect(n.api.find((a) => a.operation === "GET /accounts/{id}/limit")).toMatchObject({
      breaking: "no",
      judgedBy: "catalog",
    });
    // "restore", "undo" or "roll back" are not the test: the judge read the sentences.
    const ledger = p.steps.find((x) => x.repo === "forge-ledger" && x.kind === "code")!;
    expect(ledger.rollback.source).toBe("design.md:12");
    expect(s.secrets.map((x) => x.source)).toContain("mappings.md:18");
    // The fixture's embedded instruction is kept out of the judge's prompt by the defences
    // (ingested content is data), so that one line is left for a person.
    expect(s.secretsNotJudged).toEqual(["stories/s3-audit-refusals.md:10"]);
    expect(existsSync(join(root, "judgments", "breaking"))).toBe(true);

    // Without a model: the same views from the judgments on file, and no prompt sent.
    const again = await loadRelease(root, ID, { now: NOW });
    expect((await releaseNotes(again, "technical")).api.map((a) => a.breaking)).toEqual(
      n.api.map((a) => a.breaking),
    );
    expect((await deploymentPlan(again)).steps.map((x) => x.rollback)).toEqual(
      p.steps.map((x) => x.rollback),
    );
    expect((await securityReview(again)).markdown).toBe(s.markdown);
    expect(judge.calls()).toBe(calls);
  });

  it("with the hand-off runtime spends no prompt, and shows a person what no one has judged", async () => {
    const root = await forgeRoot({ released: true });
    const runtime = new HandoffRuntime({
      root,
      validate: async () => [],
      now: () => new Date(NOW),
    });
    const ctx = await loadRelease(root, ID, { now: NOW, runtime });
    const n = await releaseNotes(ctx, "technical");
    const p = await deploymentPlan(ctx);
    const s = await securityReview(ctx);
    expect(existsSync(join(root, ".runs"))).toBe(false);
    // Never the old regex's answer: "check", for a person, with why.
    expect(n.api.find((a) => a.operation === "POST /transfers")).toMatchObject({
      breaking: "check",
      judgedBy: "not judged",
      why: expect.stringMatching(/^Not judged: no model was asked whether callers must change/),
    });
    expect(n.markdown).toContain("| check (not judged) |");
    // A fact still settles what it can: a new operation has no caller to break.
    expect(n.api.find((a) => a.operation === "GET /accounts/{id}/limit")!.breaking).toBe("no");
    expect(
      p.steps.find((x) => x.repo === "forge-ledger" && x.kind === "code")!.rollback.gap,
    ).toMatch(
      /^No rollback step judged for forge-ledger yet: .* no model was asked, so a person checks .*design\.md:12/,
    );
    expect(s.fields.every((f) => f.personal === "not judged")).toBe(true);
    expect(s.gaps.join("\n")).toMatch(/^Not judged whether ledger-db\.account\.daily_limit, /m);
    expect(s.secretsNotJudged.length).toBeGreaterThan(0);
    expect(s.markdown).toMatch(/_Not judged: \d+ lines of the change weren't read for secrets/);
    expect(s.markdown).not.toContain("_No credential or secret is named or implied._");
  });

  it("keeps a token written in a known format a fact, and never shows it", async () => {
    const root = await forgeRoot();
    const file = join(changeDir(root), "design.md");
    await writeFile(
      file,
      `${await readFile(file, "utf8")}\nThe sandbox key AKIAABCDEFGHIJKLMNOP is for the contract tests.\n`,
    );
    const s = await securityReview(await loadRelease(root, ID, { now: NOW }));
    const line = (await readFile(file, "utf8")).split("\n").length - 1;
    expect(s.secrets).toContainEqual({
      what: "a cloud access key, written in the change (not shown here)",
      source: `design.md:${line}`,
    });
    expect(s.gaps).toContain(
      `design.md:${line} holds what looks like a cloud access key: take it out of the change folder and rotate it.`,
    );
    expect(s.markdown).not.toContain("AKIAABCDEFGHIJKLMNOP");
  });
});
