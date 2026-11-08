import { describe, expect, it } from "vitest";
import {
  endpointId,
  interfaceId,
  mergeCatalog,
  type CatalogRecord,
  type MergePattern,
} from "../src/index.js";

const ev = [
  {
    source: "code" as const,
    repo: "r",
    path: "a.java",
    line: 1,
    commit: "a1b2c3d",
    scannedAt: "2026-10-18T09:00:00Z",
    extractor: "x@1",
    side: "caller" as const,
  },
];
const base = {
  schemaVersion: 1 as const,
  status: "current" as const,
  confidence: "verified" as const,
  evidence: ev,
};
const component = (id: string, system: string) =>
  ({
    ...base,
    kind: "Component",
    id,
    system,
    repo: `forge-${id}`,
    type: "service",
  }) as unknown as CatalogRecord;
const hop = (from: string, to: string, via: string, path = "/x") =>
  ({
    ...base,
    confidence: "inferred",
    kind: "Interface",
    id: interfaceId(from, to, "GET", path),
    from,
    to,
    via,
    method: "GET",
    normalizedPath: path,
    sync: "sync",
  }) as unknown as CatalogRecord;

const systems = [
  { id: "portal", name: "Portal", boundary: "product" as const, aliases: [] },
  { id: "ledger", name: "Ledger", boundary: "product" as const, aliases: [] },
  { id: "pay", name: "Pay", boundary: "vendor" as const, aliases: [] },
];
const patterns: MergePattern[] = [
  {
    code: "S.DIR.BFF",
    status: "approved",
    detection: { via: ["direct"], sync: "sync", sameSystem: true },
  },
  {
    code: "S.DIR.VND",
    status: "approved",
    detection: { via: ["direct"], targetBoundary: "vendor" },
  },
  { code: "S.OLD", status: "deprecated", detection: { via: ["gateway"] } },
];

function merged(records: CatalogRecord[]) {
  return mergeCatalog({ records, repos: [], systems, patterns });
}

describe("mergeCatalog: inferred integration patterns", () => {
  it("tags a hop with the one approved pattern it fits, and leaves ambiguous or unmatched hops alone", () => {
    const r = merged([
      component("ui", "portal"),
      component("bff", "portal"),
      component("api", "ledger"),
      hop("ui", "bff", "direct"),
      hop("bff", "api", "direct"),
      hop("bff", "api", "gateway", "/y"),
    ]);
    expect(r.invalid.map((i) => JSON.stringify(i.issues))).toEqual([]);
    const ifs = r.records.filter((x) => x.kind === "Interface") as unknown as {
      from: string;
      to: string;
      via: string;
      pattern?: { code: string; source: string };
    }[];
    expect(ifs.find((i) => i.from === "ui")!.pattern).toEqual({
      code: "S.DIR.BFF",
      source: "inferred",
    });
    // Across systems: S.DIR.BFF needs the same system; deprecated patterns never match.
    expect(ifs.find((i) => i.to === "api" && i.via === "direct")!.pattern).toBeUndefined();
    expect(ifs.find((i) => i.to === "api" && i.via === "gateway")!.pattern).toBeUndefined();
  });
});

describe("endpointId", () => {
  it("names an endpoint by component, method and the singular last fixed segment", () => {
    expect(endpointId("ledger-api", "GET", "/accounts/{}/balance")).toBe("ledger-api.get-balance");
    expect(endpointId("ledger-api", "POST", "/transfers")).toBe("ledger-api.post-transfer");
  });

  it("keeps a word that only ends in s whole (sixth UX walk: put-statu)", () => {
    expect(endpointId("ledger-core", "PUT", "/accounts/{}/status")).toBe("ledger-core.put-status");
    expect(endpointId("ledger-core", "GET", "/responses")).toBe("ledger-core.get-response");
    expect(endpointId("ledger-core", "GET", "/cases")).toBe("ledger-core.get-case");
    expect(endpointId("ledger-core", "GET", "/addresses")).toBe("ledger-core.get-address");
    expect(endpointId("ledger-core", "GET", "/analysis")).toBe("ledger-core.get-analysis");
    expect(endpointId("ledger-core", "GET", "/branches")).toBe("ledger-core.get-branch");
    expect(endpointId("ledger-core", "GET", "/policies")).toBe("ledger-core.get-policy");
  });
});

