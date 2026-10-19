import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { Dialect, type CatalogRecord } from "@maycombhq/core";
import { fsRepo, memoryRepo, scanRepo, type Extractor } from "@maycombhq/sdk";
import {
  apigeeExtractor,
  BUILT_IN_EXTRACTORS,
  componentExtractor,
  dialectExtractor,
  frontendExtractor,
  infraExtractor,
  migrationsExtractor,
  openapiExtractor,
  runDialectTests,
  springExtractor,
  topicsExtractor,
} from "../src/index.js";

const FORGE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/forge");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const manifest = parse(
  readFileSync(join(FORGE, "metarepo/org-pack/profiles/forge/repos.manifest.yaml"), "utf8"),
) as {
  repos: { id: string; component?: string; system?: string; type: string }[];
};
const expected = (
  parse(readFileSync(join(FORGE, "expected/scan.yaml"), "utf8")) as Record<string, unknown>[]
).map(
  (r) =>
    ({ status: "current", ...r }) as unknown as Record<string, unknown> & {
      id: string;
      kind: string;
    },
);

async function scan(repoId: string, extractors: Extractor[]) {
  const r = manifest.repos.find((x) => x.id === repoId)!;
  const s = await scanRepo({
    repo: fsRepo(r.id, join(FORGE, "repos", r.id), SHA),
    extractors,
    dialects: ["forge"],
    scannedAt: "2026-10-18T08:00:00Z",
    repoInfo: {
      ...(r.component ? { component: r.component } : {}),
      ...(r.system ? { system: r.system } : {}),
      repoType: r.type,
    },
  });
  expect(s.rejected).toEqual([]);
  expect(s.runs.filter((x) => x.status === "failed")).toEqual([]);
  return s.records;
}

/** Compare the fields an extractor is responsible for with the expected catalog. */
function like(rec: CatalogRecord | undefined, id: string, fields: string[]) {
  const want = expected.find((e) => e.id === id)!;
  expect(rec, id).toBeDefined();
  for (const f of fields)
    expect((rec as unknown as Record<string, unknown>)[f], `${id}.${f}`).toEqual(want[f]);
}

const ev = (r: CatalogRecord) => r.evidence.map((e) => `${e.path}:${e.line ?? ""}:${e.side ?? ""}`);
const loose = (recs: CatalogRecord[]) =>
  recs
    .filter((r) => r.kind === "Unresolved")
    .map((r) => {
      const u = r as unknown as { owner: string; unresolvedKind: string; raw: string };
      return `${u.owner} ${u.unresolvedKind} ${u.raw} @${ev(r).join(",")}`;
    })
    .sort();

describe("component", () => {
  it("names each code repo's component from the manifest, and skips gateway, topic and infra repos", async () => {
    const ui = await scan("forge-portal-ui", [componentExtractor]);
    expect(ui.map((r) => [r.kind, r.id, (r as unknown as { type: string }).type])).toEqual([
      ["Component", "portal-ui", "spa"],
    ]);
    expect((await scan("forge-reports-job", [componentExtractor]))[0]!.id).toBe("reports-job");
    expect(await scan("forge-gateway", [componentExtractor])).toEqual([]);
  });
});

describe("openapi", () => {
  it("reads each path and method as a definition, with auth from the security scheme", async () => {
    const recs = await scan("forge-ledger", [openapiExtractor]);
    expect(
      recs.map((r) => [
        (r as unknown as { method: string }).method,
        (r as unknown as { normalizedPath: string }).normalizedPath,
        ev(r)[0],
      ]),
    ).toEqual([
      ["GET", "/accounts/{}/balance", "api/ledger-openapi.yaml:6:definition"],
      ["POST", "/transfers", "api/ledger-openapi.yaml:14:definition"],
    ]);
    expect(recs.every((r) => (r as unknown as { auth: string }).auth === "oauth2")).toBe(true);
  });

  it("handles Swagger 2.0 basePath", async () => {
    const repo = memoryRepo("x", SHA, {
      "api/swagger.yaml": "swagger: '2.0'\nbasePath: /v1\npaths:\n  /items/{id}:\n    get: {}\n",
    });
    const s = await scanRepo({
      repo,
      extractors: [openapiExtractor],
      repoInfo: { component: "x-api" },
    });
    expect((s.records[0] as unknown as { pathOrTopic: string }).pathOrTopic).toBe("/v1/items/{id}");
  });
});

