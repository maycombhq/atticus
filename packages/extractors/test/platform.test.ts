import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { CatalogRecord } from "@maycombhq/core";
import { fsRepo, memoryRepo, scanRepo, type Extractor } from "@maycombhq/sdk";
import { infraExtractor } from "../src/index.js";
import {
  accessExtractor,
  batchExtractor,
  envOf,
  gcpExtractor,
  openshiftExtractor,
  parseHcl,
  pipelinesExtractor,
  PLATFORM_EXTRACTORS,
} from "../src/platform/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures/platform");
const FORGE = join(HERE, "../../../fixtures/forge");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const AT = "2026-10-18T08:00:00Z";

type Rec = Record<string, unknown> & { kind: string; id?: string };

/** Drop the stamps the runner adds to every piece of evidence; expected files leave them out. */
function strip(r: CatalogRecord): Rec {
  const out = { ...(r as unknown as Rec) };
  out.evidence = r.evidence.map((e) => {
    const { commit: _c, scannedAt: _s, extractor: _x, ...rest } = e;
    return rest;
  });
  return out;
}

const sortKey = (r: Rec) =>
  `${r.kind}|${r.id ?? ""}|${String(r.owner ?? "")}|${String(r.raw ?? "")}`;

async function golden(
  name: string,
  extractor: Extractor,
  repoName: string,
  repoInfo: { component?: string; system?: string; repoType?: string },
) {
  const s = await scanRepo({
    repo: fsRepo(repoName, join(FIXTURES, name, "repo"), SHA),
    extractors: [extractor],
    scannedAt: AT,
    repoInfo,
  });
  expect(s.rejected).toEqual([]);
  expect(s.runs.map((r) => r.status)).toEqual(["ran"]);
  const want = parse(readFileSync(join(FIXTURES, name, "expected.yaml"), "utf8")) as {
    records: Rec[];
    warnings: { path: string; message: string }[];
  };
  const got = s.records.map(strip);
  for (const r of got.filter((x) => x.kind === "Unresolved")) {
    expect(r.id).toMatch(
      new RegExp(`^${String(r.owner)}\\.${String(r.unresolvedKind)}\\.[0-9a-f]{10}$`),
    );
    delete r.id;
  }
  const expected = want.records.map((r) => ({ schemaVersion: 2, status: "current", ...r }));
  expect(got.map(sortKey).sort()).toEqual(expected.map(sortKey).sort());
  for (const e of expected) {
    const g = got.find((x) => sortKey(x) === sortKey(e));
    expect(g, sortKey(e)).toEqual(e);
  }
  const warnings = s.warnings
    .map(({ path, message }) => ({ path, message }))
    .sort((a, b) => `${a.path}${a.message}`.localeCompare(`${b.path}${b.message}`));
  expect(warnings).toEqual(
    [...want.warnings].sort((a, b) =>
      `${a.path}${a.message}`.localeCompare(`${b.path}${b.message}`),
    ),
  );
  expect(
    s.records.every((r) =>
      r.evidence.every((e) => e.extractor === `${extractor.id}@${extractor.version}`),
    ),
  ).toBe(true);
  return s.records;
}

describe("platform extractors: identity", () => {
  it("are versioned with the agreed ids (openshift 0.3.0 for Helm and Kustomize, ADR 0064; batch 0.2.0)", () => {
    expect(PLATFORM_EXTRACTORS.map((x) => `${x.id}@${x.version}`)).toEqual([
      "openshift@0.3.0",
      "gcp@0.1.0",
      "pipelines@0.1.0",
      "access@0.1.0",
      "batch@0.2.0",
    ]);
  });
});

