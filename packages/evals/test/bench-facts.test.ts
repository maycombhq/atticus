import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFacts, type CatalogRecord, type Fact } from "@maycombhq/core";
import { benchFacts, parseReference, scoreFacts, scoreRepo } from "../src/bench.js";

/**
 * Scoring an assistant's facts file against the bench (ADR 0124 §6), with the same matcher and
 * the same found, missed and wrong as a reader's scan, plus the two kinds the facts add: fields
 * (request and response fields of entries and calls, columns of tables) and config (keys naming
 * another system, a timeout or a flag).
 */

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

/** An invented repo: an owners API with one table, one outbound call and two config keys. */
const reference = parseReference(`
repo: invented-owners
commit: ${COMMIT}
covers: [serves, calls, stores, deploys, fields, config]
serves:
  - { type: rest, method: GET, path: "/api/owners/{id}", at: "src/Owners.java:10" }
  - { type: rest, method: POST, path: /api/owners, at: "src/Owners.java:20" }
calls:
  - { method: POST, path: /audit, at: "src/AuditClient.java:8" }
stores:
  - { table: owners, at: "db/schema.sql:1" }
deploys:
  - { platform: kubernetes, at: "k8s/app.yaml:1" }
fields:
  - { entry: "POST /api/owners", side: request, name: firstName, type: string, at: "api.yml:30" }
  - { entry: "POST /api/owners", side: request, name: lastName, type: string, at: "api.yml:33" }
  - { entry: "rest GET /api/owners/{ownerId}", side: response, name: id, type: integer, at: "api.yml:40" }
  - { call: "POST /audit", side: request, name: action, at: "src/AuditClient.java:12" }
  - { table: owners, name: first_name, type: varchar(30), at: "db/schema.sql:3" }
  - { table: owners, name: last_name, type: varchar(30), at: "db/schema.sql:4" }
config:
  - { key: audit.base-url, value: "http://audit:8080", at: "src/main/resources/application.properties:3" }
  - { key: audit.timeout-ms, value: "2000", at: "src/main/resources/application.properties:4" }
  - { key: "ConnectionStrings:OwnersDb", at: "appsettings.json:3" }
ignore:
  config: ["logging.*"]
`);

const fact = (f: Record<string, unknown>) =>
  ({
    repo: "invented-owners",
    commit: COMMIT.slice(0, 12),
    verified: "line",
    by: "assistant",
    conf: "declared",
    ...f,
  }) as unknown as Fact;
const cite = (file: string, line: number, value: string) => ({ file, line, value });

