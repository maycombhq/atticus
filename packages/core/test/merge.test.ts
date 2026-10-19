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