describe("openshift", () => {
  it("golden: DeploymentConfigs, HPAs, network policies, Routes and Templates", async () => {
    await golden("openshift", openshiftExtractor, "forge-ocp", { repoType: "infra" });
  });

  it("adds autoscaling and network policies to a Deployment the infra extractor reads, under its id", async () => {
    const files = {
      "k8s/payments.yaml": [
        "apiVersion: apps/v1",
        "kind: Deployment",
        "metadata:",
        "  name: payments",
        "  namespace: forge-prod",
        "spec:",
        "  replicas: 2",
        "  template:",
        "    metadata:",
        "      labels: { app: payments }",
        "",
      ].join("\n"),
      "k8s/payments-hpa.yaml": [
        "apiVersion: autoscaling/v2",
        "kind: HorizontalPodAutoscaler",
        "metadata: { name: payments, namespace: forge-prod }",
        "spec:",
        "  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: payments }",
        "  maxReplicas: 6",
        "",
      ].join("\n"),
      "k8s/plain.yaml":
        "apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: plain, namespace: forge-prod }\nspec: { replicas: 1 }\n",
    };
    const s = await scanRepo({
      repo: memoryRepo("x", SHA, files),
      extractors: [infraExtractor, openshiftExtractor],
      scannedAt: AT,
    });
    expect(s.rejected).toEqual([]);
    const byExtractor = (x: string) =>
      s.records
        .filter((r) => r.evidence[0]!.extractor?.startsWith(`${x}@`))
        .map((r) => r.id)
        .sort();
    expect(byExtractor("infra")).toEqual(["payments.forge-prod", "plain.forge-prod"]);
    // Only the Deployment with something to add, and with the infra extractor's id.
    expect(byExtractor("openshift")).toEqual(["payments.forge-prod"]);
    const mine = s.records.find(
      (r) => r.id === "payments.forge-prod" && r.evidence[0]!.extractor === "openshift@0.3.0",
    ) as unknown as Rec;
    expect(mine).toMatchObject({
      component: "payments",
      env: "forge-prod",
      platform: "kubernetes",
      replicas: 2,
      autoscaling: { min: 1, max: 6 },
    });
  });

  it("reads JSON manifests and List objects", async () => {
    const list = {
      apiVersion: "v1",
      kind: "List",
      items: [
        {
          apiVersion: "apps.openshift.io/v1",
          kind: "DeploymentConfig",
          metadata: { name: "audit-svc", namespace: "audit-test" },
          spec: { replicas: 1 },
        },
      ],
    };
    const s = await scanRepo({
      repo: memoryRepo("x", SHA, { "openshift/audit.json": JSON.stringify(list, null, 2) }),
      extractors: [openshiftExtractor],
      scannedAt: AT,
    });
    expect(s.rejected).toEqual([]);
    expect(s.records.map((r) => r.id)).toEqual(["audit-svc.test"]);
    expect(s.records[0]!.evidence[0]!.line).toBe(7);
  });
});

describe("gcp", () => {
  it("golden: Cloud Run, App Engine, Pub/Sub and project IAM", async () => {
    const recs = await golden("gcp", gcpExtractor, "forge-gcp", { repoType: "infra" });
    expect(recs.filter((r) => r.kind === "DataStore")).toEqual([]);
  });
});

describe("pipelines", () => {
  it("golden: Azure Pipelines with templates, GitHub Actions, GitLab CI and Jenkins", async () => {
    const recs = await golden("pipelines", pipelinesExtractor, "forge-ledger-ci", {
      component: "ledger-api",
      system: "ledger",
      repoType: "spring-boot",
    });
    // The stage template is part of the root pipeline, not a pipeline of its own.
    expect(recs.filter((r) => r.id.includes("deploy-stage"))).toEqual([]);
  });

  it("warns about a local template it can't find", async () => {
    const s = await scanRepo({
      repo: memoryRepo("x", SHA, {
        "azure-pipelines.yml": "steps:\n  - template: steps/missing.yml\n  - script: npm test\n",
      }),
      extractors: [pipelinesExtractor],
      scannedAt: AT,
      repoInfo: { component: "svc" },
    });
    expect(s.warnings.map((w) => [w.path, w.message])).toEqual([
      ["azure-pipelines.yml", "Template steps/missing.yml was not found; skipped it."],
    ]);
    expect(
      (s.records[0] as unknown as { details: { testSteps: string[] } }).details.testSteps,
    ).toEqual(["npm test"]);
  });
});

describe("access", () => {
  it("golden: Kubernetes RBAC and Apigee-style API products and apps", async () => {
    await golden("access", accessExtractor, "forge-access", { repoType: "infra" });
  });
});

describe("batch", () => {
  it("golden: CronJobs, Spring @Scheduled, Quartz and Cloud Scheduler", async () => {
    await golden("batch", batchExtractor, "forge-reports-batch", {
      component: "reports-job",
      system: "reports",
      repoType: "spring-batch",
    });
  });
});

describe("the Forge estate", () => {
  const manifest = parse(
    readFileSync(join(FORGE, "metarepo/org-pack/profiles/forge/repos.manifest.yaml"), "utf8"),
  ) as { repos: { id: string; component?: string; system?: string; type: string }[] };

  it("every platform extractor runs on every Forge repo and adds nothing to the expected catalog", async () => {
    for (const r of manifest.repos) {
      const s = await scanRepo({
        repo: fsRepo(r.id, join(FORGE, "repos", r.id), SHA),
        extractors: [...PLATFORM_EXTRACTORS],
        scannedAt: AT,
        repoInfo: {
          ...(r.component ? { component: r.component } : {}),
          ...(r.system ? { system: r.system } : {}),
          repoType: r.type,
        },
      });
      expect(s.rejected, r.id).toEqual([]);
      expect(
        s.runs.filter((x) => x.status === "failed"),
        r.id,
      ).toEqual([]);
      expect(s.warnings, r.id).toEqual([]);
      expect(
        s.records.map((x) => x.id),
        r.id,
      ).toEqual([]);
    }
  });
});

