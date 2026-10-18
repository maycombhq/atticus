import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { mergeCatalog, type CatalogRecord } from "@maycombhq/core";
import { fsRepo, memoryRepo, scanRepo, type Extractor } from "@maycombhq/sdk";
import { infraExtractor, migrationsExtractor, topicsExtractor } from "../src/index.js";
import {
  asyncapiExtractor,
  DATA_EXTRACTORS,
  mainframeExtractor,
  observabilityAssetId,
  observabilityExtractor,
  ormExtractor,
} from "../src/data/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures/data");
const FORGE = join(HERE, "../../../fixtures/forge");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const AT = "2026-10-18T08:00:00Z";

type Rec = Record<string, unknown> & { kind: string; id: string; evidence: Rec[] };

async function scanDir(
  dir: string,
  extractors: Extractor[],
  repoInfo: { component?: string; system?: string; repoType?: string } = {},
  repoName = dir.split("/").pop()!,
) {
  const s = await scanRepo({
    repo: fsRepo(repoName, dir, SHA),
    extractors,
    scannedAt: AT,
    repoInfo,
  });
  expect(s.rejected).toEqual([]);
  expect(s.runs.filter((r) => r.status === "failed")).toEqual([]);
  return s;
}

/** Evidence as an extractor writes it: the runner's stamps (repo, commit, time, extractor) removed. */
function bare(r: CatalogRecord): Rec {
  const x = r as unknown as Rec;
  return {
    ...x,
    evidence: x.evidence.map((e) => {
      const { repo: _r, commit: _c, scannedAt: _s, extractor: _x, ...rest } = e;
      return rest;
    }),
  };
}

function expected(name: string): Rec[] {
  return (parse(readFileSync(join(FIX, `${name}.expected.yaml`), "utf8")) as Rec[]).map((r) => ({
    schemaVersion: 2,
    status: "current",
    ...r,
  }));
}

/**
 * Golden comparison, field for field. Unresolved ids are hashes of raw, path and line, so they
 * are checked by shape and the records compared without them.
 */
function golden(records: CatalogRecord[], want: Rec[]) {
  const got = records.map(bare);
  const keyed = (l: Rec[]) =>
    l
      .filter((r) => r.kind !== "Unresolved")
      .sort((a, b) => `${a.kind}/${a.id}`.localeCompare(`${b.kind}/${b.id}`));
  const g = keyed(got);
  const w = keyed(want);
  expect(g.map((r) => `${r.kind}/${r.id}`)).toEqual(w.map((r) => `${r.kind}/${r.id}`));
  for (let i = 0; i < w.length; i++) expect(g[i], `${w[i]!.kind}/${w[i]!.id}`).toEqual(w[i]);

  const loose = got.filter((r) => r.kind === "Unresolved");
  for (const u of loose)
    expect(u.id).toMatch(
      new RegExp(`^${String(u.owner)}\\.${String(u.unresolvedKind)}\\.[0-9a-f]{10}$`),
    );
  const canon = (l: Rec[]) =>
    l.map(({ id: _id, ...rest }) => JSON.stringify(sortKeys(rest))).sort();
  expect(canon(loose)).toEqual(canon(want.filter((r) => r.kind === "Unresolved")));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  return v;
}

// ------------------------------------------------------------------ ORM

