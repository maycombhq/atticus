import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { mergeCatalog, type CatalogRecord } from "@maycombhq/core";
import { fsRepo, memoryRepo, scanRepo, type Extractor } from "@maycombhq/sdk";
import {
  appsExtractor,
  cloudStoresExtractor,
  dataPipelinesExtractor,
  graphqlExtractor,
  grpcExtractor,
  ingressExtractor,
  meshExtractor,
  mlExtractor,
  parseGraphql,
  realtimeExtractor,
  serverlessExtractor,
  VOCAB_EXTRACTORS,
  webhooksExtractor,
} from "../src/vocab/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures/vocab");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const AT = "2026-10-18T08:00:00Z";

type Rec = Record<string, unknown> & { kind: string; id?: string };

function strip(r: CatalogRecord): Rec {
  const out = { ...(r as unknown as Rec) };
  out.evidence = r.evidence.map((e) => {
    const { commit: _c, scannedAt: _s, extractor: _x, ...rest } = e;
    return rest;
  });
  return out;
}

const sortKey = (r: Rec) =>
  `${r.kind}|${r.id ?? ""}|${String(r.owner ?? "")}|${String(r.raw ?? "")}|${JSON.stringify(
    r.kind === "Unresolved" ? r.evidence : "",
  )}`;

/** Scan a fixture repo and compare with its hand-written expected.yaml, field for field. */
export async function golden(
  name: string,
  extractor: Extractor,
  repoName: string,
  repoInfo: { component?: string; system?: string; repoType?: string },
): Promise<CatalogRecord[]> {
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
  type W = { path?: string; message: string };
  const order = (a: W, b: W) =>
    `${a.path ?? ""}${a.message}`.localeCompare(`${b.path ?? ""}${b.message}`);
  expect(s.warnings.map(({ path, message }) => ({ path, message })).sort(order)).toEqual(
    [...(want.warnings ?? [])].sort(order),
  );
  expect(
    s.records.every((r) =>
      r.evidence.every((e) => e.extractor === `${extractor.id}@${extractor.version}`),
    ),
  ).toBe(true);
  return s.records;
}

describe("vocabulary extractors (ADR 0040): identity", () => {
  it("have the agreed ids and versions, in a stable order", () => {
    expect(VOCAB_EXTRACTORS.map((x) => `${x.id}@${x.version}`)).toEqual([
      "graphql@0.1.1",
      "grpc@0.1.1",
      "realtime@0.1.0",
      "webhooks@0.1.0",
      "serverless@0.1.1",
      "mesh@0.1.1",
      "apps@0.1.0",
      "data-pipelines@0.1.1",
      "ml@0.1.1",
      "ingress@0.1.1",
      "cloud-stores@0.1.0",
    ]);
  });
});

describe("graphql", () => {
  it("golden: SDL, Apollo typeDefs, Spring for GraphQL, Strawberry and Graphene", async () => {
    await golden("graphql-server", graphqlExtractor, "harbor-catalog", {
      component: "catalog-api",
    });
  });

  it("golden: client operations in .graphql documents and gql tags", async () => {
    await golden("graphql-client", graphqlExtractor, "harbor-storefront", {
      component: "storefront-web",
    });
  });

  it("parses served and called fields with their offsets", () => {
    const text = "type Query { a: Int b(x: Int): [T!]! }\nquery { c d: e }";
    const r = parseGraphql(text);
    expect(r.served.map((f) => `${f.op} ${f.name}@${f.at}`)).toEqual(["QUERY a@13", "QUERY b@20"]);
    expect(r.called.map((f) => `${f.op} ${f.name}`)).toEqual(["QUERY c", "QUERY e"]);
  });

  it("merge resolves client operations to the server's graphql endpoints by field name", async () => {
    const scan = async (name: string, repo: string, component: string) =>
      (
        await scanRepo({
          repo: fsRepo(repo, join(FIXTURES, name, "repo"), SHA),
          extractors: [graphqlExtractor],
          scannedAt: AT,
          repoInfo: { component, system: "harbor" },
        })
      ).records;
    const records = [
      ...(await scan("graphql-server", "harbor-catalog", "catalog-api")),
      ...(await scan("graphql-client", "harbor-storefront", "storefront-web")),
    ];
    const m = mergeCatalog({ records, repos: [], systems: [] });
    expect(m.invalid).toEqual([]);
    const ifs = m.records.filter((r) => r.kind === "Interface") as unknown as Rec[];
    expect(
      ifs
        .map(
          (i) =>
            `${String(i.method)} ${String(i.normalizedPath)} ${String(i.endpoint)} ${String(i.confidence)} ${String(i.sync)}`,
        )
        .sort(),
    ).toEqual([
      "MUTATION Mutation.addReview catalog-api.graphql.mutation.addreview verified sync",
      "QUERY Query.product catalog-api.graphql.query.product verified sync",
      "QUERY Query.search catalog-api.graphql.query.search verified sync",
      "QUERY Query.stock catalog-api.graphql.query.stock verified sync",
      "SUBSCRIPTION Subscription.reviewAdded catalog-api.graphql.subscription.reviewadded verified async",
    ]);
    expect(
      ifs.every((i) => i.from === "storefront-web" && i.to === "catalog-api" && i.via === "direct"),
    ).toBe(true);
    const left = m.records.filter((r) => r.kind === "Unresolved") as unknown as Rec[];
    // The server serves none of these: cart (a field it doesn't have) and the two operations
    // read from plain templates in src/api/operations.ts.
    expect(left.map((l) => String(l.raw)).sort()).toEqual([
      "MUTATION Mutation.checkout",
      "QUERY Query.cart",
      "QUERY Query.orders",
    ]);
  });

  it("reads nothing from a repo without GraphQL (vocabulary extractors are quiet elsewhere)", async () => {
    const s = await scanRepo({
      repo: memoryRepo("x", SHA, { "src/a.ts": "export const a = 1;\n" }),
      extractors: [graphqlExtractor],
      repoInfo: { component: "x" },
    });
    expect(s.records).toEqual([]);
  });
});

