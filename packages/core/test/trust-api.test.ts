import { describe, expect, it } from "vitest";
import { Api, API_VERSION, openApiDocument } from "../src/index.js";

/** API 2.22.0 (ADR 0124 addendum): the Trust tab, a change's knowledge.yaml and `full` in health. */

const doc = openApiDocument() as {
  info: { version: string };
  paths: Record<string, Record<string, { operationId: string }>>;
  components: { schemas: Record<string, unknown> };
};

describe("the app's six entries in the local API (C4 2.22.0)", () => {
  it("documents the trust view, the change's knowledge and setting an item's status", () => {
    expect(doc.paths["/api/trust"]!.get!.operationId).toBe("getTrust");
    expect(doc.paths["/api/changes/{changeId}/knowledge"]!.get!.operationId).toBe(
      "getChangeKnowledge",
    );
    expect(doc.paths["/api/changes/{changeId}/knowledge/{itemId}"]!.post!.operationId).toBe(
      "setChangeKnowledge",
    );
    for (const s of ["TrustView", "ChangeKnowledgeView", "SetChangeKnowledgeResult"])
      expect(doc.components.schemas).toHaveProperty(s);
  });

  it("holds a repo's facts, report, checkout and where its catalog comes from", () => {
    const repo = {
      repo: "forge-ledger",
      facts: { path: "facts/forge-ledger.jsonl", present: true, count: 2, unverified: 0 },
      verify: { path: "facts/forge-ledger.verify.yaml", report: null },
      checkout: { path: "workspace/forge-ledger", present: false },
      sameCommit: null,
      catalog: { from: "facts", fromFacts: 3, fromReaders: 0 },
      state: "unverified",
      next: { command: "atticus verify forge-ledger" },
    };
    expect(
      Api.TrustView.parse({ factsDir: "facts", repos: [repo], problems: [] }).repos,
    ).toHaveLength(1);
    expect(Api.TrustRepo.safeParse({ ...repo, state: "fine" }).success).toBe(false);
    expect(
      Api.TrustRepo.safeParse({ ...repo, catalog: { ...repo.catalog, from: "x" } }).success,
    ).toBe(false);
  });

  it("takes confirmed or excluded only, and says whether the app was started with --full", () => {
    expect(Api.SetChangeKnowledgeRequest.safeParse({ status: "confirmed" }).success).toBe(true);
    expect(Api.SetChangeKnowledgeRequest.safeParse({ status: "suggested" }).success).toBe(false);
    expect(Api.SetChangeKnowledgeRequest.safeParse({ status: "excluded", x: 1 }).success).toBe(
      false,
    );
    const h = { version: "1", apiVersion: "2.22.0", schemaVersion: 2, root: "/m", user: "pat" };
    expect(Api.Health.parse({ ...h, full: true }).full).toBe(true);
    expect(Api.Health.parse(h).full).toBeUndefined();
  });
});

/** API 2.24.0 (ADR 0124 addendum B2): a change's knowledge with titles and why in plain words. */
describe("a change's knowledge with titles and a plain why (C4 2.24.0)", () => {
  it("is 2.24.0 or later, and an item and a near-miss may carry a title and a reason; older answers still parse", () => {
    const [major, minor] = API_VERSION.split(".").map(Number);
    expect(major).toBe(2);
    expect(minor).toBeGreaterThanOrEqual(24);
    expect(doc.info.version).toBe(API_VERSION);
    const item = {
      id: "forge-wiki/fraud.md#Timeouts",
      kind: "WikiSection",
      status: "suggested",
      stages: ["feature"],
      score: 1.2,
      why: "search (words #1)",
    };
    const v = {
      change: "add-limit",
      file: "openspec/changes/add-limit/knowledge.yaml",
      present: true,
      items: [
        { ...item, title: "Fraud › Timeouts", reason: "Its words match the change's words." },
      ],
      nearMisses: [
        { id: "p3", kind: "Pattern", score: 0.4, stage: "feature", title: "File transfer" },
      ],
      command: "atticus change knowledge add-limit",
    };
    const parsed = Api.ChangeKnowledgeView.parse(v);
    expect(parsed.items[0]!.title).toBe("Fraud › Timeouts");
    expect(parsed.items[0]!.reason).toBe("Its words match the change's words.");
    expect(parsed.nearMisses[0]!.title).toBe("File transfer");
    // 2.23.0's answer, without either, is still one.
    expect(
      Api.ChangeKnowledgeView.safeParse({
        ...v,
        items: [item],
        nearMisses: [{ id: "p3", kind: "Pattern", score: 0.4, stage: "feature" }],
      }).success,
    ).toBe(true);
  });
});

