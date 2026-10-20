import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Dialect } from "@maycombhq/core";
import { fsRepo, memoryRepo, scanRepo, type Extractor, type RepoHandle } from "@maycombhq/sdk";
import { cloudStoresExtractor, dialectExtractor, infraExtractor } from "../src/index.js";
import { loadShippedDialects } from "../src/data/index.js";
import { loadTerraform } from "../src/platform/terraform.js";

/**
 * ADR 0063: cloud resources in Terraform read by the shipped terraform-aws, terraform-azure and
 * terraform-gcp dialects, the database reader moved out of the infra extractor's regex, and
 * local modules followed with their callers' values.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");
const DIALECT_FIX = join(HERE, "../dialects/fixtures");
const SHA = "0123456789abcdef0123456789abcdef01234567";

type Rec = Record<string, unknown> & { kind: string; id: string; evidence: Rec[] };

const FIELDS: Record<string, string[]> = {
  Endpoint: ["component", "endpointType", "pathOrTopic"],
  DataStore: ["storeType"],
  Component: ["system", "type", "runtime"],
  Deployment: ["component", "env", "platform"],
  GatewayRoute: ["proxy", "basepath", "target"],
};

const view = (r: unknown) => {
  const x = r as Rec;
  const e = x.evidence[0]!;
  return [
    `${x.kind} ${x.id}`,
    ...(FIELDS[x.kind] ?? [])
      .filter((f) => x[f] !== undefined)
      .map((f) => `${f}=${JSON.stringify(x[f])}`),
    `@${String(e.path)}:${String(e.line)}:${String(e.source)}:${String(e.side)}:${String(e.dialect)}`,
  ].join(" ");
};

let shipped: Dialect[] | undefined;
async function cloud(): Promise<Extractor[]> {
  shipped ??= (await loadShippedDialects()).filter((d) => d.name.startsWith("terraform-"));
  return shipped.map((d) => dialectExtractor(d));
}

async function scan(repo: RepoHandle, extractors: Extractor[]) {
  const s = await scanRepo({ repo, extractors, scannedAt: "2026-10-20T08:00:00Z" });
  expect(s.rejected).toEqual([]);
  expect(s.runs.filter((r) => r.status === "failed")).toEqual([]);
  return s;
}
const dir = (p: string) => fsRepo(basename(p), p, SHA);

describe("the shipped cloud dialects", () => {
  it("apply to any repo with a .tf file, listed or not (ADR 0062)", async () => {
    for (const d of (await loadShippedDialects()).filter((x) => x.name.startsWith("terraform-")))
      expect(d.appliesTo, d.name).toEqual({ repoTypes: ["*"], marker: "**/*.tf" });
  });

  it("read nothing in a repo without Terraform", async () => {
    const s = await scan(memoryRepo("app", SHA, { "src/main.ts": "export {};\n" }), await cloud());
    expect(s.records).toEqual([]);
  });

  it("terraform-aws: topics, stores, databases, functions, services and gateway routes", async () => {
    const s = await scan(dir(join(DIALECT_FIX, "terraform-aws/forge-aws-infra")), await cloud());
    const M = "envs/prod/main.tf";
    const A = "envs/prod/api.tf";
    const D = "terraform-aws@1.0.0";
    expect(s.records.map(view).sort()).toEqual(
      [
        `Endpoint topic.forge-order-events-prod component="unknown" endpointType="event-topic" pathOrTopic="forge-order-events-prod" @${M}:9:infrastructure:definition:${D}`,
        `Endpoint topic.forge-payments component="unknown" endpointType="event-topic" pathOrTopic="forge-payments" @${M}:13:infrastructure:definition:${D}`,
        `DataStore forge-events storeType="stream" @${M}:17:infrastructure:undefined:${D}`,
        `Endpoint topic.orders.placed component="unknown" endpointType="event-topic" pathOrTopic="orders.placed" @${M}:22:infrastructure:definition:${D}`,
        `Component invoice-renderer system="invoice-renderer" type="function" runtime="lambda" @${M}:34:infrastructure:undefined:${D}`,
        `Deployment invoice-renderer.prod component="invoice-renderer" env="prod" platform="lambda" @${M}:34:infrastructure:undefined:${D}`,
        `Deployment checkout-svc.prod component="checkout-svc" env="prod" platform="ecs" @${M}:43:infrastructure:undefined:${D}`,
        `DataStore forge-carts storeType="key-value" @${M}:57:infrastructure:undefined:${D}`,
        `DataStore orders-db storeType="postgresql" @${M}:62:infrastructure:undefined:${D}`,
        `DataStore sessions-db storeType="mysql" @${M}:67:infrastructure:undefined:${D}`,
        `DataStore billing-db storeType="sqlserver" @${M}:72:infrastructure:undefined:${D}`,
        `DataStore erp-db storeType="unknown" @${M}:77:infrastructure:undefined:${D}`,
        `DataStore ledger-cluster storeType="postgresql" @${M}:82:infrastructure:undefined:${D}`,
        `DataStore carts-cluster storeType="mysql" @${M}:87:infrastructure:undefined:${D}`,
        `DataStore audit-cluster storeType="unknown" @${M}:92:infrastructure:undefined:${D}`,
        `GatewayRoute shop-api.get-orders proxy="shop-api" basepath="/orders" @${A}:7:infrastructure:gateway:${D}`,
        `GatewayRoute shop-api.post-orders proxy="shop-api" basepath="/orders" @${A}:12:infrastructure:gateway:${D}`,
        `GatewayRoute partner-api.quotes proxy="partner-api" basepath="/quotes" @${A}:27:infrastructure:gateway:${D}`,
      ].sort(),
    );
  });

  it("terraform-azure: queues, topics, function and web apps, APIM, stores and databases", async () => {
    const s = await scan(
      dir(join(DIALECT_FIX, "terraform-azure/forge-azure-infra")),
      await cloud(),
    );
    const M = "main.tf";
    const D = "terraform-azure@1.0.0";
    expect(s.records.map(view).sort()).toEqual(
      [
        `DataStore orders-in storeType="queue" @${M}:9:infrastructure:undefined:${D}`,
        `Endpoint topic.order-events component="unknown" endpointType="event-topic" pathOrTopic="order-events" @${M}:14:infrastructure:definition:${D}`,
        `Endpoint topic.device-telemetry component="unknown" endpointType="event-topic" pathOrTopic="device-telemetry" @${M}:19:infrastructure:definition:${D}`,
        `Component billing-func system="billing-func" type="function" runtime="azure-functions" @${M}:27:infrastructure:undefined:${D}`,
        `Deployment billing-func.prod component="billing-func" env="prod" platform="azure-functions" @${M}:27:infrastructure:undefined:${D}`,
        `Component legacy-billing-func system="legacy-billing-func" type="function" runtime="azure-functions" @${M}:34:infrastructure:undefined:${D}`,
        `Deployment legacy-billing-func.default component="legacy-billing-func" env="default" platform="azure-functions" @${M}:34:infrastructure:undefined:${D}`,
        `Component notifier-func system="notifier-func" type="function" runtime="azure-functions" @${M}:38:infrastructure:undefined:${D}`,
        `Deployment notifier-func.default component="notifier-func" env="default" platform="azure-functions" @${M}:38:infrastructure:undefined:${D}`,
        `Deployment portal-web.prod component="portal-web" env="prod" platform="app-service" @${M}:42:infrastructure:undefined:${D}`,
        `Deployment backoffice-web.default component="backoffice-web" env="default" platform="app-service" @${M}:49:infrastructure:undefined:${D}`,
        `Deployment statements-web.default component="statements-web" env="default" platform="app-service" @${M}:53:infrastructure:undefined:${D}`,
        `GatewayRoute apim-orders proxy="Orders API" basepath="/orders" target="https://orders.forge.internal" @${M}:62:infrastructure:gateway:${D}`,
        `DataStore forge-catalog storeType="document" @${M}:72:infrastructure:undefined:${D}`,
        `DataStore forge-reports-sql storeType="sqlserver" @${M}:77:infrastructure:undefined:${D}`,
        `DataStore forge-ledger-pg storeType="postgresql" @${M}:82:infrastructure:undefined:${D}`,
        `DataStore forge-legacy-pg storeType="postgresql" @${M}:87:infrastructure:undefined:${D}`,
        `DataStore forge-loyalty-mysql storeType="mysql" @${M}:91:infrastructure:undefined:${D}`,
        `DataStore forge-sessions storeType="cache" @${M}:95:infrastructure:undefined:${D}`,
      ].sort(),
    );
  });

  it("terraform-gcp: Cloud SQL by version, Memorystore, Cloud Tasks and Spanner", async () => {
    const s = await scan(dir(join(DIALECT_FIX, "terraform-gcp/forge-gcp-infra")), await cloud());
    const M = "main.tf";
    const D = "terraform-gcp@1.0.0";
    expect(s.records.map(view).sort()).toEqual(
      [
        `DataStore ledger-db storeType="postgresql" @${M}:9:infrastructure:undefined:${D}`,
        `DataStore loyalty-db storeType="mysql" @${M}:15:infrastructure:undefined:${D}`,
        `DataStore reporting-db storeType="sqlserver" @${M}:20:infrastructure:undefined:${D}`,
        `DataStore scratch-db storeType="unknown" @${M}:25:infrastructure:undefined:${D}`,
        `DataStore forge-sessions storeType="cache" @${M}:29:infrastructure:undefined:${D}`,
        `DataStore forge-emails storeType="queue" @${M}:34:infrastructure:undefined:${D}`,
        `DataStore forge-spanner-accounts storeType="relational" @${M}:39:infrastructure:undefined:${D}`,
      ].sort(),
    );
  });
});