describe("apigee", () => {
  it("builds the gateway route from the proxy bundle", async () => {
    const recs = await scan("forge-gateway", [apigeeExtractor]);
    like(
      recs.find((r) => r.kind === "GatewayRoute"),
      "gw-ledger-v1",
      ["proxy", "basepath", "target", "policies", "scopes"],
    );
    expect(ev(recs.find((r) => r.kind === "GatewayRoute")!)).toEqual([
      "proxies/ledger-v1/apiproxy/proxies/default.xml:9:gateway",
      "proxies/ledger-v1/apiproxy/targets/ledger.xml:3:gateway",
    ]);
    like(
      recs.find((r) => r.kind === "AccessGrant"),
      "gw-ledger-v1.oauth-scopes",
      ["subjectKind", "resource", "scopesOrPermissions"],
    );
  });
});

describe("spring", () => {
  it("finds the controller endpoint, Feign and RestTemplate calls with placeholders resolved, Kafka and settings", async () => {
    const recs = await scan("forge-portal-bff", [springExtractor]);
    const ep = recs.find((r) => r.kind === "Endpoint")!;
    expect([
      (ep as unknown as { method: string }).method,
      (ep as unknown as { pathOrTopic: string }).pathOrTopic,
      ev(ep)[0],
    ]).toEqual([
      "GET",
      "/api/balance/{accountId}",
      "src/main/java/forge/portal/BalanceController.java:12:callee",
    ]);
    expect(loose(recs)).toEqual([
      "portal-bff event-publish payments.initiated @src/main/java/forge/portal/PaymentEvents.java:11:caller",
      "portal-bff http-call GET https://gateway.forge.example/ledger/v1/accounts/{id}/balance @src/main/java/forge/portal/LedgerClient.java:8:caller",
      "portal-bff http-call POST http://audit-svc.forge.internal/audit/events @src/main/java/forge/portal/AuditPublisher.java:10:caller",
      "portal-bff http-call POST https://gateway.forge.example/ledger/v1/transfers @src/main/java/forge/portal/LedgerClient.java:11:caller",
    ]);
    like(
      recs.find((r) => r.id === "portal-bff.ledger-read-timeout"),
      "portal-bff.ledger-read-timeout",
      ["settingKind", "key", "valueOrRef"],
    );
    like(
      recs.find((r) => r.id === "portal-bff.ledger-connect-timeout"),
      "portal-bff.ledger-connect-timeout",
      ["settingKind", "key", "valueOrRef"],
    );
  });

  it("reads SQL in JdbcTemplate calls, @KafkaListener topics and the datasource", async () => {
    expect(loose(await scan("forge-reports-job", [springExtractor]))).toEqual([
      "reports-job db-access read entry @src/main/java/forge/reports/DailyEntriesJob.java:14:caller",
      "reports-job db-connection jdbc:postgresql://ledger-db.forge.internal:5432/ledger @src/main/resources/application.yml:3:caller",
      "reports-job event-subscribe transfers.completed @src/main/java/forge/reports/DailyEntriesJob.java:17:callee",
    ]);
  });

  it("never makes a verified endpoint from a constant it can't read: it leaves a loose end", async () => {
    // Bank code style forbids literal paths, so constants are the common case. They used to
    // become endpoints such as "GET /ApiPaths.CARDS/ApiPaths.BY_ID", marked verified.
    const repo = memoryRepo("x", SHA, {
      "src/main/java/CardsController.java": `import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping(ApiPaths.CARDS)
class CardsController {
  @GetMapping(ApiPaths.BY_ID)
  Card get(String id) { return null; }
  @PostMapping("/v2" + ApiPaths.CARDS)
  Card create(Card c) { return null; }
}`,
      "src/main/java/LimitsController.java": `import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/api")
class LimitsController {
  @GetMapping(value = "/limits", produces = MediaType.APPLICATION_JSON_VALUE)
  Limit limits() { return null; }
}`,
      "src/main/java/LedgerClient.java": `import org.springframework.cloud.openfeign.FeignClient;
@FeignClient(name = "ledger", url = "\${ledger.url}")
interface LedgerClient {
  @GetMapping(LedgerPaths.BALANCE)
  Balance balance(String id);
}`,
      "src/main/java/PaymentEvents.java": `import org.springframework.kafka.annotation.KafkaListener;
class PaymentEvents {
  @KafkaListener(topics = Topics.PAYMENTS)
  void on(String m) {}
}`,
    });
    const s = await scanRepo({ repo, extractors: [springExtractor], repoInfo: { component: "x" } });
    const endpoints = s.records
      .filter((r) => r.kind === "Endpoint")
      .map(
        (r) =>
          `${(r as unknown as { method: string }).method} ${(r as unknown as { pathOrTopic: string }).pathOrTopic}`,
      );
    // Only the path written out in full is an endpoint; produces = a constant doesn't matter.
    expect(endpoints).toEqual(["GET /api/limits"]);
    expect(
      s.records
        .filter((r) => r.kind === "Unresolved")
        .map((r) => {
          const u = r as unknown as { unresolvedKind: string; raw: string; confidence: string };
          return `${u.unresolvedKind} ${u.raw} ${u.confidence}`;
        })
        .sort(),
    ).toEqual([
      "event-subscribe ${Topics.PAYMENTS} inferred",
      "http-call GET ${ledger.url}/${LedgerPaths.BALANCE} inferred",
      "http-endpoint GET ${ApiPaths.CARDS}/${ApiPaths.BY_ID} inferred",
      "http-endpoint POST ${ApiPaths.CARDS}/v2${ApiPaths.CARDS} inferred",
    ]);
  });

  it("never copies a password from a datasource URL or a secret-looking setting into the catalog", async () => {
    const urls: [string, string][] = [
      [
        "jdbc:postgresql://ledger-db.forge.internal:5432/ledger",
        "jdbc:postgresql://ledger-db.forge.internal:5432/ledger",
      ],
      [
        "jdbc:postgresql://db.internal/ledger?user=svc&password=Hunter2",
        "jdbc:postgresql://db.internal/ledger",
      ],
      ["jdbc:mysql://svc:Hunter2@db.internal:3306/ledger", "jdbc:mysql://db.internal:3306/ledger"],
      [
        "jdbc:sqlserver://db.internal:1433;databaseName=ledger;user=sa;password=Hunter2",
        "jdbc:sqlserver://db.internal:1433;databaseName=ledger",
      ],
      [
        "jdbc:oracle:thin:scott/Hunter2@db.internal:1521/LEDGER",
        "jdbc:oracle:thin:@db.internal:1521/LEDGER",
      ],
      [
        "jdbc:oracle:thin:scott/Hunter2@//db.internal:1521/LEDGER",
        "jdbc:oracle:thin:@//db.internal:1521/LEDGER",
      ],
    ];
    for (const [given, want] of urls) {
      const repo = memoryRepo("x", SHA, {
        "src/main/resources/application.yml": `spring:
  datasource:
    url: ${given}
ledger:
  client:
    pwd: Hunter2
    api-key-value: Hunter2
    read-timeout: 2s
`,
      });
      const s = await scanRepo({
        repo,
        extractors: [springExtractor],
        repoInfo: { component: "x" },
      });
      const text = JSON.stringify(s.records);
      expect(text, given).not.toContain("Hunter2");
      const conn = s.records.find(
        (r) => (r as unknown as { unresolvedKind?: string }).unresolvedKind === "db-connection",
      ) as unknown as { raw: string } | undefined;
      expect(conn?.raw, given).toBe(want);
    }
  });

  it("reads WebClient and exchange calls", async () => {
    const repo = memoryRepo("x", SHA, {
      "src/main/java/A.java": `import org.springframework.web.reactive.function.client.WebClient;
class A { RestTemplate rest; void a() {
  web.post()
     .uri("/orders/{id}/cancel")
     .retrieve();
  rest.exchange("/holds", HttpMethod.DELETE, null, Void.class);
} }`,
    });
    const s = await scanRepo({ repo, extractors: [springExtractor], repoInfo: { component: "x" } });
    expect(s.records.map((r) => (r as unknown as { raw: string }).raw).sort()).toEqual([
      "DELETE /holds",
      "POST /orders/{id}/cancel",
    ]);
  });
});