describe("orm", () => {
  it("reads JPA entities: tables, columns, keys, inherited fields and Spring's snake_case names", async () => {
    const s = await scanDir(join(FIX, "jpa-ledger"), [ormExtractor], {
      component: "ledger-api",
      system: "ledger",
    });
    golden(s.records, expected("jpa-ledger"));
  });

  it("reads EF Core: DbSet entities, [Table], [Column], [Key], fluent ToTable, conventions", async () => {
    const s = await scanDir(join(FIX, "efcore-orders"), [ormExtractor], {
      component: "orders-api",
      system: "orders",
    });
    golden(s.records, expected("efcore-orders"));
  });

  it("reads SQLAlchemy declarative models: Column, mapped_column and Mapped annotations", async () => {
    const s = await scanDir(join(FIX, "sqlalchemy-reports"), [ormExtractor], {
      component: "reports-api",
      system: "reports",
    });
    golden(s.records, expected("sqlalchemy-reports"));
  });

  it("reads Prisma models: @@map, @map, @id, @@id, @unique, @@index and @relation", async () => {
    const s = await scanDir(join(FIX, "prisma-portal"), [ormExtractor], {
      component: "portal-api",
      system: "portal",
    });
    golden(s.records, expected("prisma-portal"));
  });

  it("gives an ORM table and a migration table for the same physical table the same ids, and merge keeps one verified record", async () => {
    const info = { component: "ledger-api", system: "ledger" };
    const orm = await scanDir(join(FIX, "jpa-ledger"), [ormExtractor], info);
    const mig = await scanDir(join(FIX, "jpa-ledger"), [migrationsExtractor], info);
    const ids = (recs: CatalogRecord[]) =>
      recs
        .filter((r) => ["DataStore", "Table", "Column", "IndexConstraint"].includes(r.kind))
        .filter((r) => r.id === "ledger-db" || r.id.startsWith("ledger-db.account"))
        .map((r) => `${r.kind}/${r.id}`)
        .sort();
    expect(ids(orm.records)).toEqual(ids(mig.records));

    // Both extractors in one scan, as the estate scan runs them: records come sorted by kind,
    // id, then extractor, so the migration's values come first and win.
    const both = await scanDir(join(FIX, "jpa-ledger"), [ormExtractor, migrationsExtractor], info);
    const merged = mergeCatalog({
      records: both.records,
      repos: [{ id: "jpa-ledger", component: "ledger-api", system: "ledger", type: "spring-boot" }],
      systems: [],
    });
    expect(merged.invalid).toEqual([]);
    const get = (id: string) => merged.records.find((r) => r.id === id) as unknown as Rec;
    expect(merged.records.filter((r) => r.id === "ledger-db.account")).toHaveLength(1);
    expect(get("ledger-db.account").confidence).toBe("verified");
    expect(
      get("ledger-db.account")
        .evidence.map((e) => e.source)
        .sort(),
    ).toEqual(["code", "migration"]);
    expect(get("ledger-db.account.id").type).toBe("bigint");
    expect(get("ledger-db").storeType).toBe("postgresql");
    expect(get("ledger-db").entitiesHeld).toEqual(["account", "entry", "transfer_request"]);
  });

  it("keeps JPA names as written under the standard physical naming strategy", async () => {
    const repo = memoryRepo("x", SHA, {
      "src/main/resources/application.properties":
        "spring.jpa.hibernate.naming.physical-strategy=org.hibernate.boot.model.naming.PhysicalNamingStrategyStandardImpl\n",
      "src/main/java/x/PaymentOrder.java":
        "@Entity\npublic class PaymentOrder {\n  @Id\n  private Long orderId;\n}\n",
    });
    const s = await scanRepo({ repo, extractors: [ormExtractor], repoInfo: { component: "x" } });
    expect(s.rejected).toEqual([]);
    expect(s.records.map((r) => `${r.kind} ${r.id} ${(r as unknown as Rec).name ?? ""}`)).toEqual([
      "Column x-db.paymentorder.orderid orderId",
      "DataStore x-db ",
      "IndexConstraint x-db.paymentorder.pk ",
      "Table x-db.paymentorder PaymentOrder",
    ]);
  });

  it("gives nothing for plain classes, test code or a repo without ORM mappings", async () => {
    const repo = memoryRepo("x", SHA, {
      "src/main/java/x/Plain.java": "public class Plain {\n  private Long id;\n}\n",
      "src/test/java/x/T.java": "@Entity\npublic class T {\n  @Id\n  private Long id;\n}\n",
      "app/plain.py": "class Plain:\n    id = 1\n",
      "Data/Ctx.cs": "public class Ctx { public int Id { get; set; } }\n",
    });
    const s = await scanRepo({ repo, extractors: [ormExtractor], repoInfo: { component: "x" } });
    expect(s.records).toEqual([]);
    expect(s.rejected).toEqual([]);
  });
});

// ------------------------------------------------------------------ observability

describe("observability", () => {
  it("reads Prometheus rules, Grafana and Datadog dashboards and monitors, the OTel collector, log configs and runbooks", async () => {
    const s = await scanDir(
      join(FIX, "observability"),
      [observabilityExtractor],
      {},
      "forge-monitoring",
    );
    golden(s.records, expected("observability"));
  });

  it("names alerts the way the infra extractor does", async () => {
    const infra = await scanDir(join(FORGE, "repos/forge-infra"), [infraExtractor], {
      repoType: "infra",
    });
    const alert = infra.records.find((r) => r.kind === "ObservabilityAsset")!;
    expect(alert.id).toBe("ledger-api.alert.error-rate");
    expect(observabilityAssetId("ledger-api", "alert", "Ledger API error rate")).toBe(alert.id);
    expect(observabilityAssetId("ledger-api", "alert", "LedgerApiErrorRate")).toBe(alert.id);
    expect(observabilityAssetId("ledger-api", "dashboard", "Ledger API overview")).toBe(
      "ledger-api.dashboard.ledger-api-overview",
    );
  });

  it("ignores YAML and JSON that are not observability assets", async () => {
    const repo = memoryRepo("x", SHA, {
      "monitoring/values.yaml": "replicas: 2\n",
      "monitoring/grafana/notes.json": '{"title": "Not a dashboard"}',
      "alerts/ledger-api.yaml":
        "alerts:\n  - name: Ledger API error rate\n    component: ledger-api\n",
    });
    const s = await scanRepo({ repo, extractors: [observabilityExtractor] });
    expect(s.records).toEqual([]);
  });
});

