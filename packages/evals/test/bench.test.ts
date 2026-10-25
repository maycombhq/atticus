import { describe, expect, it } from "vitest";
import type { CatalogRecord } from "@maycombhq/core";
import { benchFacts, normalizePath, parseReference, scoreRepo } from "../src/bench.js";

const rec = (r: Record<string, unknown>) =>
  ({
    schemaVersion: 2,
    status: "current",
    confidence: "verified",
    evidence: [],
    ...r,
  }) as unknown as CatalogRecord;

/** A scan of a small invented repo, as the scanner writes it. */
const scanned: CatalogRecord[] = [
  rec({
    kind: "Endpoint",
    id: "a.get-owner",
    component: "a",
    endpointType: "rest",
    method: "get",
    pathOrTopic: "/owners/{ownerId}",
  }),
  rec({
    kind: "Endpoint",
    id: "a.post-owner",
    component: "a",
    endpointType: "rest",
    method: "POST",
    pathOrTopic: "/owners/",
  }),
  // Wrong: the reference says this repo serves no /health.
  rec({
    kind: "Endpoint",
    id: "a.get-health",
    component: "a",
    endpointType: "rest",
    method: "GET",
    pathOrTopic: "/health",
  }),
  rec({
    kind: "Endpoint",
    id: "a.orders-topic",
    component: "a",
    endpointType: "event-topic",
    pathOrTopic: "orders.created",
  }),
  rec({
    kind: "Unresolved",
    id: "a.http-call.1",
    unresolvedKind: "http-call",
    raw: "GET {API}/api/vets/:id?full=1",
    owner: "a",
  }),
  rec({
    kind: "Interface",
    id: "if-1",
    from: "a",
    to: "b",
    method: "POST",
    normalizedPath: "/visits",
    via: "direct",
    sync: "sync",
    direction: "outbound",
  }),
  rec({ kind: "Table", id: "db.owners", dataStore: "db", name: "OWNERS" }),
  rec({ kind: "Table", id: "db.public.pets", dataStore: "db", name: "public.pets" }),
  rec({ kind: "Deployment", id: "a.k8s", component: "a", env: "prod", platform: "kubernetes" }),
  // Not a kind the bench scores.
  rec({ kind: "Setting", id: "a.setting.x", component: "a", key: "x", valueOrRef: "1" }),
];

const reference = parseReference(`
repo: invented-owners
commit: 0123456789abcdef0123456789abcdef01234567
covers: [serves, calls, stores, deploys]
serves:
  - { type: rest, method: GET, path: "/owners/{id}", at: "src/Owners.java:10" }
  - { type: rest, method: POST, path: /owners, at: "src/Owners.java:20" }
  - { type: rest, method: DELETE, path: "/owners/{id}", at: "src/Owners.java:30" }
  - { type: event-topic, path: orders.created, at: "src/Listener.java:5" }
calls:
  - { method: GET, path: "/api/vets/{id}", at: "src/VetClient.java:12" }
  - { method: POST, path: /visits, at: "src/VisitClient.java:8" }
stores:
  - { table: owners, at: "db/schema.sql:1" }
  - { table: pets, at: "db/schema.sql:9" }
  - { table: visits, at: "db/schema.sql:17" }
deploys:
  - { platform: kubernetes, at: "k8s/app.yaml:1" }
`);