describe("mergeCatalog: data stores", () => {
  const rec = (repo: string, r: Record<string, unknown>) =>
    ({ ...base, evidence: [{ ...ev[0], repo }], ...r }) as unknown as CatalogRecord;
  const storeOf = (repo: string, owner: string, store: string) => [
    rec(repo, {
      kind: "DataStore",
      id: store,
      storeType: "unknown",
      ownerComponent: owner,
      entitiesHeld: [],
    }),
    rec(repo, {
      kind: "Migration",
      id: `${store}.v1`,
      dataStore: store,
      version: "1",
      tool: "flyway",
      file: "V1__init.sql",
      operations: [],
    }),
    rec(repo, {
      kind: "Table",
      id: `${store}.t_${owner}`,
      dataStore: store,
      name: `t_${owner}`,
      tableKind: "table",
      ownerComponent: owner,
      readers: [owner],
      writers: [owner],
    }),
    rec(repo, {
      kind: "Column",
      id: `${store}.t_${owner}.id`,
      table: `${store}.t_${owner}`,
      name: "id",
      type: "varchar",
    }),
  ];

  it("splits one store name claimed by two owning components into a store per owner", () => {
    const r = mergeCatalog({
      records: [
        component("a", "s"),
        component("b", "s"),
        ...storeOf("repo-a", "a", "s-db"),
        ...storeOf("repo-b", "b", "s-db"),
      ],
      repos: [],
      systems: [],
    });
    expect(r.invalid.map((i) => JSON.stringify(i.issues))).toEqual([]);
    const ids = (k: string) =>
      r.records
        .filter((x) => x.kind === k)
        .map((x) => x.id)
        .sort();
    expect(ids("DataStore")).toEqual(["a-db", "b-db"]);
    expect(ids("Migration")).toEqual(["a-db.v1", "b-db.v1"]);
    expect(ids("Table")).toEqual(["a-db.t_a", "b-db.t_b"]);
    expect(r.records.find((x) => x.id === "b-db.t_b.id")).toMatchObject({ table: "b-db.t_b" });
  });

  it("keeps a store with one owner as it is", () => {
    const r = mergeCatalog({
      records: [component("a", "s"), ...storeOf("repo-a", "a", "s-db")],
      repos: [],
      systems: [],
    });
    expect(r.records.filter((x) => x.kind === "DataStore").map((x) => x.id)).toEqual(["s-db"]);
  });
});

describe("mergeCatalog: code is the source of truth", () => {
  it("keeps a record current when a plan describes the same identity as planned", () => {
    const planned = { ...component("api", "s"), status: "planned-new" } as unknown as CatalogRecord;
    const r = mergeCatalog({ records: [planned, component("api", "s")], repos: [], systems: [] });
    expect(r.records.find((x) => x.id === "api")!.status).toBe("current");
  });
});

describe("mergeCatalog: events on a topic the code names but doesn't spell out", () => {
  const loose = (owner: string, kind: string, raw: string, side: "caller" | "callee") =>
    ({
      ...base,
      confidence: "inferred",
      kind: "Unresolved",
      id: `${owner}-${kind}-${raw.replace(/[^a-z]+/gi, "-").toLowerCase()}`,
      unresolvedKind: kind,
      raw,
      owner,
      evidence: [{ ...ev[0]!, side }],
    }) as unknown as CatalogRecord;

  it("joins a publisher and a subscriber of a written-out topic, but not of a constant", () => {
    const r = merged([
      component("bff", "portal"),
      component("api", "ledger"),
      loose("bff", "event-publish", "payments.initiated", "caller"),
      loose("api", "event-subscribe", "payments.initiated", "callee"),
      // @KafkaListener(topics = Topics.PAYMENTS): the topic's real name isn't known.
      loose("bff", "event-publish", "${Topics.PAYMENTS}", "caller"),
      loose("api", "event-subscribe", "${Topics.PAYMENTS}", "callee"),
    ]);
    const ifs = r.records.filter((x) => x.kind === "Interface") as unknown as {
      normalizedPath: string;
    }[];
    expect(ifs.map((i) => i.normalizedPath)).toEqual(["payments.initiated"]);
    expect(
      r.records
        .filter((x) => x.kind === "Unresolved")
        .map((x) => (x as unknown as { raw: string }).raw)
        .sort(),
    ).toEqual(["${Topics.PAYMENTS}", "${Topics.PAYMENTS}"]);
    expect(r.records.filter((x) => x.kind !== "Unresolved" && x.id.includes("topics"))).toEqual([]);
  });
});

