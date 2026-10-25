import { describe, expect, it } from "vitest";
import { Api, API_VERSION, openApiDocument } from "../src/index.js";

/** API 2.23.0 (ADR 0124 addendum D-app): the Map's evidence and corrections, a stage tab's findings and comments. */

const doc = openApiDocument() as {
  info: { version: string };
  paths: Record<string, Record<string, { operationId: string }>>;
  components: { schemas: Record<string, unknown> };
};

describe("the Map's evidence and a stage tab's findings in the local API (C4 2.23.0)", () => {
  it("documents the four calls and their answers", () => {
    // The version has moved on (2.24.0, trust-api.test.ts); these calls are still there.
    expect(doc.info.version).toBe(API_VERSION);
    expect(doc.paths["/api/facts/{repo}"]!.get!.operationId).toBe("getRepoFacts");
    expect(doc.paths["/api/facts/{repo}/corrections"]!.post!.operationId).toBe("correctFact");
    expect(doc.paths["/api/changes/{changeId}/stages/{stage}"]!.get!.operationId).toBe(
      "getStageReview",
    );
    expect(doc.paths["/api/changes/{changeId}/stages/{stage}/comments"]!.post!.operationId).toBe(
      "commentOnFinding",
    );
    for (const s of [
      "RepoFactsView",
      "FactCorrectionResult",
      "StageReviewView",
      "StageCommentResult",
    ])
      expect(doc.components.schemas).toHaveProperty(s);
  });

  it("takes a correction as wrong or edit only, and a comment with words in it", () => {
    expect(
      Api.FactCorrectionRequest.safeParse({ fact: "e-1", action: "wrong", reason: "no" }).success,
    ).toBe(true);
    expect(Api.FactCorrectionRequest.safeParse({ fact: "e-1", action: "drop" }).success).toBe(
      false,
    );
    expect(
      Api.FactCorrectionRequest.safeParse({ fact: "e-1", action: "edit", by: "me" }).success,
    ).toBe(false);
    expect(Api.StageCommentRequest.safeParse({ finding: "f-1", text: "  " }).success).toBe(false);
    expect(Api.StageCommentRequest.safeParse({ finding: "f-1", text: "Use 402." }).success).toBe(
      true,
    );
    expect(Api.StageTab.options).toEqual(["feature", "architecture", "stories"]);
  });
});