describe("the database reader moved from the infra extractor's regex (ADR 0063)", () => {
  /** What the regex reader gave for these repos before the move, captured from it. */
  const BEFORE = [
    "terraform-databases billing-db sqlserver terraform/aws.tf:12",
    "terraform-databases carts-cluster mysql terraform/aws.tf:27",
    "terraform-databases erp-db unknown terraform/aws.tf:17",
    "terraform-databases forge-catalog-pg postgresql terraform/azure.tf:1",
    "terraform-databases forge-reports-sql sqlserver terraform/azure.tf:6",
    "terraform-databases ledger-cluster postgresql terraform/aws.tf:22",
    "terraform-databases ledger-db postgresql terraform/gcp.tf:2",
    "terraform-databases loyalty-db mysql terraform/gcp.tf:10",
    "terraform-databases orders-db postgresql terraform/aws.tf:1",
    "terraform-databases reporting-db sqlserver terraform/gcp.tf:15",
    "terraform-databases scratch-db unknown terraform/gcp.tf:20",
    "terraform-databases sessions-db mysql terraform/aws.tf:7",
    "forge-infra ledger-db postgresql terraform/ledger-db.tf:1",
    "harbor-platform catalog-db postgresql terraform/databases.tf:10",
    "harbor-platform orders-db postgresql terraform/databases.tf:1",
  ];
  const REPOS: [string, string][] = [
    ["terraform-databases", join(HERE, "fixtures/platform/terraform-databases/repo")],
    ["forge-infra", join(ROOT, "fixtures/forge/repos/forge-infra")],
    ["harbor-platform", join(ROOT, "fixtures/harbor/repos/harbor-platform")],
  ];

  it("gives the same DataStores, field for field, from the shipped dialects", async () => {
    const got: string[] = [];
    for (const [name, path] of REPOS) {
      const s = await scan(fsRepo(name, path, SHA), await cloud());
      for (const r of s.records.filter((x) => x.kind === "DataStore")) {
        const x = r as unknown as Rec;
        expect(x).toMatchObject({ confidence: "verified", entitiesHeld: [], status: "current" });
        expect(x.evidence).toHaveLength(1);
        expect(x.evidence[0]).toMatchObject({ source: "infrastructure", repo: name });
        expect(x.evidence[0]!.side).toBeUndefined();
        got.push(
          `${name} ${x.id} ${String(x.storeType)} ${String(x.evidence[0]!.path)}:${String(x.evidence[0]!.line)}`,
        );
      }
    }
    // Harbor's warehouse, bucket, queue and cache stay with the cloud-stores extractor.
    expect(got.sort()).toEqual([...BEFORE].sort());
  });

  it("is gone from the infra extractor, which keeps Kubernetes and alerts", async () => {
    for (const [name, path] of REPOS) {
      const s = await scan(fsRepo(name, path, SHA), [infraExtractor]);
      expect(s.records.filter((r) => r.kind === "DataStore")).toEqual([]);
    }
    expect(infraExtractor.claims).not.toContain("**/*.tf");
  });
});

