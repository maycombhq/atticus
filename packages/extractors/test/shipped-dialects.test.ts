import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { Dialect } from "@maycombhq/core";
import { fsRepo, scanRepo } from "@maycombhq/sdk";
import { dialectExtractor, runDialectTests } from "../src/index.js";
import { listShippedDialects, loadShippedDialects } from "../src/data/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "../dialects/fixtures");
const SHA = "0123456789abcdef0123456789abcdef01234567";

type Rec = Record<string, unknown> & { kind: string; id: string; evidence: Rec[] };

const load = (path: string) => Dialect.parse(parse(readFileSync(path, "utf8")));

async function scanWith(name: string, repoDir: string) {
  const path = listShippedDialects().find((p) => basename(p) === `${name}.yaml`)!;
  const dialect = load(path);
  const s = await scanRepo({
    repo: fsRepo(basename(repoDir), repoDir, SHA),
    extractors: [dialectExtractor(dialect)],
    dialects: [name],
    scannedAt: "2026-10-18T08:00:00Z",
  });
  expect(s.rejected).toEqual([]);
  expect(s.runs.filter((r) => r.status === "failed")).toEqual([]);
  return s;
}

/** The fields a golden test compares, plus where the record came from. */
const view = (r: unknown, fields: string[]) => {
  const x = r as Rec;
  const e = x.evidence[0]!;
  return [
    `${x.kind} ${x.id}`,
    ...fields.map((f) => `${f}=${JSON.stringify(x[f])}`),
    `@${String(e.path)}:${String(e.line)}:${String(e.source)}:${String(e.side)}:${String(e.dialect)}`,
  ].join(" ");
};

describe("listShippedDialects", () => {
  it("lists the shipped dialect files as absolute paths, in name order", () => {
    const paths = listShippedDialects();
    expect(paths.map((p) => basename(p))).toEqual([
      "argocd.yaml",
      "harness.yaml",
      "jaxrs.yaml",
      "micronaut.yaml",
      "quarkus-reactive-messaging.yaml",
      "tekton.yaml",
    ]);
    for (const p of paths) {
      expect(isAbsolute(p)).toBe(true);
      expect(existsSync(p)).toBe(true);
    }
  });

  it("loads them as valid C2 dialects whose own tests pass", async () => {
    const dialects = await loadShippedDialects();
    expect(dialects.map((d) => `${d.name}@${d.version}`)).toEqual([
      "argocd@1.0.0",
      "harness@1.0.0",
      "jaxrs@1.0.0",
      "micronaut@1.0.0",
      "quarkus-reactive-messaging@1.0.0",
      "tekton@1.0.0",
    ]);
    for (const [i, d] of dialects.entries())
      expect(await runDialectTests(d, dirname(listShippedDialects()[i]!)), d.name).toEqual([]);
  });
});

describe("jaxrs dialect", () => {
  it("finds every resource method and MicroProfile client call, and nothing else", async () => {
    const s = await scanWith("jaxrs", join(FIX, "jaxrs/accounts-service"));
    const R = "src/main/java/forge/accounts/AccountResource.java";
    const L = "src/main/java/forge/accounts/LedgerClient.java";
    const A = "src/main/java/forge/accounts/AuditClient.java";
    const ep = ["component", "endpointType", "method", "pathOrTopic"];
    const ue = ["unresolvedKind", "raw", "owner"];
    expect(s.records.map((r) => view(r, r.kind === "Endpoint" ? ep : ue))).toEqual([
      `Endpoint accounts-service.accountresource.delete-close component="accounts-service" endpointType="rest" method="DELETE" pathOrTopic="/accounts/{id}" @${R}:29:code:callee:jaxrs@1.0.0`,
      `Endpoint accounts-service.accountresource.get-count component="accounts-service" endpointType="rest" method="GET" pathOrTopic="/accounts" @${R}:42:code:callee:jaxrs@1.0.0`,
      `Endpoint accounts-service.accountresource.get-get component="accounts-service" endpointType="rest" method="GET" pathOrTopic="/accounts/{id}" @${R}:16:code:callee:jaxrs@1.0.0`,
      `Endpoint accounts-service.accountresource.get-list component="accounts-service" endpointType="rest" method="GET" pathOrTopic="/accounts" @${R}:11:code:callee:jaxrs@1.0.0`,
      `Endpoint accounts-service.accountresource.post-placehold component="accounts-service" endpointType="rest" method="POST" pathOrTopic="/accounts/{id}/holds" @${R}:22:code:callee:jaxrs@1.0.0`,
      `Endpoint accounts-service.accountresource.put-rename component="accounts-service" endpointType="rest" method="PUT" pathOrTopic="/accounts/{id}/owner" @${R}:35:code:callee:jaxrs@1.0.0`,
      `Unresolved accounts-service.call.audit-svc.post-record unresolvedKind="http-call" raw="POST http://audit-svc/audit/events" owner="accounts-service" @${A}:9:code:caller:jaxrs@1.0.0`,
      `Unresolved accounts-service.call.ledger-api.get-balance unresolvedKind="http-call" raw="GET http://ledger-api/ledger/v1/accounts/{id}/balance" owner="accounts-service" @${L}:10:code:caller:jaxrs@1.0.0`,
      `Unresolved accounts-service.call.ledger-api.post-transfer unresolvedKind="http-call" raw="POST http://ledger-api/ledger/v1/transfers" owner="accounts-service" @${L}:14:code:caller:jaxrs@1.0.0`,
    ]);
  });
});

