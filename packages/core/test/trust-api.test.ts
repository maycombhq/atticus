import { describe, expect, it } from "vitest";
import { Api, openApiDocument } from "../src/index.js";

/** API 2.22.0 (ADR 0124 addendum): the Trust tab, a change's knowledge.yaml and `full` in health. */

const doc = openApiDocument() as {
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
