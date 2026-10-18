import { describe, expect, it } from "vitest";
import { MESH_KEY, interfaceId, mergeCatalog, type CatalogRecord } from "../src/index.js";

/** ADR 0040 merge rules: typed endpoints by id, GraphQL/gRPC/webhook loose ends, mesh hops. */

const ev = (repo: string, side: "caller" | "definition" = "caller") => [
  { source: "code" as const, repo, path: "a", line: 1, side },
];
const rec = (r: Record<string, unknown>) =>
  ({
    schemaVersion: 2,
    status: "current",
    confidence: "verified",
    ...r,
  }) as unknown as CatalogRecord;
const component = (id: string, system: string, type = "service") =>
  rec({ kind: "Component", id, system, repo: id, type, evidence: ev(id) });
const ep = (
  component: string,
  endpointType: string,
  id: string,
  pathOrTopic: string,
  method?: string,
) =>
  rec({
    kind: "Endpoint",
    id,
    component,
    endpointType,
    pathOrTopic,
    ...(method ? { method } : {}),
    schemaRefs: [],
    evidence: ev(component, "definition"),
  });
const loose = (owner: string, unresolvedKind: string, raw: string) =>
  rec({
    kind: "Unresolved",
    id: `${owner}.${unresolvedKind}.${raw.length.toString(16).padStart(10, "0")}`,
    confidence: "inferred",
    unresolvedKind,
    raw,
    owner,
    evidence: ev(owner),
  });

const systems = [
  { id: "shop", name: "Shop", boundary: "product" as const, aliases: [] },
  { id: "partner", name: "Partner", boundary: "product" as const, aliases: [] },
  { id: "northwind", name: "Northwind Pay", boundary: "vendor" as const, aliases: [] },
];
const merge = (records: CatalogRecord[]) => {
  const m = mergeCatalog({ records, repos: [], systems });
  expect(m.invalid).toEqual([]);
  return m.records as unknown as (Record<string, unknown> & { kind: string; id: string })[];
};

describe("typed endpoints", () => {
  it("keeps two components' graphql fields with the same name apart", () => {
    const r = merge([
      ep("catalog", "graphql", "catalog.graphql.query.product", "Query.product", "QUERY"),
      ep("legacy", "graphql", "legacy.graphql.query.product", "Query.product", "QUERY"),
      ep("pay", "transaction", "pay.cics.transaction.payq", "PAYQ"),
    ]);
    expect(r.filter((x) => x.kind === "Endpoint").map((x) => x.id)).toEqual([
      "catalog.graphql.query.product",
      "legacy.graphql.query.product",
      "pay.cics.transaction.payq",
    ]);
  });
});

describe("graphql-call", () => {
  it("resolves to the one component serving the field, preferring the caller's system", () => {
    const r = merge([
      component("web", "shop"),
      component("catalog", "shop"),
      component("other", "partner"),
      ep("catalog", "graphql", "catalog.graphql.query.product", "Query.product", "QUERY"),
      ep("other", "graphql", "other.graphql.query.product", "Query.product", "QUERY"),
      ep(
        "catalog",
        "graphql",
        "catalog.graphql.subscription.price",
        "Subscription.price",
        "SUBSCRIPTION",
      ),
      loose("web", "graphql-call", "QUERY Query.product"),
      loose("web", "graphql-call", "SUBSCRIPTION Subscription.price"),
      loose("web", "graphql-call", "MUTATION Mutation.product"),
    ]);
    const ifs = r.filter((x) => x.kind === "Interface");
    expect(ifs).toHaveLength(2);
    expect(ifs.find((i) => i.method === "QUERY")).toMatchObject({
      id: interfaceId("web", "catalog", "QUERY", "Query.product"),
      from: "web",
      to: "catalog",
      endpoint: "catalog.graphql.query.product",
      via: "direct",
      sync: "sync",
      confidence: "verified",
    });
    expect(ifs.find((i) => i.method === "SUBSCRIPTION")).toMatchObject({ sync: "async" });
    // A mutation nobody serves stays a loose end.
    expect(r.filter((x) => x.kind === "Unresolved").map((x) => x.raw)).toEqual([
      "MUTATION Mutation.product",
    ]);
  });

  it("stays a loose end when two components of other systems serve the field", () => {
    const r = merge([
      ep("a", "graphql", "a.graphql.query.x", "Query.x", "QUERY"),
      ep("b", "graphql", "b.graphql.query.x", "Query.x", "QUERY"),
      loose("web", "graphql-call", "QUERY Query.x"),
    ]);
    expect(r.filter((x) => x.kind === "Interface")).toEqual([]);
    expect(r.filter((x) => x.kind === "Unresolved")).toHaveLength(1);
  });
});