/** What an assistant wrote: mostly right, one route at the wrong path, one invented field. */
const facts: Fact[] = [
  fact({
    kind: "entry",
    id: "e-get",
    entryType: "rest",
    method: "GET",
    path: "/api/owners/{ownerId}",
    cite: cite("src/Owners.java", 10, "/{ownerId}"),
  }),
  fact({
    kind: "entry",
    id: "e-post",
    entryType: "rest",
    method: "POST",
    path: "/owners",
    cite: cite("src/Owners.java", 20, "/owners"),
  }),
  // A screen is not something the repo serves to other code; the bench leaves it out.
  fact({
    kind: "entry",
    id: "e-screen",
    entryType: "screen",
    path: "/owners/new",
    cite: cite("web/routes.ts", 4, "/owners/new"),
  }),
  fact({
    kind: "field",
    id: "f-screen",
    owner: "e-screen",
    side: "screen",
    name: "firstName",
    cite: cite("web/form.html", 9, "firstName"),
  }),
  fact({
    kind: "call",
    id: "c-audit",
    callType: "rest",
    method: "POST",
    path: "/audit",
    base: "audit.base-url",
    from: "e-post",
    cite: cite("src/AuditClient.java", 8, "/audit"),
  }),
  fact({
    kind: "store",
    id: "s-owners",
    store: "ownersdb",
    name: "OWNERS",
    op: "write",
    cite: cite("db/schema.sql", 1, "owners"),
  }),
  fact({
    kind: "deploy",
    id: "d-k8s",
    platform: "kubernetes",
    cite: cite("k8s/app.yaml", 1, "Deployment"),
  }),
  fact({
    kind: "field",
    id: "f-id",
    owner: "e-get",
    side: "response",
    name: "id",
    type: "integer",
    cite: cite("api.yml", 40, "id"),
  }),
  // Found under the wrong path, so missed once and wrong once, like the route it belongs to.
  fact({
    kind: "field",
    id: "f-first",
    owner: "e-post",
    side: "request",
    name: "firstName",
    cite: cite("api.yml", 30, "firstName"),
  }),
  fact({
    kind: "field",
    id: "f-action",
    owner: "c-audit",
    side: "request",
    name: "action",
    cite: cite("src/AuditClient.java", 12, "action"),
  }),
  fact({
    kind: "field",
    id: "f-col-first",
    owner: "s-owners",
    side: "column",
    name: "FIRST_NAME",
    cite: cite("db/schema.sql", 3, "first_name"),
  }),
  // Invented: no such column.
  fact({
    kind: "field",
    id: "f-col-nick",
    owner: "s-owners",
    side: "column",
    name: "nickname",
    cite: cite("db/schema.sql", 5, "nickname"),
  }),
  fact({
    kind: "config",
    id: "k-base",
    key: "audit.base-url",
    value: "http://audit:8080",
    target: "audit",
    cite: cite("src/main/resources/application.properties", 3, "audit.base-url"),
  }),
  fact({
    kind: "config",
    id: "k-conn",
    key: "ConnectionStrings__OwnersDb",
    source: "env:ConnectionStrings__OwnersDb",
    cite: cite("k8s/app.yaml", 20, "ConnectionStrings__OwnersDb"),
  }),
  // True but out of the config kind's scope: neither found nor wrong.
  fact({
    kind: "config",
    id: "k-log",
    key: "logging.level.root",
    value: "INFO",
    cite: cite("src/main/resources/application.properties", 9, "logging.level.root"),
  }),
  fact({
    kind: "flow",
    id: "fl-add",
    name: "add owner",
    entry: "e-screen",
    cite: cite("web/routes.ts", 4, "/owners/new"),
    steps: [{ kind: "call-out", what: "posts", ref: "c-audit", cite: cite("a.ts", 1, "x") }],
  }),
];

describe("bench: fields and config in a reference", () => {
  it("reads fields of entries, calls and tables, and config keys", () => {
    expect(reference.covers).toContain("fields");
    expect(reference.fields).toHaveLength(6);
    expect(reference.config).toHaveLength(3);
  });

  it("refuses a field with no owner or two, and an entry field with no side", () => {
    const base = `repo: x\ncommit: ${COMMIT}\ncovers: [fields]\nfields:\n`;
    expect(() => parseReference(`${base}  - { name: a, at: "a.yml:1" }\n`)).toThrow(/one of/);
    expect(() =>
      parseReference(
        `${base}  - { entry: "GET /a", table: t, side: request, name: a, at: "a.yml:1" }\n`,
      ),
    ).toThrow(/one of/);
    expect(() =>
      parseReference(`${base}  - { entry: "GET /a", name: a, at: "a.yml:1" }\n`),
    ).toThrow(/side/);
  });

  it("scores the readers' columns and settings as fields and config", () => {
    const rec = (r: Record<string, unknown>) =>
      ({
        schemaVersion: 2,
        status: "current",
        confidence: "verified",
        evidence: [],
        ...r,
      }) as unknown as CatalogRecord;
    const records = [
      rec({ kind: "Table", id: "db.owners", dataStore: "db", name: "owners" }),
      rec({
        kind: "Column",
        id: "db.owners.first_name",
        table: "db.owners",
        name: "first_name",
        type: "varchar",
      }),
      rec({
        kind: "Setting",
        id: "a.audit-timeout",
        component: "a",
        settingKind: "timeout",
        key: "audit.timeout-ms",
        valueOrRef: "2000",
      }),
      // A schedule is an entry the readers record as a setting; it isn't a config key.
      rec({
        kind: "Setting",
        id: "a.schedule.nightly",
        component: "a",
        settingKind: "schedule",
        key: "schedule.nightly",
        valueOrRef: "0 0 * * *",
      }),
    ];
    const f = benchFacts(records);
    expect(f.fields).toEqual(["column owners | firstname"]);
    expect(f.config).toEqual(["audit.timeout-ms"]);
    const s = scoreRepo(reference, records);
    expect(s.kinds.fields).toMatchObject({ found: 1, wrong: [] });
    expect(s.kinds.config).toMatchObject({ found: 1, wrong: [] });
  });
});