// ------------------------------------------------------------------ AsyncAPI

describe("asyncapi", () => {
  it("reads AsyncAPI 2 channels with the client-view direction turned round", async () => {
    const s = await scanDir(join(FIX, "asyncapi-v2"), [asyncapiExtractor], {
      component: "payments-api",
    });
    golden(s.records, expected("asyncapi-v2"));
  });

  it("reads AsyncAPI 3 send and receive operations on channel addresses, and JSON documents", async () => {
    const s = await scanDir(join(FIX, "asyncapi-v3"), [asyncapiExtractor], {
      component: "ledger-api",
    });
    golden(s.records, expected("asyncapi-v3"));
  });

  it("gives topics the topics extractor's ids, and merge turns the operations into event interfaces", async () => {
    const events = await scanDir(join(FORGE, "repos/forge-events"), [topicsExtractor], {
      repoType: "event-config",
    });
    const v2 = await scanDir(join(FIX, "asyncapi-v2"), [asyncapiExtractor], {
      component: "payments-api",
    });
    const v3 = await scanDir(join(FIX, "asyncapi-v3"), [asyncapiExtractor], {
      component: "ledger-api",
    });
    const topicIds = (recs: CatalogRecord[]) =>
      recs.filter((r) => r.kind === "Endpoint").map((r) => r.id);
    expect(topicIds(v2.records)).toEqual(expect.arrayContaining(topicIds(events.records)));

    const merged = mergeCatalog({
      records: [...v2.records, ...v3.records],
      repos: [
        { id: "asyncapi-v2", component: "payments-api", type: "service" },
        { id: "asyncapi-v3", component: "ledger-api", type: "service" },
      ],
      systems: [],
    });
    expect(merged.invalid).toEqual([]);
    const edges = merged.records
      .filter((r) => r.kind === "Interface")
      .map((r) => {
        const i = r as unknown as Rec;
        return `${String(i.from)} -> ${String(i.to)} ${String(i.normalizedPath)} ${String(i.via)} ${i.confidence as string}`;
      })
      .sort();
    expect(edges).toEqual([
      "ledger-api -> payments-api transfers.completed event-bus inferred",
      "payments-api -> ledger-api payments.initiated event-bus inferred",
    ]);
  });

  it("ignores files that are not AsyncAPI documents", async () => {
    const repo = memoryRepo("x", SHA, {
      "asyncapi/readme.yaml": "title: notes\n",
      "asyncapi/broken.json": "{ not json",
    });
    const s = await scanRepo({
      repo,
      extractors: [asyncapiExtractor],
      repoInfo: { component: "x" },
    });
    expect(s.records).toEqual([]);
  });
});

// ------------------------------------------------------------------ mainframe

describe("mainframe", () => {
  it("reads JCL steps and datasets, COBOL copybooks and CICS definitions", async () => {
    const s = await scanDir(join(FIX, "mainframe-pay"), [mainframeExtractor], {
      component: "pay-batch",
    });
    golden(s.records, expected("mainframe-pay"));
    expect(s.warnings.map((w) => `${w.path}: ${w.message}`)).toEqual([
      "jcl/PAYDAILY.jcl: step STEP030 runs procedure PAYRPT, which is not expanded",
    ]);
  });

  it("gives nothing for files without job cards, levels or definitions", async () => {
    const repo = memoryRepo("x", SHA, {
      "jcl/NOTES": "Run the job after midnight.\n",
      "copybooks/EMPTY.cpy": "      * nothing here\n",
      "csd/LIST.csd": "* no definitions\n",
    });
    const s = await scanRepo({
      repo,
      extractors: [mainframeExtractor],
      repoInfo: { component: "x" },
    });
    expect(s.records).toEqual([]);
  });
});

describe("DATA_EXTRACTORS", () => {
  it("lists every extractor in this module once, with stable ids", () => {
    expect(DATA_EXTRACTORS.map((x) => `${x.id}@${x.version}`)).toEqual([
      "orm@1.0.0",
      "observability@1.0.0",
      "asyncapi@1.0.0",
      "mainframe@1.0.0",
    ]);
  });

  it("run on every Forge repo without rejected records or failures", async () => {
    const manifest = parse(
      readFileSync(join(FORGE, "metarepo/org-pack/profiles/forge/repos.manifest.yaml"), "utf8"),
    ) as { repos: { id: string; component?: string; system?: string; type: string }[] };
    for (const r of manifest.repos)
      await scanDir(
        join(FORGE, "repos", r.id),
        [...DATA_EXTRACTORS],
        {
          ...(r.component ? { component: r.component } : {}),
          ...(r.system ? { system: r.system } : {}),
          repoType: r.type,
        },
        r.id,
      );
  });
});
