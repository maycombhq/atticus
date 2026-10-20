import { describe, expect, it } from "vitest";
import { Dialect } from "@maycombhq/core";
import { memoryRepo, scanRepo } from "@maycombhq/sdk";
import { dialectExtractor } from "../src/index.js";

const pipeline = `pipeline:
  name: Cards deploy
  identifier: cards_deploy
  stages:
    - stage:
        name: Build
        type: CI
    - stage:
        name: Deploy prod
        type: Deployment
        spec:
          environment: { environmentRef: prod }
          execution:
            steps:
              - step: { type: HelmDeploy, name: Helm }
    - stage:
        name: Deploy uat
        type: Deployment
        spec:
          environment: { environmentRef: uat }
`;

const dialect = Dialect.parse({
  schemaVersion: 1,
  name: "pipes",
  version: "0.1.0",
  appliesTo: {},
  rules: [
    {
      id: "pipeline",
      description: "A pipeline file is a pipeline.",
      match: { jsonPath: "$.pipeline", files: ["**/*.yaml"] },
      emit: {
        kind: "QualityAsset",
        id: "${repo.component}.pipeline.${attr.identifier | slug}",
        fields: {
          component: "${repo.component}",
          assetKind: "pipeline",
          details: {
            tool: "harness",
            name: "${attr.name}",
            stages: [{ each: "@.stages[*].stage", value: "${item.name}" }],
            environments: [{ each: "@..environmentRef", value: "${item}" }],
            deployTargets: [{ each: "@..step", value: "${item.type | lower}" }],
            unknown: "${attr.nope}",
          },
        },
      },
      confidence: "verified",
    },
  ],
  tests: [{ name: "t", files: {}, expect: [] }],
});

describe("dialect fields: nested objects, collected lists, the component (ADR 0061)", () => {
  it("describes a pipeline as built-in readers do", async () => {
    const s = await scanRepo({
      repo: memoryRepo("cards-pipelines", "0".repeat(40), { ".harness/cards.yaml": pipeline }),
      extractors: [dialectExtractor(dialect)],
      dialects: ["pipes"],
      repoInfo: { component: "cards-svc" },
    });
    expect(s.rejected).toEqual([]);
    expect(s.records.map((r) => [r.id, (r as unknown as { details: unknown }).details])).toEqual([
      [
        "cards-svc.pipeline.cards_deploy",
        {
          tool: "harness",
          name: "Cards deploy",
          stages: ["Build", "Deploy prod", "Deploy uat"],
          environments: ["prod", "uat"],
          deployTargets: ["helmdeploy"],
        },
      ],
    ]);
  });

  it("refuses a collecting item outside a jsonPath match, and ${item} outside one", () => {
    const bad = (rule: Record<string, unknown>) =>
      Dialect.safeParse({
        ...dialect,
        rules: [{ ...dialect.rules[0], ...rule }],
      }).error?.issues.map((i) => i.message) ?? [];
    expect(bad({ match: { regex: "x", files: ["*"] } })).toContain(
      "a collecting list item ({ each, value }) needs a jsonPath match",
    );
    expect(
      bad({
        emit: {
          kind: "QualityAsset",
          id: "x-${item.name}",
          fields: { component: "c", assetKind: "pipeline" },
        },
      }),
    ).toContain("${item...} is for the value of a collecting list item ({ each, value })");
  });
});