describe("frontend", () => {
  it("turns template literals into path parameters", async () => {
    expect(loose(await scan("forge-portal-ui", [frontendExtractor]))).toEqual([
      "portal-ui http-call GET /api/balance/{accountId} @src/api/balance.ts:3:caller",
    ]);
  });
});

describe("topics, migrations, infra", () => {
  it("topic configs give event endpoints and the named producers and consumers", async () => {
    const recs = await scan("forge-events", [topicsExtractor]);
    expect(recs.filter((r) => r.kind === "Endpoint").map((r) => r.id)).toEqual([
      "topic.payments-initiated",
      "topic.transfers-completed",
    ]);
    expect(loose(recs)).toHaveLength(4);
  });

  it("migrations give exactly the expected database design", async () => {
    const recs = await scan("forge-ledger", [migrationsExtractor]);
    for (const kind of ["Table", "Column", "IndexConstraint", "Migration"]) {
      const want = expected.filter((e) => e.kind === kind);
      const got = recs.filter((r) => r.kind === kind);
      expect(got.map((r) => r.id).sort(), kind).toEqual(want.map((w) => w.id as string).sort());
      for (const w of want) {
        const fields = Object.keys(w).filter(
          (k) =>
            !["kind", "id", "evidence", "status", "confidence", "readers", "writers"].includes(k),
        );
        like(
          got.find((g) => g.id === w.id),
          w.id as string,
          fields,
        );
      }
    }
  });

  it("infrastructure gives deployments, the database and alerts", async () => {
    const recs = await scan("forge-infra", [infraExtractor]);
    like(
      recs.find((r) => r.id === "ledger-api.prod"),
      "ledger-api.prod",
      ["component", "env", "platform", "replicas", "resources"],
    );
    like(
      recs.find((r) => r.id === "portal-bff.prod"),
      "portal-bff.prod",
      ["component", "env", "platform", "replicas"],
    );
    like(
      recs.find((r) => r.id === "ledger-api.alert.error-rate"),
      "ledger-api.alert.error-rate",
      ["component", "assetKind", "name"],
    );
    expect(
      (recs.find((r) => r.kind === "DataStore") as unknown as { storeType: string }).storeType,
    ).toBe("postgresql");
  });

  it("every built-in extractor runs on every Forge repo without rejected records", async () => {
    for (const r of manifest.repos) await scan(r.id, [...BUILT_IN_EXTRACTORS]);
  });
});

