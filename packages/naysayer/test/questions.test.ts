import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import {
  ChecklistPack,
  fileJudgments,
  makeJudgment,
  parseRecord,
  recordPath,
  serializeRecord,
  type ChecklistRule,
} from "@maycombhq/core";
import {
  BUILT_IN_CHECKS,
  layerRules,
  loadConstitution,
  loosenings,
  QUESTIONS,
  questionOfRule,
  runCritic,
  starterReviewText,
  typeTakes,
  type CriticResult,
} from "../src/index.js";
import { CHANGE, FORGE_CHANGE, NOW, changeDir, forgeChangeRoot, write } from "./helpers.js";

/**
 * The critic asks four questions of every draft (ADR 0124 addendum, Part 4): is it true to the
 * code, is it complete, is it safe to build, can it ship. Code answers what code can before a
 * model is asked; one AI lens per question reads what the rules can't.
 */

const of = (r: CriticResult, rule: string) => r.findings.filter((f) => f.finding.rule === rule);
const summaries = (r: CriticResult, rule: string) => of(r, rule).map((f) => f.finding.summary);

async function edit(root: string, rel: string, from: string, to: string) {
  const p = join(changeDir(root), rel);
  const text = await readFile(p, "utf8");
  if (!text.includes(from)) throw new Error(`${rel} has no "${from}"`);
  await writeFile(p, text.replace(from, to));
}

/** Add (or replace) a catalog record in a test metarepo. */
async function record(root: string, r: Record<string, unknown>) {
  const p = parseRecord({ schemaVersion: 1, status: "current", confidence: "verified", ...r });
  if (!p.ok) throw new Error(`bad record ${String(r.id)}: ${JSON.stringify(p)}`);
  await write(root, join("catalog/generated", recordPath(p.record)), serializeRecord(p.record));
}

const AUDIT_CALL = {
  kind: "Interface",
  id: "if-5c55930b735276a9",
  from: "portal-bff",
  to: "audit-svc",
  via: "direct",
  method: "POST",
  normalizedPath: "/audit/events",
  sync: "sync",
  evidence: [
    {
      source: "code",
      repo: "forge-portal-bff",
      path: "src/main/java/forge/portal/AuditPublisher.java",
      line: 10,
    },
  ],
};

/** reports-job also calls POST /transfers: a consumer the change doesn't plan for. */
const REPORTS_CALL = {
  kind: "Interface",
  id: "if-215b704aff56ff56",
  from: "reports-job",
  to: "ledger-api",
  endpoint: "ledger-api.post-transfer",
  via: "direct",
  method: "POST",
  normalizedPath: "/transfers",
  sync: "sync",
  evidence: [
    {
      source: "code",
      repo: "forge-reports-job",
      path: "src/main/java/forge/reports/Replays.java",
      line: 4,
    },
  ],
};