describe("grpc", () => {
  it("golden: proto services served by registered implementations, vendored protos called", async () => {
    await golden("grpc-server", grpcExtractor, "harbor-ledger", { component: "ledger-svc" });
  });

  it("golden: generated clients in Java, Node and Python", async () => {
    await golden("grpc-client", grpcExtractor, "harbor-checkout", { component: "checkout-svc" });
  });

  it("serves a proto nobody calls, but not in a library repo", async () => {
    const files = { "api.proto": "package a.v1;\nservice S { rpc M(R) returns (R); }\n" };
    const scan = (repoType?: string) =>
      scanRepo({
        repo: memoryRepo("x", SHA, files),
        extractors: [grpcExtractor],
        repoInfo: { component: "x", ...(repoType ? { repoType } : {}) },
      });
    expect((await scan()).records.map((r) => r.id)).toEqual(["x.grpc.a.v1.s.m"]);
    expect((await scan("library")).records).toEqual([]);
  });

  it("a Go server that embeds the generated Unimplemented...Server serves the service, even in a library repo", async () => {
    const files = {
      "api.proto": "package a.v1;\nservice S { rpc M(R) returns (R); }\n",
      "s/server.go": "package s\n\ntype Server struct {\n\tv1.UnimplementedSServer\n}\n",
    };
    const s = await scanRepo({
      repo: memoryRepo("x", SHA, files),
      extractors: [grpcExtractor],
      repoInfo: { component: "x", repoType: "library" },
    });
    expect(s.records.map((r) => r.id)).toEqual(["x.grpc.a.v1.s.m"]);
    expect(s.records[0]!.evidence.map((e) => `${e.path}:${e.line}:${e.side}`)).toEqual([
      "api.proto:2:definition",
      "s/server.go:4:callee",
    ]);
  });
});

describe("realtime", () => {
  it("golden: Spring STOMP/WebSocket/SSE, ws, socket.io, Express SSE, SignalR and FastAPI", async () => {
    await golden("realtime", realtimeExtractor, "harbor-live", { component: "live-svc" });
  });
});

describe("webhooks", () => {
  it("golden: OpenAPI 3.1 webhooks and literal registrations", async () => {
    await golden("webhooks", webhooksExtractor, "harbor-orders", { component: "orders-svc" });
  });
});

describe("serverless", () => {
  it("golden: SAM, Serverless Framework and CDK synth templates", async () => {
    await golden("serverless-aws", serverlessExtractor, "harbor-media", {
      component: "media-fns",
      system: "harbor",
    });
  });

  it("golden: Azure Functions, Terraform cloud functions and Knative", async () => {
    await golden("serverless-other", serverlessExtractor, "harbor-notify", {
      component: "notify-fns",
      system: "harbor",
    });
  });
});

describe("mesh", () => {
  it("golden: Istio and Linkerd membership and policies", async () => {
    await golden("mesh", meshExtractor, "harbor-platform", { repoType: "infra" });
  });

  it("merge marks calls between meshed services via mesh", async () => {
    const s = await scanRepo({
      repo: fsRepo("harbor-platform", join(FIXTURES, "mesh/repo"), SHA),
      extractors: [meshExtractor],
      scannedAt: AT,
      repoInfo: { repoType: "infra" },
    });
    const call = (from: string, to: string) =>
      ({
        schemaVersion: 2,
        kind: "Unresolved",
        id: `${from}.http-call.000000000${to.length}`,
        status: "current",
        confidence: "inferred",
        unresolvedKind: "http-call",
        raw: `GET http://${to}/x`,
        owner: from,
        evidence: [{ source: "code", repo: from, path: "a.ts", line: 1, side: "caller" }],
      }) as unknown as CatalogRecord;
    const comp = (id: string) =>
      ({
        schemaVersion: 2,
        kind: "Component",
        id,
        status: "current",
        confidence: "verified",
        system: "shop",
        type: "service",
        evidence: [{ source: "config", repo: id, path: "package.json" }],
      }) as unknown as CatalogRecord;
    const m = mergeCatalog({
      records: [
        ...s.records,
        comp("cart"),
        comp("checkout"),
        comp("legacy"),
        call("checkout", "cart"),
        call("checkout", "legacy"),
      ],
      repos: [],
      systems: [],
    });
    expect(m.invalid).toEqual([]);
    const via = Object.fromEntries(
      (m.records.filter((r) => r.kind === "Interface") as unknown as Rec[]).map((i) => [
        String(i.to),
        i.via,
      ]),
    );
    expect(via).toEqual({ cart: "mesh", legacy: "direct" });
  });
});

