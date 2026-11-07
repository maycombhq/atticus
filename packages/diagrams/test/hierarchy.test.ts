import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { DECLARED_TOPIC, interfaceId, parseRecord, type CatalogRecord } from "@maycombhq/core";
import { buildEstate, focusView, nodeView, viewKey } from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");

function forge(extra: Record<string, unknown>[] = []): CatalogRecord[] {
  const raw = parse(readFileSync(join(FORGE, "expected/scan.yaml"), "utf8")) as Record<
    string,
    unknown
  >[];
  return [...raw, ...extra].map((r) => {
    const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
    if (!p.ok) throw new Error(`${String(r.id)}: ${JSON.stringify(p.issues)}`);
    return p.record;
  });
}

const ev = [{ source: "config", repo: "forge-portal-bff", path: "pom.xml", line: 3 }];
/** Three modules of one repo: a uses b, b uses c, a uses c (a's use of c is implied). */
const modules = [
  {
    kind: "Component",
    id: "portal-core",
    confidence: "verified",
    system: "portal",
    repo: "forge-portal-bff",
    type: "library",
    evidence: ev,
  },
  {
    kind: "Component",
    id: "portal-web",
    confidence: "verified",
    system: "portal",
    repo: "forge-portal-bff",
    type: "library",
    uses: ["portal-core"],
    evidence: ev,
  },
  {
    kind: "Component",
    id: "portal-app",
    confidence: "verified",
    system: "portal",
    repo: "forge-portal-bff",
    type: "library",
    uses: ["portal-web", "portal-core"],
    evidence: ev,
  },
];

const ids = (ns: { id: string }[]) => ns.map((n) => n.id);
const edge = (v: { edges: { from: string; to: string; type: string; count: number }[] }) =>
  v.edges.map((e) => `${e.from} ${e.type} ${e.to}${e.count > 1 ? ` x${e.count}` : ""}`).sort();