/**
 * API 2.25.0 (ADR 0124 addendum B-task-knowledge): the tasks whose own selection picked an item,
 * and the pages that disagree, with who decided which applies, on a change's knowledge and on an
 * item of the Knowledge page.
 */
describe("a change's knowledge per task, and pages that disagree (C4 2.25.0)", () => {
  const conflict = {
    key: "sso-setup @ forge-wiki/sso-notes.md | forge-wiki/sso-setup.md",
    about: ["sso-setup"],
    summary: "the redirect URI",
    pages: [
      { source: "forge-wiki", page: "sso-setup.md", says: "Set the redirect URI to /a." },
      { source: "forge-wiki", page: "sso-notes.md", says: "Set the redirect URI to /b." },
    ],
    applies: [{ source: "forge-wiki", page: "sso-setup.md" }],
    decided: { by: "person", who: "sam", at: "2026-10-24T10:00:00Z", question: "q-0123456789ab" },
    question: { id: "q-0123456789ab", state: "answered", repo: "add-sso" },
  };

  it("is 2.25.0, and a change's item may name its tasks and the view its conflicts", () => {
    const [, minor] = API_VERSION.split(".").map(Number);
    expect(minor).toBeGreaterThanOrEqual(25);
    expect(doc.components.schemas).toHaveProperty("KnowledgeConflictView");
    const v = Api.ChangeKnowledgeView.parse({
      change: "add-sso",
      file: "openspec/changes/add-sso/knowledge.yaml",
      present: true,
      items: [
        {
          id: "sso-setup",
          kind: "ProcessDefinition",
          status: "suggested",
          stages: [],
          score: 1,
          tasks: ["1.1"],
        },
      ],
      nearMisses: [],
      conflicts: [conflict],
      command: "atticus change knowledge add-sso",
    });
    expect(v.items[0]!.tasks).toEqual(["1.1"]);
    expect(v.conflicts![0]!.decided).toMatchObject({ by: "person", who: "sam" });
    // Settled by the code, or not yet with a signal's suggestion: both parse.
    expect(
      Api.KnowledgeConflictView.safeParse({
        ...conflict,
        decided: {
          by: "code",
          record: "forge-orders.get-login",
          kind: "Endpoint",
          value: "/a",
          at: "forge-orders:src/main/resources/application.yml:12",
        },
      }).success,
    ).toBe(true);
    const { decided: _d, question: _q, ...open } = conflict;
    expect(
      Api.KnowledgeConflictView.safeParse({
        ...open,
        applies: [],
        suggested: {
          source: "forge-wiki",
          page: "sso-setup.md",
          signal: "last-edited",
          detail: "sso-setup.md was last edited later",
        },
      }).success,
    ).toBe(true);
    // A signal is never a decision.
    expect(
      Api.KnowledgeConflictView.safeParse({
        ...conflict,
        decided: { by: "signal", signal: "last-edited", detail: "later" },
      }).success,
    ).toBe(false);
  });

  it("gives an item of the Knowledge page its conflicts, and 2.24.0's item still parses", () => {
    const item = {
      id: "sso-setup",
      kind: "process",
      recordKind: "ProcessDefinition",
      title: "Set up SSO for a Forge service",
      record: {},
      fields: {},
      conflict: true,
    };
    expect(Api.KnowledgeItemView.parse({ ...item, conflicts: [conflict] }).conflicts).toHaveLength(
      1,
    );
    expect(Api.KnowledgeItemView.safeParse(item).success).toBe(true);
  });
});