describe("bench: an assistant's facts file, projected and scored", () => {
  it("scores every covered kind with the same found, missed and wrong as a scan", () => {
    const s = scoreFacts(reference, facts);
    expect(s.kinds.serves).toEqual({
      found: 1,
      missed: ["rest POST /api/owners"],
      wrong: ["rest POST /owners"],
      precision: 0.5,
      recall: 0.5,
    });
    expect(s.kinds.calls).toMatchObject({ found: 1, missed: [], wrong: [] });
    expect(s.kinds.stores).toMatchObject({ found: 1, missed: [], wrong: [] });
    expect(s.kinds.deploys).toMatchObject({ found: 1, missed: [], wrong: [] });
    expect(s.kinds.fields).toEqual({
      found: 3,
      missed: [
        "column owners | lastname",
        "entry rest POST /api/owners | request firstname",
        "entry rest POST /api/owners | request lastname",
      ],
      wrong: ["column owners | nickname", "entry rest POST /owners | request firstname"],
      precision: 3 / 5,
      recall: 3 / 6,
    });
    expect(s.kinds.config).toEqual({
      found: 2,
      missed: ["audit.timeout-ms"],
      wrong: [],
      precision: 1,
      recall: 2 / 3,
    });
    // The four kinds the readers' baseline is measured on, kept apart so the numbers compare.
    expect(s.base).toEqual({ found: 4, missed: 1, wrong: 1, precision: 0.8, recall: 0.8 });
    expect(s.total).toMatchObject({ found: 9, missed: 5, wrong: 3 });
  });

  it("says what it read: facts per kind, how many verified, and projection issues", () => {
    const s = scoreFacts(reference, facts);
    expect(s.facts).toEqual({
      total: 16,
      verified: 16,
      byKind: {
        entry: 3,
        call: 1,
        store: 1,
        field: 6,
        deploy: 1,
        config: 3,
        framework: 0,
        flow: 1,
      },
      left: { screens: 1, screenFields: 1, batchJobs: 0, keyPatterns: 0, frameworks: 0, flows: 1 },
    });
    expect(s.issues).toEqual([]);
  });

  it("refuses facts written for another commit", () => {
    const other = [fact({ ...facts[0], commit: "fedcba9" })];
    expect(() => scoreFacts(reference, other)).toThrow(/commit/);
  });

  it("scores a facts file read from JSONL the same as the array", () => {
    const text = facts.map((f) => JSON.stringify(f)).join("\n");
    const parsed = parseFacts(text);
    expect(parsed.ok ? [] : parsed.issues).toEqual([]);
    if (parsed.ok)
      expect(scoreFacts(reference, parsed.facts)).toEqual(scoreFacts(reference, facts));
  });
});