describe("micronaut dialect", () => {
  it("finds controller endpoints and declarative client calls, not the injected HttpClient", async () => {
    const s = await scanWith("micronaut", join(FIX, "micronaut/statements-service"));
    const C = "src/main/java/forge/statements/StatementController.java";
    const L = "src/main/java/forge/statements/LedgerClient.java";
    const RC = "src/main/java/forge/statements/RatesClient.java";
    const ep = ["component", "method", "pathOrTopic", "normalizedPath"];
    const ue = ["unresolvedKind", "raw", "owner"];
    expect(s.records.map((r) => view(r, r.kind === "Endpoint" ? ep : ue))).toEqual([
      `Endpoint statements-service.statements.delete-remove component="statements-service" method="DELETE" pathOrTopic="/statements/{id}" normalizedPath="/statements/{}" @${C}:33:code:callee:micronaut@1.0.0`,
      `Endpoint statements-service.statements.get-get component="statements-service" method="GET" pathOrTopic="/statements/{id}" normalizedPath="/statements/{}" @${C}:18:code:callee:micronaut@1.0.0`,
      `Endpoint statements-service.statements.get-list component="statements-service" method="GET" pathOrTopic="/statements" normalizedPath="/statements" @${C}:23:code:callee:micronaut@1.0.0`,
      `Endpoint statements-service.statements.post-send component="statements-service" method="POST" pathOrTopic="/statements/{id}/send" normalizedPath="/statements/{}/send" @${C}:28:code:callee:micronaut@1.0.0`,
      `Unresolved statements-service.call.ledger-api.get-balance unresolvedKind="http-call" raw="GET http://ledger-api/ledger/v1/accounts/{id}/balance" owner="statements-service" @${L}:9:code:caller:micronaut@1.0.0`,
      `Unresolved statements-service.call.ledger-api.post-transfer unresolvedKind="http-call" raw="POST http://ledger-api/ledger/v1/transfers" owner="statements-service" @${L}:12:code:caller:micronaut@1.0.0`,
      `Unresolved statements-service.call.ratesclient.get-rate unresolvedKind="http-call" raw="GET https://rates.northwind-pay.example/v2/fx/{currency}" owner="statements-service" @${RC}:9:code:caller:micronaut@1.0.0`,
    ]);
  });
});

describe("quarkus-reactive-messaging dialect", () => {
  it("turns channels into publish and subscribe loose ends, with the configured topic winning", async () => {
    const s = await scanWith(
      "quarkus-reactive-messaging",
      join(FIX, "quarkus-reactive-messaging/fraud-service"),
    );
    const J = "src/main/java/forge/fraud/FraudScorer.java";
    const P = "src/main/resources/application.properties";
    const D = "quarkus-reactive-messaging@1.0.0";
    expect(s.records.map((r) => view(r, ["unresolvedKind", "raw", "owner"]))).toEqual([
      `Unresolved fraud-service.publish.alerts unresolvedKind="event-publish" raw="alerts" owner="fraud-service" @${J}:15:code:caller:${D}`,
      `Unresolved fraud-service.publish.fraud-scores unresolvedKind="event-publish" raw="fraud-scores" owner="fraud-service" @${J}:23:code:caller:${D}`,
      `Unresolved fraud-service.subscribe.audit-stream unresolvedKind="event-subscribe" raw="audit-stream" owner="fraud-service" @${J}:19:code:callee:${D}`,
      `Unresolved fraud-service.subscribe.payments-in unresolvedKind="event-subscribe" raw="payments.initiated" owner="fraud-service" @${P}:3:config:callee:${D}`,
    ]);
  });
});