describe("mergeCatalog: hosts and gateways (ADR 0053)", () => {
  const at = (repo: string, side: "caller" | "callee" | "definition") => [
    { ...ev[0]!, repo, side },
  ];
  const endpoint = (componentId: string, method: string, path: string) =>
    ({
      ...base,
      kind: "Endpoint",
      id: endpointId(componentId, method, path),
      component: componentId,
      endpointType: "rest",
      method,
      pathOrTopic: path,
      normalizedPath: path,
      evidence: at(`forge-${componentId}`, "callee"),
    }) as unknown as CatalogRecord;
  const route = (id: string, basepath: string, target: string) =>
    ({
      ...base,
      kind: "GatewayRoute",
      id,
      proxy: id,
      basepath,
      target,
      evidence: at("forge-gateway", "definition"),
    }) as unknown as CatalogRecord;
  const call = (owner: string, raw: string) =>
    ({
      ...base,
      confidence: "inferred",
      kind: "Unresolved",
      id: `${owner}-${raw.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
      unresolvedKind: "http-call",
      raw,
      owner,
      evidence: at(`forge-${owner}`, "caller"),
    }) as unknown as CatalogRecord;
  const records = [
    component("bff", "portal"),
    component("api", "ledger"),
    component("cards", "ledger"),
    endpoint("api", "POST", "/transfers"),
    endpoint("api", "GET", "/health"),
    endpoint("cards", "GET", "/cards/{id}"),
    route("gw-ledger-v1", "/ledger/v1", "http://api.forge.internal"),
  ];
  const repos = [
    { id: "forge-bff", component: "bff", type: "spring-boot", hosts: [] },
    {
      id: "forge-api",
      component: "api",
      type: "spring-boot",
      hosts: ["pay-api-*.apps.bank.internal"],
    },
    { id: "forge-cards", component: "cards", type: "spring-boot", hosts: [] },
    { id: "forge-gateway", type: "gateway", hosts: ["gateway.forge.example"] },
  ];
  const run = (extra: CatalogRecord[], r = repos) =>
    mergeCatalog({ records: [...records, ...extra], repos: r, systems, patterns: [] });
  const ifs = (m: ReturnType<typeof run>) =>
    m.records
      .filter((x) => x.kind === "Interface")
      .map((x) => {
        const i = x as unknown as {
          from: string;
          to: string;
          via: string;
          method?: string;
          normalizedPath: string;
          confidence: string;
        };
        return `${i.from}->${i.to} ${i.via} ${i.method ?? ""} ${i.normalizedPath} ${i.confidence}`;
      });

  it("joins a call to a read repo's listed host only where its endpoints serve it (beta.18)", () => {
    const calls = [
      call("bff", "POST https://pay-api-1.apps.bank.internal/transfers"),
      call("bff", "GET https://pay-api-1.apps.bank.internal/statements/{id}"),
    ];
    // Not read: as before, the host the manifest lists joins every call to it.
    expect(
      ifs(run(calls))
        .filter((i) => i.startsWith("bff->api"))
        .sort(),
    ).toEqual([
      "bff->api direct GET /statements/{} inferred",
      "bff->api direct POST /transfers verified",
    ]);
    // Read: only the call one of its endpoints serves; the other stays a loose end.
    const read = repos.map((r) => (r.id === "forge-api" ? { ...r, read: true } : r));
    const m = run(calls, read);
    expect(ifs(m).filter((i) => i.startsWith("bff->api"))).toEqual([
      "bff->api direct POST /transfers verified",
    ]);
    expect(
      m.records.some(
        (r) =>
          r.kind === "Unresolved" && (r as unknown as { raw: string }).raw.includes("/statements/"),
      ),
    ).toBe(true);
  });

  it("reaches an outside system through a host label that is its name or alias, and only then", () => {
    const vendors = [
      ...systems,
      {
        id: "northwind-pay",
        name: "Northwind Pay",
        boundary: "vendor" as const,
        aliases: ["Northwind"],
      },
      { id: "lantern-mail", name: "Lantern Mail", boundary: "vendor" as const, aliases: [] },
      { id: "lantern-sms", name: "Lantern SMS", boundary: "vendor" as const, aliases: [] },
      { id: "harbor-crm", name: "Harbor CRM", boundary: "internal" as const, aliases: ["crm"] },
    ];
    const m = mergeCatalog({
      records: [
        ...records,
        call("bff", "POST https://api.northwind.example/v1/charges"),
        call("bff", "POST https://api.northwindpay.example/v2/refunds"),
        call("bff", "POST https://api.lanternmail.example/v3/messages"),
        // "lantern" alone names two vendors: left loose.
        call("bff", "POST https://lantern.example/x"),
        // F3: another team's system no estate repo belongs to is outside too, as a vendor is.
        call("bff", "GET https://api.crm.example/contacts"),
      ],
      repos,
      systems: vendors,
      patterns: [],
    });
    expect(
      ifs(m)
        .filter((i) => !i.startsWith("bff->api") && !i.startsWith("bff->cards"))
        .sort(),
    ).toEqual([
      "bff->harbor-crm direct GET /contacts inferred",
      "bff->lantern-mail direct POST /v3/messages inferred",
      "bff->northwind-pay direct POST /v1/charges inferred",
      "bff->northwind-pay direct POST /v2/refunds inferred",
    ]);
  });

  it("reaches an outside system a host question added: its alias is the host (O1)", () => {
    const outside = [
      ...systems,
      {
        id: "ledger-tidewater-example",
        name: "ledger.tidewater.example",
        boundary: "internal" as const,
        aliases: ["ledger.tidewater.example"],
      },
      {
        id: "localhost-9970",
        name: "localhost:9970",
        boundary: "vendor" as const,
        aliases: ["localhost:9970"],
      },
    ];
    const m = mergeCatalog({
      records: [
        ...records,
        call("bff", "GET https://ledger.tidewater.example/v1/balances"),
        call("bff", "GET http://localhost:9970/quotes"),
        // Another port of the host is not the system's.
        call("bff", "GET http://localhost:9971/quotes"),
      ],
      repos,
      systems: outside,
      patterns: [],
    });
    expect(
      ifs(m)
        .filter((i) => !i.startsWith("bff->api") && !i.startsWith("bff->cards"))
        .sort(),
    ).toEqual([
      "bff->ledger-tidewater-example direct GET /v1/balances inferred",
      "bff->localhost-9970 direct GET /quotes inferred",
    ]);
  });

  it("tells two services on one host apart by the port a host names (ADR 0088)", () => {
    const local = [
      { id: "forge-bff", component: "bff", type: "spring-boot", hosts: [] },
      // Any port of localhost, unless a host names the port.
      { id: "forge-api", component: "api", type: "spring-boot", hosts: ["localhost"] },
      { id: "forge-cards", component: "cards", type: "spring-boot", hosts: ["localhost:9967"] },
    ];
    const m = run(
      [
        call("bff", "POST http://localhost:9966/transfers"),
        call("bff", "GET http://localhost:9967/cards/{id}"),
        call("bff", "GET http://LOCALHOST/health"),
      ],
      local,
    );
    expect(ifs(m).sort()).toEqual([
      "bff->api direct GET /health verified",
      "bff->api direct POST /transfers verified",
      "bff->cards direct GET /cards/{} verified",
    ]);
    // A host with a port takes only that port: :9966 is no repo's, so the call stays loose.
    const only = run(
      [call("bff", "POST http://localhost:9966/transfers")],
      [local[0]!, { ...local[1]!, hosts: ["localhost:8080"] }, local[2]!],
    );
    expect(ifs(only)).toEqual([]);
    // The scheme's port counts when a URL names none.
    const dflt = run(
      [call("bff", "GET https://api.forge.example/health")],
      [local[0]!, { ...local[1]!, hosts: ["api.forge.example:443"] }],
    );
    expect(ifs(dflt)).toEqual(["bff->api direct GET /health verified"]);
  });

  it("goes through a gateway only on a host declared for the gateway repo", () => {
    const m = run([
      call("bff", "POST https://gateway.forge.example/ledger/v1/transfers"),
      // Same basepath, but a host nobody declared: not the gateway, so not joined.
      call("bff", "POST https://api.partner-bank.example/ledger/v1/transfers"),
    ]);
    expect(ifs(m)).toEqual(["bff->api gateway POST /transfers verified"]);
    expect(m.notes).toContainEqual(expect.stringContaining("api.partner-bank.example"));
  });

  it("joins a call to a host declared for a component, whatever its first label", () => {
    expect(
      ifs(run([call("bff", "POST https://pay-api-uat.apps.bank.internal/transfers")])),
    ).toEqual(["bff->api direct POST /transfers verified"]);
  });

  it("never matches an endpoint of another method", () => {
    // GET /transfers isn't served; POST /transfers is. The call stays unverified.
    expect(ifs(run([call("bff", "GET https://pay-api-uat.apps.bank.internal/transfers")]))).toEqual(
      ["bff->api direct GET /transfers inferred"],
    );
  });

  it("doesn't join a relative call on a generic path such as /health", () => {
    const m = run([call("cards", "GET /health")]);
    expect(ifs(m)).toEqual([]);
    expect(m.records.filter((x) => x.kind === "Unresolved")).toHaveLength(1);
  });
});

describe("mergeCatalog: loose ends of a kind it doesn't join", () => {
  it("keeps them as they are, so nothing an extractor saw disappears", () => {
    const l = (kind: string, raw: string) =>
      ({
        ...base,
        confidence: "inferred",
        kind: "Unresolved",
        id: `api-${kind}`,
        unresolvedKind: kind,
        raw,
        owner: "api",
      }) as unknown as CatalogRecord;
    const r = merged([
      component("api", "ledger"),
      l("mq-publish", "${Queues.ORDERS}"),
      l("http-endpoint", "GET ${ApiPaths.CARDS}"),
    ]);
    expect(
      r.records
        .filter((x) => x.kind === "Unresolved")
        .map((x) => (x as unknown as { unresolvedKind: string }).unresolvedKind)
        .sort(),
    ).toEqual(["http-endpoint", "mq-publish"]);
  });
});

describe("mergeCatalog at estate scale", () => {
  it("merges 800 components (about 50,000 records) in seconds: it grows linearly", () => {
    const recs: CatalogRecord[] = [];
    const evc = (repo: string, side: "caller" | "callee") => [{ ...ev[0]!, repo, side }];
    const C = 800;
    for (let c = 0; c < C; c++) {
      const id = `svc-${c}`;
      recs.push({
        ...base,
        kind: "Component",
        id,
        system: `sys-${c % 50}`,
        repo: id,
        type: "service",
      } as unknown as CatalogRecord);
      for (let e = 0; e < 20; e++)
        recs.push({
          ...base,
          kind: "Endpoint",
          id: `${id}.get.${e}`,
          component: id,
          endpointType: "rest",
          method: "GET",
          pathOrTopic: `/api/${id}/r${e}/{id}`,
          normalizedPath: `/api/${id}/r${e}/{}`,
          schemaRefs: [],
          evidence: evc(id, "callee"),
        } as unknown as CatalogRecord);
      for (let k = 0; k < 20; k++) {
        const t = (c + k + 1) % C;
        recs.push({
          ...base,
          confidence: "inferred",
          kind: "Unresolved",
          id: `${id}.http-call.${k}`,
          unresolvedKind: "http-call",
          raw:
            k % 2 ? `GET http://svc-${t}/api/svc-${t}/r${k}/{id}` : `GET /api/svc-${t}/r${k}/{id}`,
          owner: id,
          evidence: evc(id, "caller"),
        } as unknown as CatalogRecord);
      }
    }
    const systemsN = Array.from({ length: 50 }, (_, i) => ({
      id: `sys-${i}`,
      name: `S${i}`,
      boundary: "internal" as const,
      aliases: [],
    }));
    const t0 = performance.now();
    const m = mergeCatalog({ records: recs, repos: [], systems: systemsN });
    const ms = performance.now() - t0;
    expect(m.stats.interfaces).toBe(C * 10);
    // About a second today; the quadratic merge this replaced took about 20.
    expect(ms).toBeLessThan(10_000);
  });
});

