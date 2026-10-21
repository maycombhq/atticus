import { describe, expect, it } from "vitest";
import { Api, openApiDocument } from "../src/index.js";

describe("the onboarding view (ADR 0084)", () => {
  it("is in the OpenAPI document", () => {
    const doc = openApiDocument() as {
      paths: Record<string, Record<string, { operationId: string }>>;
      components: { schemas: Record<string, unknown> };
    };
    expect(doc.paths["/api/onboarding"]!.get!.operationId).toBe("getOnboarding");
    expect(doc.components.schemas).toHaveProperty("OnboardingView");
  });

  it("holds each repo's manifest, clone, scan settings and last scan, and the knowledge sources", () => {
    const v = Api.OnboardingView.parse({
      manifests: [
        { platform: "forge", path: "org-pack/profiles/forge/repos.manifest.yaml", repos: 1 },
      ],
      repos: [
        {
          id: "forge-ledger",
          platform: "forge",
          type: "forge-service",
          owner: "team-ledger",
          manifest: "org-pack/profiles/forge/repos.manifest.yaml",
          cloned: true,
          scanSettings: { path: "org-pack/scan/forge-ledger.yaml", present: false },
          lastScan: { records: 3, kinds: { Endpoint: 2, Table: 1 }, commit: "abc1234" },
        },
        {
          id: "forge-events",
          platform: "forge",
          type: "event-config",
          owner: "team-platform",
          manifest: "org-pack/profiles/forge/repos.manifest.yaml",
          cloned: false,
          scanSettings: { path: "org-pack/scan/forge-events.yaml", present: false },
          lastScan: null,
        },
      ],
      sources: {
        path: "org-pack/sources.yaml",
        present: true,
        wikis: [{ id: "forge-wiki", type: "markdown-folder", location: "wiki", spaces: [] }],
        absorbed: [],
      },
      catalog: { records: 3 },
      problems: [],
    });
    expect(v.repos[1]!.lastScan).toBeNull();
    expect(
      Api.OnboardingView.safeParse({ ...v, repos: [{ ...v.repos[0], cloned: "yes" }] }).success,
    ).toBe(false);
  });
});