describe("apps", () => {
  it("golden: an Android app with Retrofit", async () => {
    await golden("apps-android", appsExtractor, "harbor-android", {
      component: "shop-android",
      system: "harbor",
    });
  });

  it("golden: a Flutter app with Android and iOS shells, Dio, http and Swift calls", async () => {
    await golden("apps-flutter", appsExtractor, "harbor-shop-app", {
      component: "shop-app",
      system: "harbor",
    });
  });

  it.each([
    [
      "package.json",
      '{ "dependencies": { "react-native": "0.76.0" } }',
      "mobile-app",
      "react-native",
    ],
    ["package.json", '{ "devDependencies": { "electron": "33.0.0" } }', "desktop-app", "electron"],
    ["src-tauri/tauri.conf.json", "{}", "desktop-app", "tauri"],
    [
      "Till/Till.csproj",
      "<Project><PropertyGroup><UseWPF>true</UseWPF></PropertyGroup></Project>",
      "desktop-app",
      "windows",
    ],
  ])("knows %s markers (%s)", async (file, text, type, runtime) => {
    const s = await scanRepo({
      repo: memoryRepo("x", SHA, { [file]: text }),
      extractors: [appsExtractor],
      repoInfo: { component: "till" },
    });
    expect(s.records).toHaveLength(1);
    expect(s.records[0]).toMatchObject({ kind: "Component", id: "till", type, runtime });
  });

  it("is quiet in a plain service repo", async () => {
    const s = await scanRepo({
      repo: memoryRepo("x", SHA, { "package.json": '{ "dependencies": { "express": "5" } }' }),
      extractors: [appsExtractor],
      repoInfo: { component: "x" },
    });
    expect(s.records).toEqual([]);
  });
});

describe("data-pipelines", () => {
  it("golden: Airflow DAGs, a dbt project and Spark jobs", async () => {
    await golden("data-pipelines", dataPipelinesExtractor, "harbor-data", {
      component: "analytics",
      system: "harbor",
    });
  });

  it("golden: a lone DAG is the repo's component; a dbt profile host, folder materialization and sources.yml databases", async () => {
    await golden("dbt-profile", dataPipelinesExtractor, "shop-data", {
      component: "shop-dw",
      system: "shop",
    });
  });
});

describe("ml", () => {
  it("golden: MLflow, KServe, SageMaker and Feast", async () => {
    await golden("ml", mlExtractor, "harbor-ml", { component: "price-model", system: "harbor" });
  });

  it("golden: --model_name, predictor resources and replicas, a Feast online store host and a Redshift source", async () => {
    await golden("ml-serving", mlExtractor, "shop-recs", {
      component: "rec-service",
      system: "shop",
    });
  });
});

describe("ingress", () => {
  it("golden: Kubernetes Ingress and Gateway API HTTPRoute", async () => {
    await golden("ingress", ingressExtractor, "harbor-k8s", { repoType: "infra" });
  });
});

describe("cloud-stores", () => {
  it("golden: Terraform buckets, queues, warehouses and caches", async () => {
    await golden("cloud-stores", cloudStoresExtractor, "shop-infra", { repoType: "infra" });
  });
});

describe("vocabulary extractors are deterministic", () => {
  it("give identical output on two runs over every fixture", async () => {
    const fixtures = [
      "graphql-server",
      "graphql-client",
      "grpc-server",
      "grpc-client",
      "realtime",
      "webhooks",
      "serverless-aws",
      "serverless-other",
      "mesh",
      "apps-android",
      "apps-flutter",
      "data-pipelines",
      "dbt-profile",
      "ml",
      "ml-serving",
      "ingress",
      "cloud-stores",
    ];
    for (const f of fixtures) {
      const run = async () =>
        JSON.stringify(
          (
            await scanRepo({
              repo: fsRepo(f, join(FIXTURES, f, "repo"), SHA),
              extractors: [...VOCAB_EXTRACTORS],
              scannedAt: AT,
              repoInfo: { component: f, system: "harbor" },
            })
          ).records,
        );
      expect(await run(), f).toBe(await run());
    }
  });
});