describe("every rule answers one of the four questions, as data", () => {
  it("maps every built-in check to a question", () => {
    expect(Object.fromEntries(BUILT_IN_CHECKS.map((c) => [c.id, c.question]))).toEqual({
      "interface-pattern-approved": "safe",
      "pattern-code-in-registry": "true",
      "interface-has-pattern": "complete",
      "interface-via-matches-pattern": "safe",
      "interface-ends-in-catalog": "true",
      "interface-ids-in-catalog": "true",
      "settings-present": "safe",
      "observability-present": "ship",
      "story-has-acceptance-criteria": "complete",
      "spec-scenarios-present": "complete",
      "data-doc-present": "complete",
      "data-migration-named": "ship",
      "data-columns-classified": "safe",
      "data-retention-stated": "safe",
      "snow-drafts-present": "ship",
      "no-embedded-instructions": "safe",
      "knowledge-check": "true",
      "fact-known": "complete",
      "vendor-operation-known": "true",
      "mappings-cover-interfaces": "complete",
      "tasks-cover-stories": "complete",
      "call-timeout-stated": "safe",
      "public-entry-auth": "safe",
      "breaking-delta-consumers": "safe",
      "store-write-rollback": "ship",
    });
  });

  it("gives every constitution rule its question, and retires the service-desk check", async () => {
    const c = await loadConstitution();
    expect(
      Object.fromEntries(c.rules.map((r) => [r.id, [r.question, r.status, r.severity]])),
    ).toEqual({
      "constitution.interface-approved-pattern": ["safe", "active", "blocking"],
      "constitution.interface-ends-in-catalog": ["true", "active", "blocking"],
      "constitution.interface-ids-in-catalog": ["true", "active", "blocking"],
      "constitution.hop-resilience-stated": ["safe", "active", "blocking"],
      "constitution.touched-components-known": ["true", "active", "risk"],
      "constitution.data-doc-present": ["complete", "active", "blocking"],
      "constitution.data-change-has-migration": ["ship", "active", "blocking"],
      "constitution.data-columns-classified": ["safe", "active", "blocking"],
      "constitution.data-retention-stated": ["safe", "active", "blocking"],
      "constitution.story-acceptance-criteria": ["complete", "active", "blocking"],
      "constitution.spec-scenarios-present": ["complete", "active", "blocking"],
      "constitution.snow-drafts-present": ["ship", "retired", "blocking"],
      "constitution.no-embedded-instructions": ["safe", "active", "blocking"],
      "constitution.public-entry-auth": ["safe", "active", "blocking"],
      "constitution.breaking-delta-consumers": ["safe", "active", "blocking"],
    });
    // A rule's question is its own, then its question lens, then its check's, then its old lens's.
    for (const r of c.rules) expect(questionOfRule(r)).toBe(r.question);
  });

  it("puts the timeout and rollback checks in the starter review, the org's to change (the product owner, 2026-10-24)", async () => {
    const c = await loadConstitution();
    const checks = (rules: ChecklistRule[]) =>
      rules.flatMap((r) => (r.check.type === "deterministic" ? [r.check.check] : []));
    expect(checks(c.rules)).not.toContain("call-timeout-stated");
    expect(checks(c.rules)).not.toContain("store-write-rollback");
    const starter = ChecklistPack.parse(parse(await starterReviewText()));
    const code = starter.rules.filter((r) => r.check.type === "deterministic");
    expect(
      code.map((r) => [r.id, r.layer, r.question, r.severity, r.waivable, checks([r])[0]]),
    ).toEqual([
      ["review.call-timeout-stated", "org", "safe", "risk", false, "call-timeout-stated"],
      ["review.store-write-rollback", "org", "ship", "risk", false, "store-write-rollback"],
    ]);
    // The fixture's org pack carries them as the starter writes them (its AI rules left out).
    const fixture = ChecklistPack.parse(
      parse(await readFile(join(FORGE_CHANGE, "org-pack/checklists/review.yaml"), "utf8")),
    );
    expect(fixture.name).toBe(starter.name);
    expect(fixture.rules).toEqual(code);
  });

  it("reads an org rule written for an old lens as the question that took it over", () => {
    const base = {
      check: { type: "ai" as const, prompt: "Report anything the brief asks for that is missing." },
    };
    expect(questionOfRule({ ...base, lens: "ux" })).toBe("complete");
    expect(questionOfRule({ ...base, lens: "delivery" })).toBe("ship");
    expect(questionOfRule({ ...base, lens: "architecture", question: "safe" })).toBe("safe");
    // A deterministic rule takes its check's question before its old lens's.
    expect(
      questionOfRule({
        lens: "architecture",
        check: { type: "deterministic", check: "settings-present", params: {} },
      }),
    ).toBe("safe");
  });

  it("applies a rule to a change type as before for an old lens, by what the type covers for a question", () => {
    const old = { lens: "architecture" as const, check: { type: "ai" as const, prompt: "x" } };
    const safe = { lens: "safe" as const, check: { type: "ai" as const, prompt: "x" } };
    const ship = { lens: "ship" as const, check: { type: "ai" as const, prompt: "x" } };
    // An org pack's bug-fix type that still lists story, code-and-test and release.
    const bugFix = ["story", "code-and-test", "release"] as const;
    expect(typeTakes([...bugFix], old)).toBe(false);
    expect(typeTakes([...bugFix], safe)).toBe(false);
    expect(typeTakes([...bugFix], ship)).toBe(true);
    // The architecture lens reviewed security too.
    expect(typeTakes(["architecture"], safe)).toBe(true);
    expect(typeTakes(["safe"], { ...old, question: "safe" })).toBe(true);
    expect(typeTakes([], old)).toBe(true);
  });

  it("lets a pack tighten a constitution rule with its old lens, and refuses one that moves its question", async () => {
    const c = await loadConstitution();
    const base = c.rules.find((r) => r.id === "constitution.data-retention-stated")!;
    const tighten = (o: Partial<ChecklistRule>): ChecklistRule => ({
      ...base,
      id: "team.retention",
      layer: "team",
      tightens: base.id,
      question: undefined,
      ...o,
    });
    expect(loosenings(base, tighten({ lens: "architecture" }))).toEqual([]);
    expect(loosenings(base, tighten({ lens: "safe" }))).toEqual([]);
    expect(loosenings(base, tighten({ lens: "ship" }))).toEqual([
      "it moves the rule from the safe question to ship",
    ]);
    const layered = layerRules([
      { origin: "constitution", file: "built-in", pack: c },
      {
        origin: "team",
        file: "t.yaml",
        pack: {
          schemaVersion: 1,
          name: "t",
          version: "1.0.0",
          rules: [tighten({ lens: "architecture" })],
        },
      },
    ]);
    expect(layered.refused).toEqual([]);
    // It keeps the question of the rule it tightens.
    expect(layered.rules.find((r) => r.id === "team.retention")?.asks).toBe("safe");
  });
});