describe("readers", () => {
  it("parseHcl reads blocks, attributes, lists, objects, references, heredocs and comments", () => {
    const f = parseHcl(
      [
        "# comment",
        'resource "google_pubsub_topic" "t" {',
        '  name   = "a-${var.env}" // trailing',
        "  count  = 2",
        "  enabled = true",
        "  ref    = google_pubsub_topic.other.name",
        '  list   = ["x", "y",',
        '    "z"]',
        "  obj = {",
        '    "k.with/dots" = "v"',
        "    plain         = 3",
        "  }",
        '  expr = var.a == "b" ? 1 : 2',
        "  doc = <<-EOT",
        "    hello",
        "      world",
        "    EOT",
        "  /* block",
        "     comment */",
        "  nested {",
        "    inner = null",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    expect(f.error).toBeUndefined();
    const b = f.blocks[0]!;
    expect([b.type, b.labels, b.line]).toEqual(["resource", ["google_pubsub_topic", "t"], 2]);
    const v = (k: string) => b.attrs.get(k)?.value;
    expect(v("name")).toBe("a-${var.env}");
    expect(b.attrs.get("name")?.line).toBe(3);
    expect(v("count")).toBe(2);
    expect(v("enabled")).toBe(true);
    expect(v("ref")).toEqual({ $ref: "google_pubsub_topic.other.name" });
    expect(v("list")).toEqual(["x", "y", "z"]);
    expect(v("obj")).toEqual({ "k.with/dots": "v", plain: 3 });
    expect(v("expr")).toEqual({ $expr: 'var.a == "b" ? 1 : 2' });
    expect(v("doc")).toBe("hello\n  world\n");
    expect(b.blocks[0]!.type).toBe("nested");
    expect(b.blocks[0]!.attrs.get("inner")?.value).toBeNull();
  });

  it("parseHcl keeps what came before an unclosed block and says where it stopped", () => {
    const f = parseHcl('a "x" {\n  n = 1\n}\nb "y" {\n  n = 2\n');
    expect(f.blocks.map((b) => b.type)).toEqual(["a"]);
    expect(f.error?.line).toBe(4);
  });

  it("parseHcl never throws or hangs on text that isn't HCL", () => {
    for (const text of [
      "]]] ))",
      "a = [",
      "{{{",
      'r "x" { a = ( }',
      "= = =\n}",
      '"open',
      "<<EOT\nx",
    ])
      expect(() => parseHcl(text)).not.toThrow();
    expect(parseHcl('x = ]\nr "a" {\n  n = 1\n}\n').blocks.map((b) => b.labels)).toEqual([["a"]]);
  });

  it("envOf prefers the namespace's environment word, then the folder, then the name", () => {
    expect(envOf({ namespace: "prod", path: "x.yaml" })).toBe("prod");
    expect(envOf({ namespace: "forge-uat", path: "overlays/prod/x.yaml" })).toBe("uat");
    expect(envOf({ namespace: "forge", path: "overlays/prod/x.yaml" })).toBe("prod");
    expect(envOf({ path: "overlays/eu-west/x.yaml" })).toBe("eu-west");
    expect(envOf({ path: "deploy/x.yaml", name: "reports-job-staging" })).toBe("staging");
    expect(envOf({ namespace: "forge", path: "deploy/x.yaml" })).toBe("forge");
    expect(envOf({ path: "deploy/x.yaml" })).toBeUndefined();
  });
});

describe("Jenkins pipelines from the Groovy tree (ADR 0060)", () => {
  it("reads stages, triggers and steps, and nothing that is commented out", async () => {
    const { memoryRepo, scanRepo } = await import("@maycombhq/sdk");
    const { pipelinesExtractor } = await import("../src/index.js");
    const s = await scanRepo({
      repo: memoryRepo("cards", "0".repeat(40), {
        Jenkinsfile: [
          "pipeline {",
          "  triggers { cron('H 2 * * *') }",
          "  stages {",
          "    stage('Build') { steps { sh 'mvn -B verify' } }",
          "    // stage('Deploy uat') { steps { sh 'helm upgrade cards ./chart' } }",
          "    /* stage('Deploy dev') { } */",
          "    stage('Deploy prod') { steps { sh script: \"helm upgrade cards ./chart\" } }",
          "  }",
          "}",
        ].join("\n"),
      }),
      extractors: [pipelinesExtractor],
      repoInfo: { component: "cards" },
    });
    const p = (s.records.find((r) => r.kind === "QualityAsset") as unknown as { details: unknown })
      .details as {
      stages: string[];
      triggers: string[];
      environments: string[];
    };
    expect(p.stages).toEqual(["Build", "Deploy prod"]);
    expect(p.triggers).toEqual(["schedule H 2 * * *"]);
    expect(p.environments).toEqual(["prod"]);
  });
});