describe("grpc-call", () => {
  const eps = [
    ep(
      "ledger",
      "grpc",
      "ledger.grpc.harbor.ledger.v1.ledgerservice.getbalance",
      "harbor.ledger.v1.LedgerService/GetBalance",
      "GetBalance",
    ),
    ep(
      "ledger",
      "grpc",
      "ledger.grpc.harbor.ledger.v1.ledgerservice.post",
      "harbor.ledger.v1.LedgerService/Post",
      "Post",
    ),
  ];

  it("resolves a method call to its endpoint and a service call to the service", () => {
    const r = merge([
      ...eps,
      loose("orders", "grpc-call", "LedgerService/GetBalance"),
      loose("checkout", "grpc-call", "harbor.ledger.v1.LedgerService"),
      loose("checkout", "grpc-call", "harbor.other.v1.LedgerService"),
    ]);
    const ifs = r.filter((x) => x.kind === "Interface");
    expect(
      ifs
        .map(
          (i) =>
            `${String(i.from)}>${String(i.to)} ${String(i.normalizedPath)} ${String(i.endpoint)}`,
        )
        .sort(),
    ).toEqual([
      "checkout>ledger harbor.ledger.v1.LedgerService undefined",
      "orders>ledger harbor.ledger.v1.LedgerService/GetBalance ledger.grpc.harbor.ledger.v1.ledgerservice.getbalance",
    ]);
    expect(ifs.every((i) => i.confidence === "verified" && i.sync === "sync")).toBe(true);
    expect(r.filter((x) => x.kind === "Unresolved").map((x) => x.raw)).toEqual([
      "harbor.other.v1.LedgerService",
    ]);
  });
});

describe("webhook-callback", () => {
  it("is an Interface from the registrar's system to the owner, via webhook", () => {
    const r = merge([
      component("orders", "shop"),
      rec({
        kind: "Endpoint",
        id: "orders.webhook.payments",
        component: "orders",
        endpointType: "webhook",
        method: "POST",
        pathOrTopic: "/hooks/payments",
        normalizedPath: "/hooks/payments",
        schemaRefs: [],
        evidence: ev("orders", "definition"),
      }),
      loose(
        "orders",
        "webhook-callback",
        "POST /hooks/payments https://api.northwind.example/v1/webhooks",
      ),
      loose("orders", "webhook-callback", "POST /hooks/x https://hooks.unknown.example/v1"),
    ]);
    const ifs = r.filter((x) => x.kind === "Interface");
    expect(ifs).toHaveLength(1);
    expect(ifs[0]).toMatchObject({
      from: "northwind",
      to: "orders",
      via: "webhook",
      method: "POST",
      normalizedPath: "/hooks/payments",
      endpoint: "orders.webhook.payments",
      sync: "async",
      confidence: "verified",
    });
    expect(r.filter((x) => x.kind === "Unresolved")).toHaveLength(1);
  });

  it("accepts a registrar given by name", () => {
    const r = merge([
      component("orders", "shop"),
      loose("orders", "webhook-callback", "POST /hooks/n northwind"),
    ]);
    expect(r.find((x) => x.kind === "Interface")).toMatchObject({
      from: "northwind",
      to: "orders",
      via: "webhook",
      confidence: "inferred",
    });
  });
});

describe("mesh", () => {
  const meshSetting = (component: string) =>
    rec({
      kind: "Setting",
      id: `${component}.mesh`,
      component,
      settingKind: "config",
      key: MESH_KEY,
      valueOrRef: "sidecar",
      evidence: ev(component),
    });
  const call = (from: string, to: string, via: string) =>
    rec({
      kind: "Interface",
      id: interfaceId(from, to, "GET", "/x"),
      confidence: "inferred",
      from,
      to,
      via,
      method: "GET",
      normalizedPath: "/x",
      sync: "sync",
      evidence: ev(from),
    });

  it("marks direct calls between two meshed components via mesh, and nothing else", () => {
    const r = merge([
      component("a", "shop"),
      component("b", "shop"),
      component("c", "shop"),
      meshSetting("a"),
      meshSetting("b"),
      call("a", "b", "direct"),
      call("a", "c", "direct"),
      call("b", "a", "gateway"),
    ]);
    const via = Object.fromEntries(
      r
        .filter((x) => x.kind === "Interface")
        .map((i) => [`${String(i.from)}>${String(i.to)}`, i.via]),
    );
    expect(via).toEqual({ "a>b": "mesh", "a>c": "direct", "b>a": "gateway" });
  });
});

describe("component types", () => {
  it("a documented type wins over a repo type, whichever record comes first", () => {
    const r = merge([component("resize", "shop", "node"), component("resize", "shop", "function")]);
    expect(r.find((x) => x.id === "resize")).toMatchObject({ type: "function" });
    const keep = merge([component("x", "shop", "service"), component("x", "shop", "function")]);
    expect(keep.find((x) => x.id === "x")).toMatchObject({ type: "service" });
  });
});