describe("code answers what code can: the checks the four questions add", () => {
  it("is it safe: a synchronous call with no timeout fact, merged with the pattern's resilience rule where both see it", async () => {
    const root = await forgeChangeRoot();
    const r = await runCritic(root, CHANGE, { now: NOW });
    const f = of(r, "review.call-timeout-stated");
    expect(f.map((x) => [x.finding.artifact, x.finding.locator.line, x.finding.summary])).toEqual([
      [
        "interfaces.md",
        8,
        "The call from portal-bff to audit-svc (POST /audit/events) states no timeout.",
      ],
    ]);
    expect(f[0]!.finding.severity).toBe("risk");
    expect(f[0]!.finding.lens).toBe("safe");
    expect(f[0]!.finding.layer).toBe("org");
    expect(f[0]!.finding.fix.text).toMatch(/^State the timeout for this call/);
    // The vendor and risk-engine calls are the pattern rule's (b04, b05), which also names this one.
    const b04 = of(r, "constitution.hop-resilience-stated").find(
      (x) => x.finding.locator.line === 7,
    )!;
    expect(b04.finding.why).toContain(
      "Also caught by vendor-timeouts-set, review.call-timeout-stated.",
    );

    // A timeout setting in the catalog is a fact that answers it; so is one stated in the notes.
    const withSetting = await forgeChangeRoot();
    await record(withSetting, {
      kind: "Setting",
      id: "portal-bff.audit-timeout",
      component: "portal-bff",
      settingKind: "timeout",
      key: "audit.client.timeout",
      valueOrRef: "1000ms",
      target: "audit-svc",
      evidence: [{ source: "config", repo: "forge-portal-bff", path: "application.yml", line: 9 }],
    });
    expect(
      of(await runCritic(withSetting, CHANGE, { now: NOW }), "review.call-timeout-stated"),
    ).toEqual([]);
    const noted = await forgeChangeRoot();
    await edit(
      noted,
      "interfaces.md",
      "portal-bff sends a limit-refused event to audit-svc.",
      "portal-bff sends a limit-refused event to audit-svc, with a 1 s timeout.",
    );
    expect(of(await runCritic(noted, CHANGE, { now: NOW }), "review.call-timeout-stated")).toEqual(
      [],
    );
  });

  it("lets the org turn off a starter check in its own file, unlike a constitution rule", async () => {
    const root = await forgeChangeRoot();
    const p = join(root, "org-pack/checklists/review.yaml");
    const text = await readFile(p, "utf8");
    // The first rule of the file is the timeout check: the org retires it in its own file.
    expect(text.indexOf("review.call-timeout-stated")).toBeLessThan(
      text.indexOf("review.store-write-rollback"),
    );
    await writeFile(
      p,
      text.replace(
        "    source: Atticus starter review\n",
        "    source: Atticus starter review\n    status: retired\n",
      ),
    );
    const r = await runCritic(root, CHANGE, { now: NOW });
    expect(r.refused).toEqual([]);
    expect(r.problems).toEqual([]);
    expect(of(r, "review.call-timeout-stated")).toEqual([]);
    expect(r.rules.skipped.find((s) => s.rule === "review.call-timeout-stated")?.reason).toBe(
      "status retired",
    );
    // The other one still runs.
    expect(of(r, "review.store-write-rollback")).toHaveLength(2);
    // The auth and breaking checks stay constitution rules: a pack that drops one is refused.
    const c = await loadConstitution();
    const auth = c.rules.find((x) => x.id === "constitution.public-entry-auth")!;
    const layered = layerRules([
      { origin: "constitution", file: "built-in", pack: c },
      {
        origin: "org",
        file: "o.yaml",
        pack: {
          schemaVersion: 1,
          name: "o",
          version: "1.0.0",
          rules: [
            { ...auth, id: "o.auth", layer: "org", tightens: auth.id, status: "retired" as const },
          ],
        },
      },
    ]);
    expect(layered.refused.map((x) => x.reason)).toEqual([
      "it loosens constitution.public-entry-auth: it sets status retired, which drops the rule",
    ]);
  });

  it("is it safe: an asynchronous hop needs no timeout", async () => {
    const root = await forgeChangeRoot();
    await edit(
      root,
      "interfaces.md",
      "| if-5c55930b735276a9 | portal-bff | audit-svc |  | POST /audit/events | none | planned-modify |",
      "| new | ledger-api | reports-job | A.EB.PUB | transfers.completed | none | planned-new |",
    );
    const r = await runCritic(root, CHANGE, { now: NOW, gate: "design" });
    // The audit call is still touched (change.yaml lists its interface, synchronous in the
    // catalog); the event the row now publishes is not a call anyone waits on.
    expect(summaries(r, "review.call-timeout-stated")).toEqual([
      "The call from portal-bff to audit-svc (POST /audit/events) states no timeout.",
    ]);
    expect(of(r, "review.call-timeout-stated")[0]!.finding.locator).toEqual({
      record: "if-5c55930b735276a9",
      field: "notes",
    });
  });

  it("is it safe: a public entry the change changes with no auth fact is asked; one that takes calls with no auth is a block", async () => {
    const root = await forgeChangeRoot();
    const r = await runCritic(root, CHANGE, { now: NOW });
    const gap = of(r, "constitution.public-entry-auth");
    expect(gap.map((x) => [x.finding.kind, x.finding.artifact, x.finding.locator.line])).toEqual([
      ["knowledge-gap", "interfaces.md", 8],
    ]);
    expect(gap[0]!.finding.summary).toBe(
      "Nothing says how audit-svc authenticates callers of POST /audit/events, which portal-bff calls from another system.",
    );
    expect(gap[0]!.finding.question?.text).toBe(
      "How does audit-svc authenticate callers of POST /audit/events (OAuth2, mTLS, an API key, or none)?",
    );
    // POST /transfers has an auth fact (the Endpoint), GET /accounts/{id}/limit goes through
    // gw-ledger-v1, whose scopes the gateway checks; the vendor and the unknown system aren't ours.

    const none = await forgeChangeRoot();
    await record(none, { ...AUDIT_CALL, auth: "none" });
    const b = of(await runCritic(none, CHANGE, { now: NOW }), "constitution.public-entry-auth");
    expect(b.map((x) => [x.finding.kind, x.finding.severity, x.finding.summary])).toEqual([
      [
        "issue",
        "blocking",
        "audit-svc takes POST /audit/events from portal-bff, in another system, with no authentication.",
      ],
    ]);
    expect(b[0]!.finding.evidence).toContainEqual({ source: "catalog", record: AUDIT_CALL.id });

    const oauth = await forgeChangeRoot();
    await record(oauth, { ...AUDIT_CALL, auth: "oauth2" });
    expect(
      of(await runCritic(oauth, CHANGE, { now: NOW }), "constitution.public-entry-auth"),
    ).toEqual([]);
  });

  it("is it safe: a breaking change to an operation another consumer calls, by fact (retired), by a judgment on file, or asked", async () => {
    // Retired: the catalog's change kind settles it.
    const retired = await forgeChangeRoot();
    await record(retired, REPORTS_CALL);
    await edit(
      retired,
      "interfaces.md",
      "| POST /transfers | api/ledger-openapi.yaml | planned-modify |",
      "| POST /transfers | api/ledger-openapi.yaml | planned-retire |",
    );
    const r1 = await runCritic(retired, CHANGE, { now: NOW });
    const f1 = of(r1, "constitution.breaking-delta-consumers");
    expect(f1.map((x) => [x.finding.kind, x.finding.severity, x.finding.summary])).toEqual([
      [
        "issue",
        "blocking",
        "Retiring POST /transfers breaks reports-job, which calls it today and which the change doesn't plan for.",
      ],
    ]);
    expect(f1[0]!.finding.evidence).toContainEqual({ source: "catalog", record: REPORTS_CALL.id });
    expect(f1[0]!.finding.fix.text).toMatch(/^Add a row to interfaces.md for reports-job/);

    // Changed, and nobody has judged whether callers must change: asked of the callee's owner.
    const open = await forgeChangeRoot();
    await record(open, REPORTS_CALL);
    const f2 = of(
      await runCritic(open, CHANGE, { now: NOW }),
      "constitution.breaking-delta-consumers",
    );
    expect(f2.map((x) => [x.finding.kind, x.finding.question])).toEqual([
      [
        "knowledge-gap",
        {
          text: "Must reports-job change its code to keep working once POST /transfers changes as interfaces.md says?",
          owner: "team-ledger",
        },
      ],
    ]);

    // A person (or the judge) said a caller must change: a block. Said it needn't: nothing.
    for (const verdict of ["yes", "no"] as const) {
      const root = await forgeChangeRoot();
      await record(root, REPORTS_CALL);
      await fileJudgments(root).put(
        makeJudgment({
          kind: "breaking",
          inputs: {
            v: 1,
            change: "planned-modify",
            operation: "POST /transfers",
            caller: "portal-bff",
            callee: "ledger-api",
            notes:
              "POST /transfers gains the LIMIT_EXCEEDED error (HTTP 422) and still goes through gw-ledger-v1.",
          },
          verdict,
          confirmedBy: { by: "person", name: "ari" },
          at: NOW,
        }),
      );
      const f = of(
        await runCritic(root, CHANGE, { now: NOW }),
        "constitution.breaking-delta-consumers",
      );
      expect(f.map((x) => [x.finding.kind, x.finding.severity])).toEqual(
        verdict === "yes" ? [["issue", "blocking"]] : [],
      );
    }
  });

  it("can it ship: a store write with no rollback step, in data.md and in a target flow", async () => {
    const root = await forgeChangeRoot();
    const r = await runCritic(root, CHANGE, { now: NOW });
    const f = of(r, "review.store-write-rollback");
    expect(f.map((x) => [x.finding.artifact, x.finding.locator.line, x.finding.summary])).toEqual([
      [
        "data.md",
        7,
        "The write to ledger-db.account has no rollback step: design.md's rollback names neither it nor V3__add_daily_limit.sql.",
      ],
      [
        "data.md",
        8,
        "The write to ledger-db.limit_change has no rollback step: design.md's rollback names neither it nor its migration.",
      ],
    ]);
    expect(f.every((x) => x.finding.severity === "risk" && x.finding.lens === "ship")).toBe(true);
    expect(f.every((x) => x.finding.layer === "org")).toBe(true);
    expect(f[0]!.finding.evidence).toContainEqual({
      source: "artifact",
      path: "design.md",
      line: 25,
      quote: "Migration first, then ledger-api, then portal-bff and portal-ui.",
    });

    // A rollback line that names the table, or its migration, is a step.
    const fixed = await forgeChangeRoot();
    await edit(
      fixed,
      "design.md",
      "Migration first, then ledger-api, then portal-bff and portal-ui.",
      "Migration first, then ledger-api, then portal-bff and portal-ui.\nTo roll back, redeploy the previous ledger-api; V3__add_daily_limit.sql only adds a column with a default, so it stays.\nRows written to limit_change in between are kept for the audit trail.",
    );
    expect(
      summaries(await runCritic(fixed, CHANGE, { now: NOW }), "review.store-write-rollback"),
    ).toEqual([]);

    // A target flow's write step is a store write too.
    const flows = await forgeChangeRoot();
    await write(
      flows,
      `openspec/changes/${CHANGE}/target-flows/ledger-api.create-transfer.yaml`,
      stringify({
        schemaVersion: 1,
        flow: "ledger-api.create-transfer",
        repo: "forge-ledger",
        change: "modify",
        why: "The limit is checked before the entry is written.",
        steps: [
          {
            op: "change",
            step: 3,
            kind: "write",
            what: "The entry is written with the limit it was checked against",
            store: {
              table: "ledger-db.entry",
              columns: ["checked_limit"],
              migration: "V4__entry_checked_limit.sql",
            },
          },
        ],
      }),
    );
    const tf = of(await runCritic(flows, CHANGE, { now: NOW }), "review.store-write-rollback");
    expect(tf.map((x) => [x.finding.artifact, x.finding.locator.line])).toContainEqual([
      "target-flows/ledger-api.create-transfer.yaml",
      12,
    ]);
  });
});