describe("the estate as a hierarchy: estate, system, repo, component, element", () => {
  it("opens the estate on its systems, each with its children counted and its evidence", () => {
    const v = nodeView(buildEstate(forge()), "estate", { lens: "architecture" });
    expect(v.node).toMatchObject({ id: "estate", kind: "estate", label: "Estate" });
    expect(v.path).toEqual([]);
    expect(ids(v.children)).toEqual([
      "system:audit",
      "system:ledger",
      "system:northwind-pay",
      "system:portal",
      "system:reports",
      // Each topic is drawn as itself (F10): publishers → topic → listeners.
      "topic:topic.payments-initiated",
      "topic:topic.transfers-completed",
    ]);
    const portal = v.children.find((n) => n.id === "system:portal")!;
    expect(portal).toMatchObject({
      kind: "system",
      label: "Portal",
      parent: "estate",
      childCount: 2,
      state: "current",
      gaps: [],
      record: { kind: "System", id: "portal" },
      next: { command: "atticus guide portal" },
    });
    expect(portal.evidence).toEqual([
      { source: "config", repo: "forge-portal-bff", at: "pom.xml" },
    ]);
    // The inferred system is flagged as a gap: nothing in its own code was read.
    expect(v.children.find((n) => n.id === "system:audit")!.gaps).toContain("inferred");
  });

  it("merges the calls between systems into one edge each, with a count", () => {
    const v = nodeView(buildEstate(forge()), "estate", { lens: "architecture" });
    expect(edge(v)).toEqual([
      "system:ledger calls system:northwind-pay",
      "system:ledger publishes topic:topic.transfers-completed",
      "system:ledger subscribes topic:topic.payments-initiated",
      "system:portal calls system:audit",
      "system:portal calls system:ledger x2",
      "system:portal publishes topic:topic.payments-initiated",
      "system:reports reads system:ledger",
      "system:reports subscribes topic:topic.transfers-completed",
    ]);
    const calls = v.edges.find((e) => e.from === "system:portal" && e.to === "system:ledger")!;
    expect(calls).toMatchObject({ type: "calls", sync: "sync", via: "gateway", state: "current" });
    expect(calls.evidence).toContainEqual({
      source: "code",
      repo: "forge-portal-bff",
      at: "src/main/java/forge/portal/LedgerClient.java:8",
    });
  });

  it("opens a system on its repos, a repo on its components and a component on its elements", () => {
    const est = buildEstate(forge());
    const sys = nodeView(est, "system:portal", { lens: "architecture" });
    expect(ids(sys.path)).toEqual(["estate"]);
    expect(ids(sys.children)).toEqual([
      "repo:forge-portal-bff",
      "repo:forge-portal-ui",
      "topic:topic.payments-initiated",
    ]);
    // Inside the system, the UI's repo calls the BFF's repo; outside, the BFF calls three systems.
    expect(edge(sys)).toEqual([
      "repo:forge-portal-bff calls system:audit",
      "repo:forge-portal-bff calls system:ledger x2",
      "repo:forge-portal-bff publishes topic:topic.payments-initiated",
      "repo:forge-portal-ui calls repo:forge-portal-bff",
      "system:ledger subscribes topic:topic.payments-initiated",
    ]);
    expect(ids(sys.outside)).toEqual(["system:audit", "system:ledger"]);

    const repo = nodeView(est, "repo:forge-portal-bff", { lens: "architecture" });
    expect(ids(repo.path)).toEqual(["estate", "system:portal"]);
    expect(ids(repo.children)).toEqual(["component:portal-bff", "topic:topic.payments-initiated"]);

    const comp = nodeView(est, "component:portal-bff", { lens: "architecture" });
    expect(ids(comp.children)).toEqual([
      "endpoint:portal-bff.get-balance",
      "topic:topic.payments-initiated",
      "client:portal-bff.audit-svc",
      "client:portal-bff.ledger-api",
    ]);
    const ep = comp.children[0]!;
    expect(ep).toMatchObject({
      kind: "endpoint",
      label: "GET /api/balance/{accountId}",
      childCount: 0,
      properties: { endpointType: "rest", method: "GET" },
      next: { command: "atticus impact portal-bff.get-balance" },
    });
    expect(ep.evidence[0]!.at).toBe("src/main/java/forge/portal/BalanceController.java:12");
    expect(edge(comp)).toContain("client:portal-bff.ledger-api calls system:ledger x2");
    expect(edge(comp)).toContain("repo:forge-portal-ui calls endpoint:portal-bff.get-balance");
  });

  it("loads more than one level when asked, each child naming its parent", () => {
    const v = nodeView(buildEstate(forge()), "system:ledger", { lens: "architecture", depth: 2 });
    expect(ids(v.children)).toEqual([
      "repo:forge-ledger",
      "component:ledger-api",
      "topic:topic.transfers-completed",
    ]);
    expect(v.children[1]!.parent).toBe("repo:forge-ledger");
  });

  it("marks a gap where the catalog is missing a part: a component with no repo", () => {
    const v = nodeView(buildEstate(forge()), "system:audit", { lens: "architecture" });
    expect(ids(v.children)).toEqual(["component:audit-svc"]);
    expect(v.children[0]!.gaps).toEqual(expect.arrayContaining(["inferred", "no-repo"]));
  });

  it("refuses a node it doesn't have", () => {
    expect(() =>
      nodeView(buildEstate(forge()), "system:nowhere", { lens: "architecture" }),
    ).toThrow(/There is no node system:nowhere/);
  });
});