describe("bench: scoring a scan against a hand-written reference", () => {
  it("normalises paths the way references are written", () => {
    expect(normalizePath("/owners/{ownerId}/")).toBe("/owners/{}");
    expect(normalizePath("{API}/api/vets/:id?full=1")).toBe("/api/vets/{}");
    // Django's path converters, Rails' globs and optional format (batch 3)
    expect(normalizePath("/api/users/<int:user_id>/update")).toBe("/api/users/{}/update");
    expect(normalizePath("/*full_name/info(.:format)")).toBe("/{}/info");
    expect(normalizePath("/*full_name")).toBe("/{}");
    expect(normalizePath("https://vets.example.com/api/vets/${id}")).toBe("/api/vets/{}");
    expect(normalizePath("orders.created")).toBe("orders.created");
  });

  it("turns catalog records into the four kinds of fact", () => {
    const f = benchFacts(scanned);
    expect(f.serves).toEqual([
      "event-topic orders.created",
      "rest GET /health",
      "rest GET /owners/{}",
      "rest POST /owners",
    ]);
    expect(f.calls).toEqual(["GET /api/vets/{}", "POST /visits"]);
    expect(f.stores).toEqual(["owners", "pets"]);
    expect(f.deploys).toEqual(["kubernetes"]);
  });

  it("counts found, missed and wrong per kind, with precision and recall", () => {
    const s = scoreRepo(reference, scanned);
    expect(s.repo).toBe("invented-owners");
    expect(s.kinds.serves).toEqual({
      found: 3,
      missed: ["rest DELETE /owners/{}"],
      wrong: ["rest GET /health"],
      precision: 0.75,
      recall: 0.75,
    });
    expect(s.kinds.calls).toMatchObject({
      found: 2,
      missed: [],
      wrong: [],
      precision: 1,
      recall: 1,
    });
    expect(s.kinds.stores).toMatchObject({ found: 2, missed: ["visits"], wrong: [] });
    expect(s.kinds.deploys).toMatchObject({ found: 1, missed: [], wrong: [] });
    expect(s.total).toEqual({ found: 8, missed: 2, wrong: 1, precision: 8 / 9, recall: 0.8 });
  });

  it("writes gRPC as Service/Method and events as topics, on both sides", () => {
    const records = [
      rec({
        kind: "Endpoint",
        id: "cart.add",
        component: "cart",
        endpointType: "grpc",
        method: "AddItem",
        pathOrTopic: "hipstershop.CartService/AddItem",
      }),
      rec({
        kind: "Endpoint",
        id: "ord.sub",
        component: "ord",
        endpointType: "event-topic",
        pathOrTopic: "OrderStartedIntegrationEvent",
      }),
      rec({
        kind: "Interface",
        id: "if-g",
        from: "web",
        to: "cart",
        method: "AddItem",
        normalizedPath: "hipstershop.CartService/AddItem",
        via: "direct",
        sync: "sync",
        direction: "outbound",
      }),
      rec({
        kind: "Interface",
        id: "if-e",
        from: "ord",
        to: "bus",
        normalizedPath: "OrderPaidIntegrationEvent",
        via: "event-bus",
        sync: "async",
        direction: "outbound",
      }),
    ];
    expect(benchFacts(records)).toMatchObject({
      serves: ["event-topic OrderStartedIntegrationEvent", "grpc hipstershop.CartService/AddItem"],
      calls: ["event OrderPaidIntegrationEvent", "grpc hipstershop.CartService/AddItem"],
    });
    const ref = parseReference(`
repo: invented-shop
commit: 0123456789abcdef0123456789abcdef01234567
covers: [serves, calls]
serves:
  - { type: grpc, path: hipstershop.CartService/AddItem, at: "cart/Cart.cs:3" }
  - { type: event-topic, path: OrderStartedIntegrationEvent, at: "ord/Handler.cs:9" }
calls:
  - { type: grpc, path: hipstershop.CartService/AddItem, at: "web/cart.go:20" }
  - { type: event, path: OrderPaidIntegrationEvent, at: "ord/Publish.cs:4" }
  - { type: soap, path: ICatalogService/GetItems, at: "client/CatalogClient.cs:7" }
`);
    // A SOAP call is named Contract/Operation and isn't read as a REST path.
    expect(scoreRepo(ref, records).kinds.calls!.missed).toEqual(["soap ICatalogService/GetItems"]);
    expect(scoreRepo(ref, records).total).toMatchObject({ found: 4, missed: 1, wrong: 0 });
  });

  it("keeps optional route parameters, ignores letter case, and lets ANY match any method", () => {
    // An optional, typed parameter isn't a query string.
    expect(normalizePath("/api/items/type/{typeId?}/brand/{brandId:int?}")).toBe(
      "/api/items/type/{}/brand/{}",
    );
    const records = [
      rec({
        kind: "Endpoint",
        id: "x.brands",
        component: "x",
        endpointType: "rest",
        method: "DELETE",
        pathOrTopic: "/api/Brands/{id}",
      }),
      rec({
        kind: "Endpoint",
        id: "x.any",
        component: "x",
        endpointType: "rest",
        method: "ANY",
        pathOrTopic: "/cart",
      }),
    ];
    const ref = parseReference(`
repo: invented
commit: 0123456789abcdef0123456789abcdef01234567
covers: [serves]
serves:
  - { type: rest, method: DELETE, path: "/api/brands/{id}", at: "a.cs:1" }
  - { type: rest, method: GET, path: /cart, at: "main.go:9" }
  - { type: rest, path: /cart, at: "main.go:9" }
`);
    // A route with no method in the reference, or ANY in the scan, matches the same path.
    expect(scoreRepo(ref, records).kinds.serves).toMatchObject({ found: 3, missed: [], wrong: [] });
  });

  it("scores only the kinds a reference says it covers", () => {
    const partial = parseReference(`
repo: invented-owners
commit: 0123456789abcdef0123456789abcdef01234567
covers: [stores]
stores:
  - { table: owners, at: "db/schema.sql:1" }
  - { table: pets, at: "db/schema.sql:9" }
`);
    const s = scoreRepo(partial, scanned);
    expect(Object.keys(s.kinds)).toEqual(["stores"]);
    expect(s.total).toMatchObject({ found: 2, missed: 0, wrong: 0 });
  });

  it("refuses a reference fact without a file and line, or a kind it doesn't cover", () => {
    expect(() =>
      parseReference(
        `repo: x\ncommit: 0123456789abcdef0123456789abcdef01234567\ncovers: [stores]\nstores:\n  - { table: owners }\n`,
      ),
    ).toThrow(/at/);
    expect(() =>
      parseReference(
        `repo: x\ncommit: 0123456789abcdef0123456789abcdef01234567\ncovers: [stores]\nserves:\n  - { type: rest, method: GET, path: /x, at: "a.java:1" }\n`,
      ),
    ).toThrow(/serves.*isn't in covers/);
  });
});