describe("one AI lens per question", () => {
  /** A model that answers every lens with nothing, recording who was asked what. */
  const model = (seen: AiRequest[]) =>
    new MockRuntime((r) => {
      seen.push(r);
      return "findings: []\n";
    });

  it("runs the lenses of the questions the gate's AI rules ask, each with its own agent and prompt", async () => {
    const root = await forgeChangeRoot();
    const seen: AiRequest[] = [];
    const r = await runCritic(root, CHANGE, { now: NOW, runtime: model(seen) });
    expect(r.lenses.map((l) => [l.lens, l.agent, l.state])).toEqual([
      ["complete", "complete-critic", "ran"],
      ["safe", "safe-critic", "ran"],
      ["ship", "ship-critic", "ran"],
    ]);
    expect(QUESTIONS).toEqual(["true", "complete", "safe", "ship"]);
    const ship = seen.find((s) => s.agent.id === "ship-critic")!.pack.prompt;
    expect(ship).toContain("# Critic: the ship lens (Can it ship?)");
    expect(ship).toContain("what breaks at 3 a.m.");
    // An org-pack rule written for the old delivery lens (design-has-rollback) is the ship lens's.
    expect(r.lenses.find((l) => l.lens === "ship")!.rules).toEqual([
      "design-has-rollback",
      "tasks-sequenced-for-lead-times",
      "release-plan-complete",
    ]);
  });

  it("keeps an org pack written for the old lenses working: its rules and agents map to the questions", async () => {
    const root = await forgeChangeRoot();
    for (const q of QUESTIONS)
      await rm(join(root, `org-pack/agents/${q}-critic.yaml`), { force: true });
    const agent = (id: string, runtimes: string[], inputs: string[]) =>
      write(
        root,
        `org-pack/agents/${id}.yaml`,
        stringify({
          schemaVersion: 1,
          id,
          role: "business-analyst",
          description: `The old ${id}.`,
          inputs,
          outputArtifact: "findings",
          checklist: "forge-architecture",
          tokenBudget: id === "story-critic" ? 60000 : 40000,
          allowedRuntimes: runtimes,
        }),
      );
    await agent(
      "story-critic",
      ["hand-off", "mock", "replay"],
      ["brief", "specs", "stories", "checklist"],
    );
    await agent("business-critic", ["mock", "model"], ["brief", "proposal", "specs", "checklist"]);
    await agent("delivery-critic", ["hand-off"], ["design", "tasks", "snow", "checklist"]);
    await agent("release-critic", ["replay"], ["snow", "tasks", "checklist"]);
    // The Ledger team's rules, written for the old lenses as a pack from before would be.
    const pack = join(root, "org-pack/teams/team-ledger/checklists/ledger-team.yaml");
    await writeFile(
      pack,
      (await readFile(pack, "utf8"))
        .replace(/lens: complete/g, "lens: story")
        .replace(/lens: ship/g, "lens: delivery")
        .replace(/lens: (safe|"true")/g, "lens: architecture"),
    );
    const seen: AiRequest[] = [];
    const r = await runCritic(root, CHANGE, { now: NOW, runtime: model(seen) });
    expect(r.refused).toEqual([]);
    // design-concurrency-handled, written for the architecture lens, is the true lens's now, run
    // by the agent made of the Forge pack's architecture-critic.
    expect(r.lenses.map((l) => [l.lens, l.agent, l.state])).toEqual([
      ["true", "true-critic", "ran"],
      ["complete", "complete-critic", "ran"],
      ["ship", "ship-critic", "failed"],
    ]);
    // The complete lens is made of the old business, story and code-and-test agents (the fixture
    // keeps code-and-test-critic for the spec hand-up): what any of them read, only the runtimes
    // all of them allow, the largest budget.
    const complete = seen.find((s) => s.agent.id === "complete-critic")!.agent;
    expect(complete.inputs).toEqual([
      "brief",
      "proposal",
      "specs",
      "stories",
      "tasks",
      "checklist",
      "repo-code",
    ]);
    expect(complete.allowedRuntimes).toEqual(["mock"]);
    expect(complete.tokenBudget).toBe(80000);
    expect(complete.description).toMatch(
      /Made from the org pack's business-critic, story-critic and code-and-test-critic\.$/,
    );
    // Old agents that share no runtime: the org pack decides, the lens doesn't run on a guess.
    expect(r.lenses.find((l) => l.lens === "ship")!.reason).toBe(
      "The org pack's old lens agents delivery-critic, release-critic allow no runtime in common, so the ship lens can't run; define ship-critic in org-pack/agents/.",
    );
    // Findings carry the question, whatever lens the rule was written with.
    expect(r.findings.every((f) => QUESTIONS.includes(f.finding.lens as never))).toBe(true);
  });

  it("narrows to the lenses asked for, by question or by an old lens's name", async () => {
    const root = await forgeChangeRoot();
    const r = await runCritic(root, CHANGE, { now: NOW, runtime: model([]), lenses: ["delivery"] });
    expect(r.lenses.map((l) => l.lens)).toEqual(["ship"]);
    expect(r.findings.every((f) => f.finding.lens === "ship")).toBe(true);
  });
});