describe("an estate read from facts, with no System record (a real metarepo, 2026-10-25)", () => {
  // As atticus verify --write projects one repo's facts: its components carry the system the
  // manifest names, and a call names an outside system (a model provider) no component is.
  const studio = () => {
    const at = (path: string, line: number) => [
      { source: "code", repo: "forge-studio", path, line, by: "assistant" },
    ];
    return [
      {
        kind: "Component",
        id: "api",
        confidence: "verified",
        system: "studio",
        repo: "forge-studio",
        type: "service",
        evidence: at("api/src/main/java/forge/studio/NotesController.java", 15),
      },
      {
        kind: "Component",
        id: "web",
        confidence: "verified",
        system: "studio",
        repo: "forge-studio",
        type: "spa",
        evidence: at("web/src/app/app.routes.ts", 5),
      },
      {
        kind: "Interface",
        id: "if-227370d7866959d3",
        confidence: "verified",
        from: "api",
        to: "llm",
        via: "direct",
        method: "POST",
        normalizedPath: "/v1/messages",
        sync: "sync",
        direction: "outbound",
        conflicts: [],
        evidence: at("api/src/main/java/forge/studio/SummaryClient.java", 9),
      },
    ].map((r) => {
      const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
      if (!p.ok) throw new Error(`${r.id}: ${JSON.stringify(p.issues)}`);
      return p.record;
    });
  };

  it("draws the system the components name, and the outside system a call names", () => {
    const est = buildEstate(studio());
    const v = nodeView(est, "estate", { lens: "architecture" });
    expect(ids(v.children)).toEqual(["system:llm", "system:studio"]);
    expect(v.node.next?.command).toMatch(/^atticus map /);
    const sys = v.children.find((n) => n.id === "system:studio")!;
    expect(sys).toMatchObject({ kind: "system", label: "studio", childCount: 1, gaps: [] });
    expect(sys.record).toBeUndefined();
    const llm = v.children.find((n) => n.id === "system:llm")!;
    expect(llm).toMatchObject({
      kind: "system",
      label: "llm",
      childCount: 0,
      properties: { boundary: "outside" },
      next: { command: 'atticus query "kind:interface to:llm"' },
    });
    expect(edge(v)).toEqual(["system:studio calls system:llm"]);
    const repo = nodeView(est, "repo:forge-studio", { lens: "architecture" });
    expect(ids(repo.path)).toEqual(["estate", "system:studio"]);
    expect(repo.node.gaps).toEqual([]);
    expect(repo.node.next?.command).toBe("atticus map forge-studio");
    expect(JSON.stringify([...est.nodes.values()])).not.toMatch(/atticus scan/);
  });
});