// ------------------------------------------------------------------ dialect engine

const ORGPACK = join(FORGE, "metarepo/org-pack/dialects");
const forge = Dialect.parse(parse(readFileSync(join(ORGPACK, "forge.yaml"), "utf8")));

function dialect(rules: object[], extra: object = {}) {
  return Dialect.parse({
    schemaVersion: 1,
    name: "house",
    version: "1.0.0",
    appliesTo: {},
    rules,
    tests: [{ name: "t", files: { a: "" } }],
    ...extra,
  });
}

describe("dialect engine", () => {
  it("runs the Forge dialect's own tests and they pass", async () => {
    expect(await runDialectTests(forge, ORGPACK)).toEqual([]);
  });

  it("produces the Forge endpoints, the vendor interface and event loose ends", async () => {
    const recs = await scan("forge-ledger", [dialectExtractor(forge)]);
    expect(recs.map((r) => `${r.kind} ${r.id}`)).toEqual([
      "Endpoint ledger-api.get-balance",
      "Endpoint ledger-api.post-transfer",
      "Interface if-e7344c9455608119",
      "Unresolved ledger-api.publish.transfers.completed",
      "Unresolved ledger-api.subscribe.payments.initiated",
    ]);
    expect(recs[0]!.evidence[0]).toMatchObject({ dialect: "forge@0.1.0", line: 8, side: "callee" });
  });

  it("does nothing in a repo without the marker file", async () => {
    expect(await scan("forge-portal-bff", [dialectExtractor(forge)])).toEqual([]);
  });

  it("supports config keys, XPath, JSONPath, regex, base classes and method calls", async () => {
    const d = dialect([
      {
        id: "timeouts",
        description: "x",
        match: { configKey: "clients.*.timeout", files: ["app.yml"] },
        emit: {
          kind: "Setting",
          id: "svc.${match.2}-timeout",
          fields: {
            component: "svc",
            settingKind: "timeout",
            key: "clients.${match.2}.timeout",
            valueOrRef: "${match.0}",
          },
        },
        confidence: "verified",
      },
      {
        id: "routes",
        description: "x",
        match: { xpath: "//route[@type='http']", files: ["routes.xml"] },
        emit: {
          kind: "Unresolved",
          id: "svc.route.${attr.id}",
          fields: { unresolvedKind: "http-call", raw: "GET ${match.0}", owner: "svc" },
        },
        confidence: "inferred",
      },
      {
        id: "jobs",
        description: "x",
        match: { jsonPath: "$.jobs[*]", files: ["jobs.yaml"] },
        emit: {
          kind: "Unresolved",
          id: "svc.job.${attr.name}",
          fields: { unresolvedKind: "batch", raw: "${attr.cron}", owner: "svc" },
        },
        confidence: "inferred",
      },
      {
        id: "queues",
        description: "x",
        match: { regex: 'QUEUE\\s*=\\s*"([^"]+)"', files: ["**/*.java"] },
        emit: {
          kind: "Unresolved",
          id: "svc.queue.${match.1 | slug}",
          fields: { unresolvedKind: "mq", raw: "${match.1}", owner: "svc" },
        },
        confidence: "inferred",
      },
      {
        id: "handlers",
        description: "x",
        match: { baseClass: "BaseHandler", files: ["**/*.java"] },
        emit: {
          kind: "Unresolved",
          id: "svc.handler.${class.name | lower}",
          fields: { unresolvedKind: "handler", raw: "${class.name}", owner: "svc" },
        },
        confidence: "inferred",
      },
      {
        id: "sends",
        description: "x",
        match: { methodCall: "bus.publish", files: ["**/*.java"] },
        emit: {
          kind: "Unresolved",
          id: "svc.pub.${attr.arg0 | slug}",
          fields: { unresolvedKind: "event-publish", raw: "${attr.arg0}", owner: "svc" },
        },
        confidence: "inferred",
      },
    ]);
    const repo = memoryRepo("x", SHA, {
      "app.yml": "clients:\n  ledger:\n    timeout: 3s\n",
      "routes.xml":
        '<routes><route type="http" id="r1">/a/b</route><route type="file" id="r2">x</route></routes>',
      "jobs.yaml": "jobs:\n  - name: nightly\n    cron: 0 2 * * *\n",
      "src/H.java":
        'class Orders extends BaseHandler { static final String QUEUE = "orders.in"; void x() { bus.publish("order.placed", o); other.publish("no"); } }',
    });
    const s = await scanRepo({ repo, extractors: [dialectExtractor(d)] });
    expect(s.rejected).toEqual([]);
    expect(s.records.map((r) => r.id).sort()).toEqual([
      "svc.handler.orders",
      "svc.job.nightly",
      "svc.ledger-timeout",
      "svc.pub.order.placed",
      "svc.queue.orders.in",
      "svc.route.r1",
    ]);
    expect(
      (s.records.find((r) => r.id === "svc.ledger-timeout") as unknown as { valueOrRef: string })
        .valueOrRef,
    ).toBe("3s");
  });

  it("inherits rules through extends, with the child's rule winning", async () => {
    const base = dialect(
      [
        {
          id: "r",
          description: "base",
          match: { regex: "A", files: ["f"] },
          emit: { kind: "Unresolved", id: "base.x", fields: { unresolvedKind: "k", raw: "a" } },
          confidence: "inferred",
        },
      ],
      { name: "base" },
    );
    const child = dialect(
      [
        {
          id: "r",
          description: "child",
          match: { regex: "A", files: ["f"] },
          emit: { kind: "Unresolved", id: "child.x", fields: { unresolvedKind: "k", raw: "a" } },
          confidence: "inferred",
        },
      ],
      { name: "child", extends: ["base"] },
    );
    const s = await scanRepo({
      repo: memoryRepo("x", SHA, { f: "A" }),
      extractors: [dialectExtractor(child, new Map([["base", base]]))],
    });
    expect(s.records.map((r) => r.id)).toEqual(["child.x"]);
    expect(() => dialectExtractor(child)).toThrow(/extends base, which isn't loaded/);
  });

  it("reports failing dialect tests so the dialect won't load", async () => {
    const bad = Dialect.parse({
      ...forge,
      tests: [
        {
          name: "wrong",
          fixture: "../../../repos/forge-ledger",
          expect: [{ kind: "Endpoint", id: "ledger-api.get-balance", method: "POST" }],
          absent: ["ledger-api.post-transfer"],
        },
      ],
    });
    const f = await runDialectTests(bad, ORGPACK);
    expect(f.map((x) => x.message)).toEqual([
      'ledger-api.get-balance.method: expected "POST", got "GET"',
      "ledger-api.post-transfer should not be produced",
    ]);
  });
});