describe("bench: the references in bench/references", () => {
  const dir = join(__dirname, "..", "..", "..", "bench", "references");

  it("all parse, and five cover fields and config", () => {
    const withFields: string[] = [];
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith(".yaml"))
      .sort()) {
      const ref = parseReference(readFileSync(join(dir, file), "utf8"));
      expect(`${ref.repo}.yaml`).toBe(file);
      if (ref.covers.includes("fields") && ref.covers.includes("config")) {
        expect(ref.fields!.length, file).toBeGreaterThan(0);
        expect(ref.config!.length, file).toBeGreaterThan(0);
        withFields.push(ref.repo);
      }
    }
    expect(withFields).toEqual([
      "fastapi-template",
      "podinfo",
      "spring-petclinic-rest",
      "todo-csharp-sql",
      "todo-nodejs-mongo",
    ]);
  });
});

describe("bench: the golden facts file against a real bench reference", () => {
  const here = join(__dirname, "fixtures", "bench-facts");

  it("matches the golden score", () => {
    const ref = parseReference(
      readFileSync(
        join(__dirname, "..", "..", "..", "bench", "references", "todo-csharp-sql.yaml"),
        "utf8",
      ),
    );
    const parsed = parseFacts(readFileSync(join(here, "todo-csharp-sql.facts.jsonl"), "utf8"));
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues, null, 2));
    const s = scoreFacts(ref, parsed.facts);
    // Counted by hand from the fixture before the golden file was written.
    expect(s.kinds.serves).toMatchObject({ found: 3, wrong: ["rest POST /{}/items"] });
    expect(s.kinds.serves!.missed).toHaveLength(8);
    expect(s.kinds.calls).toMatchObject({ found: 2, wrong: [], recall: 0.2 });
    expect(s.kinds.stores).toMatchObject({ found: 1, missed: ["lists"], wrong: ["todolists"] });
    expect(s.kinds.deploys).toMatchObject({ found: 1, missed: [], wrong: [] });
    expect(s.kinds.fields).toMatchObject({
      found: 5,
      wrong: [
        "column items | priority",
        "entry rest POST /lists | request owner",
        "entry rest POST /{}/items | request state",
      ],
    });
    expect(s.kinds.fields!.missed).toHaveLength(94);
    expect(s.kinds.config).toEqual({
      found: 2,
      missed: [
        "azure-sql-connection-string",
        "azure_sql_connection_string_key",
        "vite_applicationinsights_connection_string",
      ],
      wrong: ["sqlretrycount"],
      precision: 2 / 3,
      recall: 2 / 5,
    });
    expect(s.base).toMatchObject({ found: 7, missed: 17, wrong: 2 });
    expect(s.total).toMatchObject({ found: 14, missed: 114, wrong: 6 });
    expect(s.facts).toMatchObject({
      total: 25,
      verified: 21,
      left: { screens: 1, screenFields: 1, flows: 1 },
    });
    expect(s.issues).toEqual([]);
    const file = join(here, "todo-csharp-sql.score.json");
    if (process.env.UPDATE_GOLDEN) writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
    expect(JSON.parse(JSON.stringify(s))).toEqual(JSON.parse(readFileSync(file, "utf8")));
  });
});