describe("local Terraform modules (ADR 0063)", () => {
  const REPO = join(HERE, "fixtures/platform/terraform-modules/repo");

  it("gives each instantiation its caller's values, nested modules included", async () => {
    const repo = fsRepo("forge-modules", REPO, SHA);
    const mods = await loadTerraform(repo, { warn: () => {} } as never, /./);
    expect(
      mods.map((m) => [
        m.dir,
        m.call ? `${m.call.file}:${m.call.line}` : "-",
        m.vars.get("name") ?? null,
        m.vars.get("env") ?? null,
      ]),
    ).toEqual([
      ["envs/prod", "-", null, "prod"],
      ["modules/queue", "envs/prod/main.tf:6", "orders", "prod"],
      ["modules/dlq", "modules/queue/main.tf:27", "orders-dlq", null],
      ["modules/queue", "envs/prod/main.tf:12", "payments", "prod"],
      ["modules/dlq", "modules/queue/main.tf:27", "payments-dlq", null],
      ["modules/queue", "envs/prod/main.tf:19", { $expr: "data.external.queue.result" }, "dev"],
      ["modules/dlq", "modules/queue/main.tf:27", { $expr: "${var.name}-dlq" }, null],
      ["modules/unused", "-", "spare", null],
    ]);
  });

  it("emits the module's resources once per instantiation, with the caller's values", async () => {
    const s = await scan(fsRepo("forge-modules", REPO, SHA), [
      cloudStoresExtractor,
      ...(await cloud()),
    ]);
    const Q = "modules/queue/main.tf";
    expect(s.records.map(view).sort()).toEqual(
      [
        `Endpoint topic.orders-prod component="unknown" endpointType="event-topic" pathOrTopic="orders-prod" @${Q}:15:infrastructure:definition:terraform-aws@1.0.0`,
        `Endpoint topic.payments-prod component="unknown" endpointType="event-topic" pathOrTopic="payments-prod" @${Q}:15:infrastructure:definition:terraform-aws@1.0.0`,
        `DataStore orders-queue storeType="queue" @${Q}:19:infrastructure:undefined:undefined`,
        `DataStore payments-queue storeType="queue" @${Q}:19:infrastructure:undefined:undefined`,
        `DataStore orders-prod-state storeType="key-value" @${Q}:23:infrastructure:undefined:terraform-aws@1.0.0`,
        `DataStore payments-prod-state storeType="key-value" @${Q}:23:infrastructure:undefined:terraform-aws@1.0.0`,
        `DataStore orders-dlq storeType="queue" @modules/dlq/main.tf:5:infrastructure:undefined:undefined`,
        `DataStore payments-dlq storeType="queue" @modules/dlq/main.tf:5:infrastructure:undefined:undefined`,
        // A module no one calls is read on its own, as before.
        `DataStore spare-queue storeType="queue" @modules/unused/main.tf:6:infrastructure:undefined:undefined`,
      ].sort(),
    );
  });

  it("lets a dialect match module blocks, remote ones as written and local ones per instance", async () => {
    const d = {
      schemaVersion: 1,
      name: "modules-probe",
      version: "0.1.0",
      extends: [],
      appliesTo: { repoTypes: [] },
      layout: { sourceRoots: [], configFiles: [] },
      normalize: { stripPathPrefixes: [] },
      rules: [
        {
          id: "module",
          description: "every module block",
          match: { hclBlock: "module", files: ["**/*.tf"] },
          emit: {
            kind: "Setting",
            id: "probe.${match.0 | slug}.${attr.name | slug}",
            fields: {
              component: "probe",
              settingKind: "config",
              key: "${match.0}",
              valueOrRef: "${attr.source}",
            },
            evidence: { source: "infrastructure" },
          },
          confidence: "verified",
        },
      ],
      tests: [{ name: "t", files: {}, expect: [], absent: [] }],
    } as unknown as Dialect;
    const s = await scan(fsRepo("forge-modules", REPO, SHA), [dialectExtractor(d)]);
    expect(s.records.map((r) => r.id).sort()).toEqual([
      "probe.dlq.orders-dlq",
      "probe.dlq.payments-dlq",
      "probe.events_topic.events.prod",
      "probe.orders_queue.orders",
      "probe.payments_queue.payments",
      "probe.vpc.core",
    ]);
  });

  it("leaves a repo without local modules as it was", async () => {
    const repo = fsRepo("forge-infra", join(ROOT, "fixtures/forge/repos/forge-infra"), SHA);
    const mods = await loadTerraform(repo, { warn: () => {} } as never, /./);
    expect(mods.map((m) => [m.dir, m.call, m.resources.map((r) => r.name)])).toEqual([
      ["terraform", undefined, ["ledger_db"]],
    ]);
  });
});
