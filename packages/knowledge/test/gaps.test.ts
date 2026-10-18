import { describe, expect, it } from "vitest";
import { parseRecord } from "@maycombhq/core";
import { KNOWLEDGE_CHECKS, knowledgeGaps } from "../src/index.js";
import { forgeExpected, forgePack, forgeRecords, record } from "./helpers.js";

interface Discrepancy {
  id: string;
  found_by: string;
  refs: string[];
}

describe("knowledge gaps on the expected Forge catalog", () => {
  it("every check declares what it needs", () => {
    for (const c of KNOWLEDGE_CHECKS) {
      expect(c.needs.length).toBeGreaterThan(0);
      for (const n of c.needs) expect(n.what).toBeTruthy();
    }
  });

  it("finds exactly the seeded gaps d09-d11 and nothing else", async () => {
    const gaps = knowledgeGaps({ records: forgeRecords(), orgPack: await forgePack() });
    const seeded = forgeExpected<Discrepancy[]>("discrepancies.yaml").filter(
      (d) => d.found_by === "knowledge-gap",
    );
    expect(seeded.map((d) => d.id)).toEqual([
      "d09-no-vendor-timeouts",
      "d10-no-reports-alerts",
      "d11-audit-unknown-owner",
    ]);
    expect(gaps.map((g) => g.records)).toEqual(seeded.map((d) => d.refs));
    expect(gaps.map((g) => [g.check, g.system, g.owner, g.routeTo])).toEqual([
      ["call-resilience-known", "ledger", "team-ledger", undefined],
      ["unattended-workload-monitored", "reports", "team-reports", undefined],
      // Audit has no owner in the profile, so the platform owner (pack.yaml) gets the question.
      ["component-source-known", "audit", "team-platform", undefined],
    ]);
  });

  it("raises each gap as an OwnerQuestion record that passes C1", async () => {
    const gaps = knowledgeGaps({ records: forgeRecords(), orgPack: await forgePack() });
    expect(gaps.map((g) => g.question)).toEqual([
      {
        schemaVersion: 2,
        kind: "OwnerQuestion",
        id: "q.call-resilience-known.if-e7344c9455608119",
        status: "current",
        confidence: "inferred",
        system: "ledger",
        owner: "team-ledger",
        question:
          "What timeout and retry settings does ledger-api use when it calls northwind-pay? Pattern S.GW.VND needs them (OAuth2 or mTLS at the gateway, timeout, retry with idempotency key).",
        neededFact: "Setting (timeout, retry) on ledger-api targeting northwind-pay",
        channel: "ado",
        questionState: "sent",
        evidence: [
          {
            source: "code",
            repo: "forge-ledger",
            path: "src/main/java/forge/ledger/NorthwindClient.java",
            line: 8,
            side: "caller",
            dialect: "forge@0.1.0",
          },
          {
            source: "spec",
            path: "inputs/partner-specs/northwind-pay-openapi.yaml",
            line: 6,
            side: "callee",
          },
        ],
      },
      {
        schemaVersion: 2,
        kind: "OwnerQuestion",
        id: "q.unattended-workload-monitored.reports-job",
        status: "current",
        confidence: "inferred",
        system: "reports",
        owner: "team-reports",
        question:
          "Which alert or dashboard watches reports-job? It runs without a caller waiting (a batch job and an event consumer), so a failure goes unnoticed without one.",
        neededFact: "ObservabilityAsset (alert or dashboard) for reports-job",
        channel: "ado",
        questionState: "sent",
        evidence: [
          {
            source: "code",
            repo: "forge-reports-job",
            path: "src/main/java/forge/reports/DailyEntriesJob.java",
          },
        ],
      },
      {
        schemaVersion: 2,
        kind: "OwnerQuestion",
        id: "q.component-source-known.audit-svc",
        status: "current",
        confidence: "inferred",
        system: "audit",
        owner: "team-platform",
        question:
          "Who owns audit-svc, which repo holds its code, and is there an interface spec? It is known only from calls by portal-bff.",
        neededFact: "Component repo, System owner and an interface spec for audit-svc",
        channel: "ado",
        questionState: "sent",
        evidence: [
          {
            source: "config",
            repo: "forge-portal-bff",
            path: "src/main/resources/application.yml",
            line: 4,
            side: "caller",
          },
        ],
      },
    ]);
    for (const g of gaps) expect(parseRecord(g.question).ok).toBe(true);
  });
});

