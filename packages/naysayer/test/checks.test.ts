import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCritic, type CriticResult } from "../src/index.js";
import { CHANGE, FIXTURES, NOW, changeDir, forgeChangeRoot, write } from "./helpers.js";

/**
 * Checks the seeded fixture doesn't exercise, each on a small edit of it. Each test changes
 * one artifact and looks for the finding that edit must produce.
 */

const summaries = (r: CriticResult, rule: string) =>
  r.findings.filter((f) => f.finding.rule === rule).map((f) => f.finding.summary);

async function edit(root: string, rel: string, from: string, to: string) {
  const p = join(changeDir(root), rel);
  const text = await readFile(p, "utf8");
  if (!text.includes(from)) throw new Error(`${rel} has no "${from}"`);
  await writeFile(p, text.replace(from, to));
}

const IFACE_HEADER = `# Interfaces

| Interface id | Caller | Callee | Pattern | Operation | Contract | Status |
| --- | --- | --- | --- | --- | --- | --- |
`;

describe("deterministic checks", () => {
  it("checks interface ids against the catalog", async () => {
    const root = await forgeChangeRoot();
    await write(
      root,
      `openspec/changes/${CHANGE}/interfaces.md`,
      `${IFACE_HEADER}| if-0000000000000000 | portal-bff | ledger-api | S.GW.SOR | POST /transfers | x | planned-modify |
| if-75b5e8d8aa780837 | portal-ui | ledger-api | S.GW.SOR | GET /accounts/{id}/balance | x | planned-modify |
| new | portal-bff | ledger-api | S.GW.SOR | GET /x | x | planned-modify |
| if-d99f508a2ac9b6e0 | portal-bff | ledger-api | S.GW.SOR | POST /transfers | x | planned-new |

## Notes

- All calls keep the 2 s timeout and circuit breaker to ledger-api through gw-ledger-v1.
`,
    );
    const r = await runCritic(root, CHANGE, { now: NOW, gate: "design" });
    expect(summaries(r, "constitution.interface-ids-in-catalog")).toEqual([
      "Interface if-0000000000000000 is not in the catalog.",
      "Interface if-75b5e8d8aa780837 is portal-bff → ledger-api in the catalog, but the row says portal-ui → ledger-api.",
      "The new hop portal-bff → ledger-api (GET /x) has status planned-modify, not planned-new.",
      "Interface if-d99f508a2ac9b6e0 already exists, so it can't be planned-new.",
    ]);
  });

  it("asks for a pattern when none fits, refuses unapproved patterns, and checks vendor routes", async () => {
    const root = await forgeChangeRoot();
    await write(
      root,
      `openspec/changes/${CHANGE}/interfaces.md`,
      `${IFACE_HEADER}| new | reports-job | ledger-db | D.JDBC | read entry | x | planned-new |
| new | portal-bff | audit-svc | none fits: a fire-and-forget audit call | POST /audit/events | x | planned-new |
| new | ledger-api | northwind-pay | S.GW.VND | POST /v2/payments | x | planned-new |
| if-e7344c9455608119 | ledger-api | northwind-pay | S.GW.VND | POST /v2/payments | x | planned-modify |

## Notes

- POST /v2/payments keeps a 2 s timeout and 2 retries with an idempotency key.
`,
    );
    const r = await runCritic(root, CHANGE, { now: NOW, gate: "design" });
    expect(summaries(r, "constitution.interface-approved-pattern")).toEqual([
      "The hop reports-job → ledger-db (read entry) uses pattern D.JDBC, which is to-review, not approved.",
      "The hop portal-bff → audit-svc (POST /audit/events) names no integration pattern.",
    ]);
    // The Forge constitution rule: vendor calls go through the gateway and name the route.
    expect(summaries(r, "vendor-calls-through-gateway")).toEqual([
      "The hop ledger-api → northwind-pay (POST /v2/payments) goes via the gateway but names no gateway route.",
      "The hop ledger-api → northwind-pay (POST /v2/payments) goes via the gateway but names no gateway route.",
      // The row names an existing interface, so the change touches it, and the code calls direct (d01).
      "Interface if-e7344c9455608119 (ledger-api → northwind-pay) goes direct in the code, but S.GW.VND requires the gateway.",
    ]);
  });

  it("finds a touched catalog interface that takes the wrong route (d01)", async () => {
    const root = await forgeChangeRoot();
    await edit(
      root,
      "change.yaml",
      "    - id: if-d99f508a2ac9b6e0\n      status: planned-modify",
      "    - id: if-d99f508a2ac9b6e0\n      status: planned-modify\n    - id: if-e7344c9455608119\n      status: planned-modify",
    );
    const r = await runCritic(root, CHANGE, { now: NOW, gate: "design" });
    const f = r.findings.find((x) => x.finding.rule === "vendor-calls-through-gateway")!.finding;
    expect(f.summary).toBe(
      "Interface if-e7344c9455608119 (ledger-api → northwind-pay) goes direct in the code, but S.GW.VND requires the gateway.",
    );
    expect(f.locator).toEqual({ record: "if-e7344c9455608119", field: "via" });
    expect(f.layer).toBe("constitution");
    expect(f.evidence[1]).toEqual({
      source: "code",
      repo: "forge-ledger",
      path: "src/main/java/forge/ledger/NorthwindClient.java",
      line: 8,
    });
  });

  it("requires data.md when a data store is touched, and scenarios for every requirement", async () => {
    const root = await forgeChangeRoot();
    await rm(join(changeDir(root), "data.md"));
    await write(
      root,
      `openspec/changes/${CHANGE}/specs/transfer-limits/spec.md`,
      "## ADDED Requirements\n\n### Requirement: Daily transfer limit\nThe system SHALL refuse transfers over the limit.\n",
    );
    const r = await runCritic(root, CHANGE, { now: NOW, gate: "design" });
    expect(summaries(r, "constitution.data-doc-present")).toEqual([
      "The change touches ledger-db but data.md is missing.",
    ]);
    expect(summaries(r, "constitution.spec-scenarios-present")).toEqual([
      "Requirement: Daily transfer limit has no scenario with WHEN and THEN.",
    ]);
  });

  it("accepts an alert the design plans, and asks about the others", async () => {
    const root = await forgeChangeRoot();
    await edit(
      root,
      "design.md",
      "## Rollout and rollback",
      "An alert on portal-bff's error rate is added with this change.\n\n## Rollout and rollback",
    );
    const r = await runCritic(root, CHANGE, { now: NOW });
    expect(
      r.findings
        .filter((f) => f.finding.rule === "jobs-have-alerts")
        .map((f) => f.finding.locator.record),
    ).toEqual(["audit-svc"]);
  });

  it("raises a knowledge gap when every fact a rule needs is older than its freshness window", async () => {
    const root = await forgeChangeRoot();
    for (const id of ["portal-bff.ledger-read-timeout", "portal-bff.ledger-connect-timeout"]) {
      const p = join(root, "catalog/generated/setting", `${id}.yaml`);
      const text = await readFile(p, "utf8");
      await writeFile(p, text.replace(/(line: \d+)/, "$1\n    scannedAt: 2025-01-02T00:00:00Z"));
    }
    await write(
      root,
      "teams/fresh.yaml",
      `schemaVersion: 1
name: fresh
version: 0.1.0
rules:
  - id: fresh-timeouts
    title: Timeouts were seen recently
    layer: team
    lens: architecture
    appliesTo: { artifacts: [interfaces, catalog] }
    severity: risk
    check: { type: deterministic, check: settings-present, params: { fromPattern: true } }
    waivable: false
    source: test
    needs:
      - kind: Setting
        field: settingKind
        scope: touched-components
        freshForDays: 180
        question: "Are the timeouts of \${record} still right?"
`,
    );
    const r = await runCritic(root, CHANGE, {
      now: NOW,
      gate: "design",
      teamPacks: ["teams/fresh.yaml"],
    });
    const f = r.findings.find(
      (x) => x.finding.rule === "fresh-timeouts" && x.finding.kind === "knowledge-gap",
    )!.finding;
    expect(f.summary).toBe(
      "Every Setting settingKind for portal-bff is older than 180 days (portal-bff.ledger-connect-timeout, portal-bff.ledger-read-timeout).",
    );
    expect(f.question).toEqual({
      text: "Are the timeouts of portal-bff still right?",
      owner: "team-portal",
    });
  });

  it("checks an AI rule's needs in layer 1, even with no AI runtime", async () => {
    const root = await forgeChangeRoot();
    await write(
      root,
      "teams/ai-needs.yaml",
      `schemaVersion: 1
name: ai-needs
version: 0.1.0
rules:
  - id: audit-retention-judged
    title: Audit events are kept long enough
    layer: team
    lens: architecture
    appliesTo: { artifacts: [design] }
    severity: risk
    check: { type: ai, prompt: "Judge whether audit events are kept long enough for the auditors' needs." }
    waivable: false
    source: test
    needs:
      - kind: Obligation
        scope: touched-systems
        question: "What retention does \${record} promise?"
`,
    );
    const r = await runCritic(root, CHANGE, {
      now: NOW,
      gate: "design",
      teamPacks: ["teams/ai-needs.yaml"],
    });
    const gaps = r.findings.filter((f) => f.finding.rule === "audit-retention-judged");
    expect(gaps.map((f) => [f.layer, f.finding.kind, f.finding.locator.record])).toEqual([
      ["deterministic", "knowledge-gap", "audit"],
      ["deterministic", "knowledge-gap", "ledger"],
      ["deterministic", "knowledge-gap", "northwind-pay"],
      ["deterministic", "knowledge-gap", "portal"],
    ]);
    expect(r.rules.skipped).toContainEqual({
      rule: "audit-retention-judged",
      reason: "not run: no AI runtime",
    });
  });

  it("reports rules it can't run instead of passing them", async () => {
    const root = await forgeChangeRoot();
    await write(
      root,
      "org-pack/teams/team-ledger/checklists/broken.yaml",
      `schemaVersion: 1
name: broken
version: 0.1.0
rules:
  - id: unknown-check
    title: Uses a check nobody has written
    layer: team
    lens: architecture
    appliesTo: { artifacts: [interfaces] }
    severity: risk
    check: { type: deterministic, check: no-such-check }
    waivable: false
    source: test
  - id: bad-params
    title: Gives a check the wrong parameters
    layer: team
    lens: architecture
    appliesTo: { artifacts: [interfaces] }
    severity: risk
    check: { type: deterministic, check: fact-known, params: { kind: Nothing } }
    waivable: false
    source: test
`,
    );
    const r = await runCritic(root, CHANGE, { now: NOW });
    expect(r.problems[0]).toBe(
      "Rule unknown-check names check no-such-check, which doesn't exist, so it did not run.",
    );
    expect(r.problems[1]).toMatch(/^Rule bad-params: bad parameters for fact-known: /);
    expect(r.rules.skipped).toEqual(
      expect.arrayContaining([
        { rule: "unknown-check", reason: "unknown check no-such-check" },
        { rule: "bad-params", reason: "bad check parameters" },
      ]),
    );
  });

  it("refuses a team pack that loosens a constitution rule and reports it on the run", async () => {
    const root = await forgeChangeRoot();
    await write(
      root,
      "teams/loosening.yaml",
      await readFile(join(FIXTURES, "loosening-team.yaml"), "utf8"),
    );
    const res = await runCritic(root, CHANGE, {
      now: NOW,
      teamPacks: ["teams/loosening.yaml"],
      gate: "design",
    });
    expect(res.refused).toEqual([
      {
        pack: "loosening-team",
        file: "teams/loosening.yaml",
        rule: "relaxed-stories",
        reason:
          "it loosens constitution.story-acceptance-criteria: it lowers severity from blocking to idea",
      },
    ]);
    // Nothing from the refused pack ran.
    expect(res.findings.some((f) => f.finding.rule === "extra-idea")).toBe(false);
  });
});