describe("topics and queues as nodes of their own (F10)", () => {
  const at = (repo: string, path: string, line: number) => [
    { source: "code", repo, path, line, side: "caller" },
  ];
  const loose = [
    {
      kind: "Unresolved",
      id: "unresolved.portal-refunds",
      confidence: "verified",
      unresolvedKind: "event-publish",
      raw: "refunds.requested",
      owner: "portal-bff",
      evidence: at("forge-portal-bff", "src/main/java/forge/portal/RefundEvents.java", 9),
    },
    {
      kind: "Unresolved",
      id: "unresolved.ledger-fx",
      confidence: "verified",
      unresolvedKind: "event-subscribe",
      raw: "fx.rates",
      owner: "ledger-api",
      evidence: at("forge-ledger", "src/main/java/forge/ledger/FxListener.java", 4),
    },
    {
      kind: "Interface",
      id: interfaceId("ledger-api", "tidewater", undefined, "statements.out"),
      confidence: "verified",
      from: "ledger-api",
      to: "tidewater",
      via: "mq",
      normalizedPath: "statements.out",
      sync: "async",
      direction: "outbound",
      conflicts: [],
      evidence: at("forge-ledger", "src/main/java/forge/ledger/StatementQueue.java", 12),
    },
  ];

  it("draws publishers → topic → listeners, the topic owned by the system it sits in", () => {
    const est = buildEstate(forge());
    const t = est.nodes.get("topic:topic.payments-initiated")!;
    expect(t.properties).toMatchObject({ owner: "Portal" });
    expect(t.properties.ownerOutside).toBeUndefined();
    expect(t.gaps).toEqual([]);
  });

  it("marks a topic published to with no listener, and one listened to with no publisher", () => {
    const est = buildEstate(forge(loose));
    const v = nodeView(est, "estate", { lens: "architecture" });
    const refunds = [...v.children, ...v.outside].find((n) => n.label === "refunds.requested")!;
    expect(refunds).toMatchObject({ kind: "topic", gaps: ["no-listener"] });
    const fx = [...v.children, ...v.outside].find((n) => n.label === "fx.rates")!;
    expect(fx).toMatchObject({ kind: "topic", gaps: ["no-publisher"] });
    expect(fx.properties).toMatchObject({ owner: "Ledger" });
    expect(edge(v)).toEqual(
      expect.arrayContaining([
        `system:portal publishes ${refunds.id}`,
        `system:ledger subscribes ${fx.id}`,
      ]),
    );
  });

  it("names an outside system as the owner of a queue it claims, with no listener in the estate", () => {
    const est = buildEstate(forge(loose));
    const q = [...est.nodes.values()].find((n) => n.label === "statements.out")!;
    expect(q).toMatchObject({ kind: "topic", parent: "system:tidewater" });
    expect(q.properties).toMatchObject({ owner: "tidewater", ownerOutside: true });
    expect(q.gaps).toEqual(["no-listener"]);
    const v = nodeView(est, "system:ledger", { lens: "architecture" });
    expect(edge(v)).toContain(`repo:forge-ledger publishes ${q.id}`);
    expect(ids(v.outside)).toContain(q.id);
  });

  // ADR 0162 §6 (F8): a topic the profile names among an outside system's, no repo of the estate
  // serving the other side: the person's word, drawn on that system and marked declared.
  const said = {
    source: "manual",
    path: "org-pack/profiles/ledger.yaml",
    by: "person",
  };
  const declared = (from: string, to: string, path: string, line: number, via = "event-bus") => ({
    kind: "Interface",
    id: interfaceId(from, to, undefined, path),
    confidence: "asserted",
    from,
    to,
    via,
    normalizedPath: path,
    sync: "async",
    direction: "outbound",
    conflicts: [],
    flags: [DECLARED_TOPIC],
    evidence: [
      { source: "code", repo: "forge-ledger", path: "src/main/java/forge/ledger/Bus.java", line },
      said,
    ],
  });

  it("places a vendor's declared topic the estate listens on under the vendor, the person's word", () => {
    const est = buildEstate(forge([declared("tidewater", "ledger-api", "tidewater.rates", 7)]));
    const t = [...est.nodes.values()].find((n) => n.label === "tidewater.rates")!;
    expect(t).toMatchObject({ kind: "topic", parent: "system:tidewater" });
    expect(t.properties).toMatchObject({ owner: "tidewater", ownerOutside: true, declared: true });
    expect(t.gaps).toEqual(["declared-topic", "no-publisher"]);
    expect(t.evidence).toContainEqual({ source: "manual", at: "org-pack/profiles/ledger.yaml" });
    const v = nodeView(est, "estate", { lens: "architecture" });
    expect(edge(v)).toEqual(
      expect.arrayContaining([
        `system:tidewater publishes ${t.id}`,
        `system:ledger subscribes ${t.id}`,
      ]),
    );
    for (const e of v.edges.filter((x) => x.to === t.id)) {
      expect(e.gaps).toContain("declared-topic");
      expect(e.joins?.[0]).toMatchObject({ how: "declared", path: "tidewater.rates" });
      expect(e.joins?.[0]!.other).toContainEqual({
        source: "manual",
        at: "org-pack/profiles/ledger.yaml",
      });
    }
  });

  it("places a declared queue the estate sends to under the other team's system, the person's word", () => {
    const est = buildEstate(
      forge([declared("ledger-api", "harbor-audit", "harbor.audit.events", 9, "mq")]),
    );
    const t = [...est.nodes.values()].find((n) => n.label === "harbor.audit.events")!;
    expect(t).toMatchObject({ kind: "topic", parent: "system:harbor-audit" });
    expect(t.properties).toMatchObject({
      owner: "harbor-audit",
      ownerOutside: true,
      declared: true,
    });
    expect(t.gaps).toEqual(["declared-topic", "no-listener"]);
    const v = nodeView(est, "estate", { lens: "architecture" });
    const pub = v.edges.find((e) => e.to === t.id)!;
    expect(pub).toMatchObject({ from: "system:ledger", type: "publishes" });
    expect(pub.gaps).toContain("declared-topic");
    expect(pub.joins?.[0]?.how).toBe("declared");
  });

  it("never counts a vendor System record's publish as the estate's", () => {
    const est = buildEstate(
      forge([declared("northwind-pay", "ledger-api", "northwind.settlements", 11)]),
    );
    const t = [...est.nodes.values()].find((n) => n.label === "northwind.settlements")!;
    expect(t).toMatchObject({ kind: "topic", parent: "system:northwind-pay" });
    expect(t.properties).toMatchObject({ owner: "Northwind Pay", ownerOutside: true });
    expect(t.gaps).toEqual(["declared-topic", "no-publisher"]);
  });
});