describe("bench: what the measured run's facts showed about the matcher (A4)", () => {
  const ref = parseReference(`
repo: invented-owners
commit: ${COMMIT}
covers: [serves, calls]
serves:
  - { type: rest, method: OPTIONS, path: /check, at: "src/Hooks.cs:16" }
calls:
  - { type: grpc, path: forge.Basket/GetBasket, at: "src/BasketClient.cs:9" }
  - { method: GET, path: "/api/items/type/all/brand/{brandId}", at: "src/CatalogClient.cs:20" }
  - { type: soap, path: ICatalogService/GetItems, at: "src/CatalogProxy.cs:7" }
  - { type: soap, path: ICatalogService/GetBrands, at: "src/CatalogProxy.cs:9" }
`);
  const got = [
    // a webhook receiver is an HTTP route: the same fact as a rest entry
    fact({
      kind: "entry",
      id: "e-check",
      entryType: "webhook",
      method: "OPTIONS",
      path: "/check",
      cite: cite("src/Hooks.cs", 16, "/check"),
    }),
    // a gRPC call written with a leading slash, as clients send it
    fact({
      kind: "call",
      id: "c-basket",
      callType: "grpc",
      path: "/forge.Basket/GetBasket",
      to: "basket",
      cite: cite("src/BasketClient.cs", 9, "GetBasket"),
    }),
    // an optional route parameter, as ASP.NET writes it
    fact({
      kind: "call",
      id: "c-brand",
      callType: "rest",
      method: "GET",
      path: "/api/items/type/all/brand/{brandId?}",
      to: "catalog",
      cite: cite("src/CatalogClient.cs", 20, "/api/items/type/all/brand/{brandId?}"),
    }),
  ];
  // a SOAP call, with a target and without one
  got.push(
    fact({
      kind: "call",
      id: "c-items",
      callType: "soap",
      path: "ICatalogService/GetItems",
      to: "catalog-wcf",
      cite: cite("src/CatalogProxy.cs", 7, "GetItems"),
    }),
    fact({
      kind: "call",
      id: "c-brands",
      callType: "soap",
      path: "ICatalogService/GetBrands",
      cite: cite("src/CatalogProxy.cs", 9, "GetBrands"),
    }),
  );
  it("matches a webhook entry, a slashed gRPC call, an optional parameter and SOAP calls", () => {
    const s = scoreFacts(ref, got);
    expect(s.kinds.serves).toMatchObject({ found: 1, missed: [], wrong: [] });
    expect(s.kinds.calls).toMatchObject({ found: 4, missed: [], wrong: [] });
  });
});

describe("bench: names that mean the same platform or operation (held-out run)", () => {
  const ref = parseReference(`
repo: invented-owners
commit: ${COMMIT}
covers: [serves, deploys]
serves:
  - { type: graphql, path: article, at: "src/schema.graphqls:3" }
  - { type: graphql, path: createUser, at: "src/schema.graphqls:9" }
deploys:
  - { platform: azure-app-service, at: "infra/main.bicep:4" }
`);
  const got = [
    fact({
      kind: "entry",
      id: "q-article",
      entryType: "graphql",
      path: "Query.article",
      cite: cite("src/schema.graphqls", 3, "article"),
    }),
    fact({
      kind: "entry",
      id: "m-create-user",
      entryType: "graphql",
      path: "Mutation.createUser",
      cite: cite("src/schema.graphqls", 9, "createUser"),
    }),
    fact({
      kind: "deploy",
      id: "d-web",
      platform: "app-service",
      cloud: "azure",
      resourceName: "web",
      cite: cite("infra/main.bicep", 4, "web"),
    }),
  ];
  got.push(
    // no reference lists key-value stores' keys (references list tables): left out and counted
    fact({
      kind: "store",
      id: "cache-basket",
      store: "redis",
      storeType: "redis",
      name: "basket:{id}",
      op: "write",
      tableKind: "key-pattern",
      cite: cite("src/Basket.cs", 20, "basket:"),
    }),
  );
  got.push(
    // no reference lists scheduled jobs: left out and counted, like screens
    fact({
      kind: "entry",
      id: "job-backup",
      entryType: "batch-job",
      path: "0 0 0 * * *",
      cite: cite("src/Backup.java", 12, "0 0 0 * * *"),
    }),
  );
  it("compares Query.field with field, and a platform with or without its cloud's prefix", () => {
    const s = scoreFacts(ref, got);
    expect(s.facts.left).toMatchObject({ batchJobs: 1, keyPatterns: 1 });
    expect(s.kinds.serves).toMatchObject({ found: 2, missed: [], wrong: [] });
    expect(s.kinds.deploys).toMatchObject({ found: 1, missed: [], wrong: [] });
  });
});
