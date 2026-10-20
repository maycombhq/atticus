import { describe, expect, it } from "vitest";
import { FrameworkModel, type CatalogRecord } from "@maycombhq/core";
import { memoryRepo, scanRepo } from "@maycombhq/sdk";
import { applyPipelineModels, pipelinesExtractor } from "../src/index.js";

const person = { kind: "person" as const, ref: "@tide-platform" };
/** What the platform team's pipeline library does (invented). */
const library = FrameworkModel.parse({
  schemaVersion: 1,
  name: "tide-pipelines",
  packages: ["tide-pipeline-lib"],
  pipeline: [
    {
      uses: "org.tide_release",
      stages: ["Release notes"],
      testSteps: ["release smoke tests"],
      source: person,
    },
    {
      uses: "deploy.yml@templates",
      deployTargets: ["helm"],
      environments: ["prod"],
      source: person,
    },
    { uses: "tide/actions/deploy-helm", deployTargets: ["helm"], source: person },
    { step: "deployToProd", deployTargets: ["helm"], environmentFrom: "env", source: person },
  ],
});

const details = (records: CatalogRecord[]) =>
  records
    .filter((r) => r.kind === "QualityAsset")
    .map((r) => (r as unknown as { details: Record<string, unknown> }).details);

describe("pipeline models (ADR 0062)", () => {
  it("add what an org template does to the pipelines that use it", () => {
    const pipeline = {
      schemaVersion: 1,
      kind: "QualityAsset",
      id: "cards.pipeline.cards-deploy",
      status: "current",
      confidence: "verified",
      component: "cards",
      assetKind: "pipeline",
      details: { tool: "harness", stages: ["Build"], templates: ["org.tide_release"] },
      evidence: [],
    } as unknown as CatalogRecord;
    const azure = {
      ...pipeline,
      id: "cards.pipeline.azure",
      details: { tool: "azure", stages: ["Build"], templates: ["deploy.yml@templates"] },
    } as unknown as CatalogRecord;
    const out = applyPipelineModels([pipeline, azure], [library]);
    expect(details(out)).toEqual([
      {
        tool: "harness",
        stages: ["Build", "Release notes"],
        testSteps: ["release smoke tests"],
        templates: ["org.tide_release"],
        modelled: ["org.tide_release (tide-pipelines, person @tide-platform)"],
      },
      {
        tool: "azure",
        stages: ["Build"],
        environments: ["prod"],
        deployTargets: ["helm"],
        templates: ["deploy.yml@templates"],
        modelled: ["deploy.yml@templates (tide-pipelines, person @tide-platform)"],
      },
    ]);
    // The records passed in are unchanged.
    expect((pipeline as unknown as { details: { stages: string[] } }).details.stages).toEqual([
      "Build",
    ]);
  });

  it("read a Jenkins shared-library step, its environment from a named argument", async () => {
    const s = await scanRepo({
      repo: memoryRepo("cards", "0".repeat(40), {
        Jenkinsfile: [
          "@Library('tide-pipeline-lib') _",
          "pipeline {",
          "  stages {",
          "    stage('Build') { steps { sh 'mvn -B verify' } }",
          "    stage('Release') { steps { deployToProd(app: 'cards', env: 'prod') } }",
          "  }",
          "}",
        ].join("\n"),
      }),
      extractors: [pipelinesExtractor],
      repoInfo: { component: "cards" },
      frameworks: [library],
    });
    const d = details(s.records)[0]!;
    expect([d.deployTargets, d.environments, d.templates, d.modelled]).toEqual([
      ["helm"],
      ["prod"],
      ["step:deployToProd"],
      ["step deployToProd (tide-pipelines, person @tide-platform)"],
    ]);
  });

  it("keep a GitHub action as a template only when a model names it", async () => {
    const workflow = `on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: tide/actions/deploy-helm@v2
`;
    const scan = (frameworks: FrameworkModel[]) =>
      scanRepo({
        repo: memoryRepo("cards", "0".repeat(40), { ".github/workflows/deploy.yml": workflow }),
        extractors: [pipelinesExtractor],
        repoInfo: { component: "cards" },
        frameworks,
      });
    expect(details((await scan([])).records)[0]!.templates).toBeUndefined();
    const modelled = applyPipelineModels((await scan([library])).records, [library]);
    expect([details(modelled)[0]!.templates, details(modelled)[0]!.deployTargets]).toEqual([
      ["tide/actions/deploy-helm@v2"],
      ["helm"],
    ]);
  });
});