describe("lenses on the same model", () => {
  it("the data lens shows only what holds or touches data, and suggests focus on tables", () => {
    const est = buildEstate(forge());
    const v = nodeView(est, "estate", { lens: "data" });
    expect(ids(v.children)).toEqual(["system:ledger", "system:reports"]);
    const store = nodeView(est, "store:ledger-db", { lens: "data" });
    expect(ids(store.path)).toEqual([
      "estate",
      "system:ledger",
      "repo:forge-ledger",
      "component:ledger-api",
    ]);
    expect(ids(store.children)).toEqual(["table:ledger-db.account", "table:ledger-db.entry"]);
    expect(edge(store)).toEqual([
      "component:ledger-api reads table:ledger-db.account",
      "component:ledger-api reads table:ledger-db.entry",
      "component:ledger-api writes table:ledger-db.account",
      "component:ledger-api writes table:ledger-db.entry",
      "system:reports reads table:ledger-db.entry",
      "table:ledger-db.entry references table:ledger-db.account",
    ]);
    expect(store.suggest).toEqual({ mode: "focus", id: "table:ledger-db.account" });
  });

  it("the integration lens keeps calls and topics; the infrastructure lens deployments", () => {
    const est = buildEstate(forge());
    const i = nodeView(est, "estate", { lens: "integration" });
    expect(edge(i).every((e) => / (calls|publishes|subscribes) /.test(e))).toBe(true);
    const inf = nodeView(est, "estate", { lens: "infrastructure" });
    expect(ids(inf.children)).toEqual(["system:ledger", "system:portal", "environment:prod"]);
    expect(edge(inf)).toEqual([
      "system:ledger deployed-to environment:prod",
      "system:portal deployed-to environment:prod",
    ]);
    const c = nodeView(est, "component:ledger-api", { lens: "infrastructure" });
    expect(ids(c.children)).toEqual(["deployment:ledger-api.prod"]);
    expect(c.children[0]!.properties).toMatchObject({
      env: "prod",
      platform: "kubernetes",
      replicas: 3,
    });
  });
});

describe("the spike's rules", () => {
  it("draws the transitive reduction of 'uses' by default, every edge with all", () => {
    const est = buildEstate(forge(modules));
    const v = nodeView(est, "repo:forge-portal-bff", { lens: "architecture" });
    const uses = edge(v).filter((e) => e.includes(" uses "));
    expect(uses).toEqual([
      "component:portal-app uses component:portal-web",
      "component:portal-web uses component:portal-core",
    ]);
    expect(v.reduced).toBe(true);
    expect(v.hiddenEdges).toBe(1);
    const all = nodeView(est, "repo:forge-portal-bff", { lens: "architecture", all: true });
    expect(edge(all).filter((e) => e.includes(" uses "))).toHaveLength(3);
    expect(all.reduced).toBe(false);
    expect(all.hiddenEdges).toBe(0);
  });

  it("focus: a table and its direct neighbours, with the edges between them", () => {
    const v = focusView(buildEstate(forge()), "table:ledger-db.entry", { lens: "data" });
    expect(v.node.id).toBe("table:ledger-db.entry");
    expect(ids(v.neighbours)).toEqual([
      "component:ledger-api",
      "component:reports-job",
      "table:ledger-db.account",
    ]);
    expect(edge(v)).toEqual([
      "component:ledger-api reads table:ledger-db.account",
      "component:ledger-api reads table:ledger-db.entry",
      "component:ledger-api writes table:ledger-db.account",
      "component:ledger-api writes table:ledger-db.entry",
      "component:reports-job reads table:ledger-db.entry",
      "table:ledger-db.entry references table:ledger-db.account",
    ]);
  });

  it("gives the same answer whatever order the records come in", () => {
    const rs = forge(modules);
    const back = [...rs].reverse();
    for (const id of ["estate", "system:portal", "component:portal-bff", "store:ledger-db"])
      expect(nodeView(buildEstate(back), id, { lens: "repo" })).toEqual(
        nodeView(buildEstate(rs), id, { lens: "repo" }),
      );
  });
});

describe("view keys name a layout file", () => {
  it("is a slug made of the lens and the node", () => {
    expect(viewKey("architecture", "estate")).toBe("architecture.estate");
    expect(viewKey("data", "table:ledger-db.entry", "focus")).toBe(
      "data.focus.table-ledger-db.entry",
    );
  });
});

