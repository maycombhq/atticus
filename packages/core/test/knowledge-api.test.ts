import { describe, expect, it } from "vitest";
import { Api, API_VERSION, openApiDocument } from "../src/index.js";

/** ADR 0102: the knowledge API in C4, additive from 2.7.0. */

const doc = openApiDocument() as {
  paths: Record<string, Record<string, { operationId: string; tags: string[] }>>;
  components: { schemas: Record<string, unknown> };
};

describe("the knowledge API (ADR 0102)", () => {
  it("is in the OpenAPI document, from API 2.7.0", () => {
    const [major, minor] = API_VERSION.split(".").map(Number);
    expect(major === 2 && minor! >= 7).toBe(true);
    const ops: [string, string, string][] = [
      ["/api/knowledge/sources", "get", "listKnowledgeSources"],
      ["/api/knowledge/sources", "post", "addKnowledgeSource"],
      ["/api/knowledge/sources/{sourceId}/sync", "post", "syncKnowledgeSource"],
      ["/api/knowledge/scan", "get", "getKnowledgeScan"],
      ["/api/knowledge/items", "get", "listKnowledgeItems"],
      ["/api/knowledge/items/{itemId}/review", "post", "reviewKnowledgeItem"],
      ["/api/knowledge/search", "get", "searchWikis"],
      ["/api/knowledge/finds", "get", "listFinds"],
      ["/api/knowledge/finds/{slug}", "get", "getFind"],
      ["/api/knowledge/finds/{slug}/keep", "post", "keepFound"],
      ["/api/changes/{changeId}/needs", "get", "getChangeNeeds"],
      ["/api/changes/{changeId}/needs/{itemId}", "post", "markChangeNeed"],
      ["/api/orgpack/draft", "get", "getOrgPackDraft"],
      ["/api/orgpack/draft", "post", "draftOrgPack"],
      ["/api/orgpack/draft/{platform}/accept", "post", "acceptOrgPackDraft"],
    ];
    for (const [path, method, id] of ops) expect(doc.paths[path]![method]!.operationId).toBe(id);
    for (const s of [
      "KnowledgeSourceList",
      "KnowledgeItemList",
      "KnowledgeScanView",
      "ReviewedItem",
      "WikiSearchResult",
      "SavedFindList",
      "ChangeNeedsView",
      "MarkedNeed",
      "OrgPackDraftView",
      "AcceptedOrgPack",
    ])
      expect(doc.components.schemas).toHaveProperty(s);
  });

  it("takes a source as sources add does, and saves it unless told not to", () => {
    const b = Api.AddSourceRequest.parse({
      type: "git",
      location: "https://git.example.com/forge/wiki.git",
      path: "pages",
      ref: "main",
      submodule: true,
      kinds: ["change-process"],
    });
    expect(b.save).toBe(true);
    expect(Api.AddSourceRequest.safeParse({ type: "wiki", location: "x" }).success).toBe(false);
    expect(
      Api.AddSourceRequest.safeParse({ type: "git", location: "x", kinds: ["Not A Slug"] }).success,
    ).toBe(false);
  });

  it("takes a review's verdict, a correction's lists and links, and a need's status", () => {
    expect(
      Api.ReviewItemRequest.parse({
        verdict: "corrected",
        set: {
          leadTime: "3 working days",
          steps: ["Open the catalogue", "Pick Kafka topic"],
          urls: [{ label: "Form", url: "https://servicedesk.example.com/kafka" }],
        },
      }).set,
    ).toHaveProperty("urls");
    expect(Api.ReviewItemRequest.safeParse({ verdict: "maybe" }).success).toBe(false);
    expect(Api.MarkNeedRequest.safeParse({ status: "skipped" }).success).toBe(false);
    expect(Api.MarkNeedRequest.parse({ status: "not-needed", note: "SSO is set up" }).note).toBe(
      "SSO is set up",
    );
    expect(Api.AcceptOrgPackRequest.safeParse({ only: [] }).success).toBe(false);
  });
});