describe("knowledge gaps close when the fact arrives, and stay open while unanswered", () => {
  const vendorSettings = [
    record({
      kind: "Setting",
      id: "ledger-api.northwind-timeout",
      confidence: "verified",
      component: "ledger-api",
      settingKind: "timeout",
      key: "northwind.timeout",
      valueOrRef: "2000ms",
      target: "northwind-pay",
      evidence: [
        {
          source: "config",
          repo: "forge-ledger",
          path: "forge.yaml",
          line: 9,
          scannedAt: "2026-01-01T00:00:00Z",
        },
      ],
    }),
    record({
      kind: "Setting",
      id: "ledger-api.northwind-retries",
      confidence: "verified",
      component: "ledger-api",
      settingKind: "retry",
      key: "northwind.retries",
      valueOrRef: "2",
      target: "northwind-pay",
      evidence: [
        {
          source: "config",
          repo: "forge-ledger",
          path: "forge.yaml",
          line: 10,
          scannedAt: "2026-10-01T00:00:00Z",
        },
      ],
    }),
  ];
  const dashboard = record({
    kind: "ObservabilityAsset",
    id: "reports-job.dashboard",
    confidence: "verified",
    component: "reports-job",
    assetKind: "dashboard",
    name: "Reports job runs",
    evidence: [{ source: "infrastructure", repo: "forge-infra", path: "dashboards/reports.json" }],
  });

  it("drops d09 and d10 once the settings and a dashboard are in the catalog", async () => {
    const gaps = knowledgeGaps({
      records: [...forgeRecords(), ...vendorSettings, dashboard],
      orgPack: await forgePack(),
    });
    expect(gaps.map((g) => g.question.id)).toEqual(["q.component-source-known.audit-svc"]);
  });

  it("asks again when a needed fact is older than the pack's freshness window", async () => {
    const gaps = knowledgeGaps({
      records: [...forgeRecords(), ...vendorSettings, dashboard],
      orgPack: await forgePack(),
      now: "2026-10-18T00:00:00Z",
    });
    const stale = gaps.find((g) => g.check === "call-resilience-known")!;
    expect(stale.stale).toEqual(["ledger-api.northwind-timeout"]);
    expect(stale.question.question).toMatch(/^Are these settings still right\?/);
    expect(stale.question.neededFact).toBe(
      "Setting (timeout) on ledger-api targeting northwind-pay, last seen 2026-01-01",
    );
  });

  it("keeps the state and answer of a question already raised", async () => {
    const answered = record({
      kind: "OwnerQuestion",
      id: "q.component-source-known.audit-svc",
      confidence: "inferred",
      system: "audit",
      owner: "team-platform",
      question: "Who owns audit-svc?",
      neededFact: "owner",
      channel: "teams",
      questionState: "answered",
      answer: "The audit team; repo forge-audit.",
      evidence: [{ source: "manual", by: "a.architect" }],
    });
    const gaps = knowledgeGaps({
      records: [...forgeRecords(), answered],
      orgPack: await forgePack(),
    });
    const q = gaps.find((g) => g.check === "component-source-known")!.question;
    // The answer is shown, but the gap stays until the catalog holds the fact: never guessed.
    expect(q).toMatchObject({
      questionState: "answered",
      answer: "The audit team; repo forge-audit.",
      channel: "teams",
    });
  });

  it("routes to the architect when nobody owns the system or the platform", async () => {
    const op = await forgePack();
    const gaps = knowledgeGaps({ records: forgeRecords(), orgPack: { ...op, pack: undefined } });
    const g = gaps.find((x) => x.check === "component-source-known")!;
    expect([g.owner, g.routeTo, g.question.owner, g.question.flags]).toEqual([
      "unassigned",
      "architect",
      "unassigned",
      ["route:architect"],
    ]);
  });
});