describe("why is this linked: each link's joins, how each was made and both ends (C1, ADR 0135)", () => {
  const cite = (repo: string, path: string, line: number, side: string, source = "code") => ({
    source,
    repo,
    path,
    line,
    side,
    by: "assistant",
  });
  const HOST = interfaceId("web-app", "customers-api", "POST", "/api/customers");
  const PATH = interfaceId("web-app", "customers-api", "GET", "/api/tags");
  const OLD = interfaceId("web-app", "customers-api", "GET", "/api/old");
  const records = () =>
    [
      {
        kind: "Component",
        id: "web-app",
        confidence: "verified",
        system: "web",
        repo: "forge-web",
        type: "spa",
        evidence: [cite("forge-web", "src/main.ts", 1, "caller")],
      },
      {
        kind: "Component",
        id: "customers-api",
        confidence: "verified",
        system: "customers",
        repo: "forge-customers",
        type: "service",
        evidence: [cite("forge-customers", "src/App.java", 1, "callee")],
      },
      {
        kind: "Interface",
        id: HOST,
        confidence: "verified",
        flags: ["joined-by-host"],
        from: "web-app",
        to: "customers-api",
        via: "direct",
        method: "POST",
        normalizedPath: "/api/customers",
        sync: "sync",
        direction: "outbound",
        conflicts: [],
        evidence: [
          cite("forge-web", "src/customer.service.ts", 21, "caller"),
          cite("forge-web", "src/environment.ts", 4, "caller", "config"),
          cite("forge-customers", "src/CustomerController.java", 24, "callee"),
        ],
      },
      {
        kind: "Interface",
        id: PATH,
        confidence: "inferred",
        flags: ["joined-by-path"],
        from: "web-app",
        to: "customers-api",
        via: "gateway",
        route: "gw-edge-get-tags",
        method: "GET",
        normalizedPath: "/api/tags",
        sync: "sync",
        direction: "outbound",
        conflicts: [],
        evidence: [
          cite("forge-web", "src/tags.ts", 7, "caller"),
          cite("forge-edge", "proxies/tags.xml", 3, "gateway", "gateway"),
          cite("forge-customers", "src/TagsController.java", 12, "callee"),
        ],
      },
      {
        kind: "Interface",
        id: OLD,
        confidence: "verified",
        from: "web-app",
        to: "customers-api",
        via: "direct",
        method: "GET",
        normalizedPath: "/api/old",
        sync: "sync",
        direction: "outbound",
        conflicts: [],
        evidence: [{ source: "code", repo: "forge-web", path: "src/old.ts", line: 2 }],
      },
    ].map((r) => {
      const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
      if (!p.ok) throw new Error(`${r.id}: ${JSON.stringify(p.issues)}`);
      return p.record;
    });

  it("lists every call merged into a link, with how it was joined and its cited lines", () => {
    const v = nodeView(buildEstate(records()), "estate", { lens: "architecture" });
    const link = v.edges.find((e) => e.from === "system:web" && e.to === "system:customers")!;
    expect(link.count).toBe(3);
    const byId = (a: { interface: string }, b: { interface: string }) =>
      a.interface < b.interface ? -1 : 1;
    expect(link.joins).toEqual(
      [
        {
          interface: HOST,
          from: "web-app",
          to: "customers-api",
          how: "host",
          gateway: false,
          verified: true,
          method: "POST",
          path: "/api/customers",
          caller: [
            { source: "code", repo: "forge-web", at: "src/customer.service.ts:21" },
            { source: "config", repo: "forge-web", at: "src/environment.ts:4" },
          ],
          callee: [
            { source: "code", repo: "forge-customers", at: "src/CustomerController.java:24" },
          ],
          hops: [],
          other: [],
        },
        {
          interface: OLD,
          from: "web-app",
          to: "customers-api",
          how: "unknown",
          gateway: false,
          verified: true,
          method: "GET",
          path: "/api/old",
          caller: [],
          callee: [],
          hops: [],
          other: [{ source: "code", repo: "forge-web", at: "src/old.ts:2" }],
        },
        {
          interface: PATH,
          from: "web-app",
          to: "customers-api",
          how: "path",
          gateway: true,
          verified: false,
          method: "GET",
          path: "/api/tags",
          caller: [{ source: "code", repo: "forge-web", at: "src/tags.ts:7" }],
          callee: [{ source: "code", repo: "forge-customers", at: "src/TagsController.java:12" }],
          hops: [{ source: "gateway", repo: "forge-edge", at: "proxies/tags.xml:3" }],
          other: [],
        },
      ].sort(byId),
    );
  });

  it("counts a guess as a gap, and how a link was made as none", () => {
    const v = nodeView(buildEstate(records()), "estate", { lens: "architecture" });
    const link = v.edges.find((e) => e.from === "system:web" && e.to === "system:customers")!;
    expect(link.gaps).toEqual(["inferred", "joined-by-path"]);
  });

  it("counts a link a person paired as no gap: inferred, but theirs (ADR 0174)", () => {
    const rs = records().map((r) =>
      r.id === PATH ? ({ ...r, flags: ["joined-by-person"] } as typeof r) : r,
    );
    const v = nodeView(buildEstate(rs), "estate", { lens: "architecture" });
    const link = v.edges.find((e) => e.from === "system:web" && e.to === "system:customers")!;
    expect(link.gaps).toEqual([]);
  });

  it("counts a contract or traffic bearing a link out as no gap, and a contract that disagrees as one (ADR 0151)", () => {
    const rs = records().map((r) =>
      r.id === PATH
        ? ({
            ...r,
            flags: [...(r.flags ?? []), "confirmed-by-contract", "seen-in-traffic"],
          } as typeof r)
        : r,
    );
    const v = nodeView(buildEstate(rs), "estate", { lens: "architecture" });
    const link = v.edges.find((e) => e.from === "system:web" && e.to === "system:customers")!;
    expect(link.gaps).toEqual(["inferred", "joined-by-path"]);
    const off = records().map((r) =>
      r.id === PATH ? ({ ...r, flags: [...(r.flags ?? []), "contract-disagrees"] } as typeof r) : r,
    );
    const w = nodeView(buildEstate(off), "estate", { lens: "architecture" });
    expect(
      w.edges.find((e) => e.from === "system:web" && e.to === "system:customers")!.gaps,
    ).toContain("contract-disagrees");
  });

  it.each([
    ["joined-by-platform-setting", "platform-setting"],
    ["joined-by-folder-name", "folder-name"],
    ["joined-despite-conflict", "conflict"],
  ] as const)("reads %s as a guess: a gap, and how the link was joined (J0, J1)", (flag, how) => {
    const rs = records().map((r) => (r.id === PATH ? ({ ...r, flags: [flag] } as typeof r) : r));
    const v = nodeView(buildEstate(rs), "estate", { lens: "architecture" });
    const link = v.edges.find((e) => e.from === "system:web" && e.to === "system:customers")!;
    expect(link.gaps).toEqual(["inferred", flag]);
    expect(link.joins!.find((j) => j.interface === PATH)).toMatchObject({ how, verified: false });
  });

  it("says a call joined to another team's shared map is theirs, naming the team, their line and commit (O3, ADR 0160)", () => {
    const rs = records().map((r) =>
      r.id === OLD
        ? ({
            ...r,
            flags: ["joined-to-shared-map"],
            evidence: [
              ...r.evidence,
              {
                source: "code",
                repo: "forge-risk-scoring",
                path: "src/main/java/forge/risk/ScoresController.java",
                line: 12,
                commit: "5555eee",
                side: "callee",
                extractor: "atticus-shared@1",
                by: "forge-risk-team",
              },
            ],
          } as typeof r)
        : r,
    );
    const v = nodeView(buildEstate(rs), "estate", { lens: "architecture" });
    const link = v.edges.find((e) => e.from === "system:web" && e.to === "system:customers")!;
    expect(link.joins!.find((j) => j.interface === OLD)).toMatchObject({
      how: "shared",
      shared: {
        team: "forge-risk-team",
        repo: "forge-risk-scoring",
        at: "src/main/java/forge/risk/ScoresController.java:12",
        commit: "5555eee",
      },
    });
    // A how, never a gap; the others have no shared end.
    expect(link.gaps).not.toContain("joined-to-shared-map");
    expect(link.joins!.find((j) => j.interface === HOST)!.shared).toBeUndefined();
  });
});