describe("mergeCatalog: ids past C1's 120 characters", () => {
  it("shortens a long record id to a stable one and every reference follows, so nothing is invalid", () => {
    const longComp = `${"forge-ledger-approvals-service-".repeat(3)}svc`;
    const schema = `${longComp}.post-${"approval-request-".repeat(3)}request`;
    const records = [
      component(longComp, "ledger"),
      {
        ...base,
        kind: "Schema",
        id: schema,
        format: "json-schema",
        ref: "a.java#Request",
        fields: [],
      } as unknown as CatalogRecord,
      {
        ...base,
        kind: "Endpoint",
        id: `${schema}.endpoint`,
        component: longComp,
        endpointType: "rest",
        method: "POST",
        pathOrTopic: "/x",
        schemaRefs: [schema],
      } as unknown as CatalogRecord,
    ];
    const r = merged(records);
    expect(r.invalid).toEqual([]);
    for (const x of r.records) expect(x.id.length).toBeLessThanOrEqual(120);
    const s = r.records.find((x) => x.kind === "Schema")!;
    const e = r.records.find((x) => x.kind === "Endpoint") as unknown as { schemaRefs: string[] };
    expect(e.schemaRefs).toEqual([s.id]);
    // The same input gives the same ids.
    expect(merged(records).records.map((x) => x.id)).toEqual(r.records.map((x) => x.id));
  });
});
