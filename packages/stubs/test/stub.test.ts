import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, type CatalogRecord } from "@maycombhq/core";
import {
  buildStub,
  checkStub,
  parseSpec,
  stubFromCatalog,
  stubHandler,
  type Stub,
  type StubHandler,
} from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const spec = (rel: string) => readFileSync(join(HERE, "fixtures/specs", rel), "utf8");
const ACCOUNTS = spec("accounts-openapi.yaml");
const FX = spec("fx-swagger.json");
const LEDGER = readFileSync(join(FORGE, "repos/forge-ledger/api/ledger-openapi.yaml"), "utf8");
const NORTHWIND = readFileSync(
  join(FORGE, "inputs/partner-specs/northwind-pay-openapi.yaml"),
  "utf8",
);

function forgeCatalog(): CatalogRecord[] {
  return (
    parse(readFileSync(join(FORGE, "expected/scan.yaml"), "utf8")) as Record<string, unknown>[]
  ).map((r) => {
    const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
    if (!p.ok) throw new Error(String(r.id));
    return p.record;
  });
}

interface Reply {
  status: number;
  headers: Record<string, string>;
  text: string;
  body: unknown;
}

/** Call the handler with in-memory request and response objects: no sockets. */
function call(
  handler: StubHandler,
  method: string,
  url: string,
  o: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<Reply> {
  const raw =
    o.body === undefined ? [] : [typeof o.body === "string" ? o.body : JSON.stringify(o.body)];
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.headers ?? {})) headers[k.toLowerCase()] = v;
  if (o.body !== undefined && !headers["content-type"])
    headers["content-type"] = "application/json";
  const req = Object.assign(Readable.from(raw.map((s) => Buffer.from(s))), {
    method,
    url,
    headers,
  });
  return new Promise((resolve, reject) => {
    let status = 0;
    let hs: Record<string, string> = {};
    const res = {
      writeHead(s: number, h: Record<string, string> = {}) {
        status = s;
        hs = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), String(v)]));
        return res;
      },
      end(text?: string) {
        resolve({
          status,
          headers: hs,
          text: text ?? "",
          body: text ? (JSON.parse(text) as unknown) : undefined,
        });
        return res;
      },
    };
    handler(req, res).catch(reject);
  });
}

const routes = (s: Stub) =>
  s.routes.map((r) => [r.method, r.path, r.operationId ?? null, r.status, r.example]);

describe("buildStub: the route table", () => {
  it("reads every operation of an OpenAPI 3 spec, with the status and example it answers with", () => {
    const s = buildStub(ACCOUNTS);
    expect(s.title).toBe("Forge Accounts API");
    expect(s.basePaths).toEqual(["/v1"]);
    expect(routes(s)).toEqual([
      ["GET", "/accounts", "listAccounts", 200, "examples"],
      ["POST", "/accounts", "openAccount", 201, "example"],
      ["GET", "/accounts/me", "getMyAccount", 200, "generated"],
      ["DELETE", "/accounts/{id}", "closeAccount", 204, "none"],
      ["GET", "/accounts/{id}", "getAccount", 200, "example"],
      ["GET", "/accounts/{id}/statements/{month}", "getStatement", 200, "schema-example"],
    ]);
    expect(s.warnings).toEqual([]);
  });

  it("reads Swagger 2.0 (JSON), with its basePath", () => {
    const s = buildStub(parseSpec(FX));
    expect(s.basePaths).toEqual(["/fx"]);
    expect(routes(s)).toEqual([
      ["POST", "/quotes", "createQuote", 201, "generated"],
      ["GET", "/rates/{base}", "getRates", 200, "examples"],
    ]);
  });

  it("reads the Forge ledger spec and the Northwind partner spec", () => {
    expect(routes(buildStub(LEDGER))).toEqual([
      ["GET", "/accounts/{id}/balance", "getBalance", 200, "none"],
      ["POST", "/transfers", "createTransfer", 201, "none"],
    ]);
    expect(routes(buildStub(NORTHWIND))).toEqual([
      ["POST", "/v2/payments", "createPayment", 202, "none"],
    ]);
  });

  it("is deterministic", () => {
    expect(buildStub(ACCOUNTS)).toEqual(buildStub(ACCOUNTS));
  });

  it("rejects a file that is not an OpenAPI or Swagger spec", () => {
    expect(() => buildStub("title: not a spec\n")).toThrow(/not an OpenAPI 3 or Swagger 2.0 spec/);
  });

  it("checkStub reports which operations have examples", () => {
    expect(checkStub(buildStub(ACCOUNTS)).map((r) => [r.method, r.path, r.example])).toEqual([
      ["GET", "/accounts", "examples"],
      ["POST", "/accounts", "example"],
      ["GET", "/accounts/me", "generated"],
      ["DELETE", "/accounts/{id}", "none"],
      ["GET", "/accounts/{id}", "example"],
      ["GET", "/accounts/{id}/statements/{month}", "schema-example"],
    ]);
  });
});

describe("stubHandler: answers", () => {
  const h = stubHandler(buildStub(ACCOUNTS));

  it("answers with the first named example, the first 2xx status and application/json", async () => {
    const r = await call(h, "GET", "/accounts?status=open");
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("application/json");
    expect(r.headers["x-stub-route"]).toBe("GET /accounts");
    expect(r.body).toEqual([
      { id: 1, number: "FG0001", status: "open" },
      { id: 2, number: "FG0002", status: "open" },
    ]);
  });

  it("picks a named example with Prefer: example=<name>", async () => {
    const r = await call(h, "GET", "/accounts?status=open", {
      headers: { Prefer: "example=none" },
    });
    expect(r.body).toEqual([]);
  });

  it("matches path templates, with or without the server's base path", async () => {
    const want = {
      id: 42,
      number: "FG0042",
      holder: "Sample Holder",
      status: "open",
      opened: "2024-03-01",
    };
    expect((await call(h, "GET", "/accounts/42")).body).toEqual(want);
    expect((await call(h, "GET", "/v1/accounts/42")).body).toEqual(want);
  });

  it("prefers a literal path segment over a template", async () => {
    const r = await call(h, "GET", "/accounts/me", {
      headers: { "X-Customer-Id": "1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b" },
    });
    expect(r.headers["x-stub-route"]).toBe("GET /accounts/me");
  });

  it("generates a body from the schema when there is no example, the same every time", async () => {
    const headers = { "X-Customer-Id": "1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b" };
    const r = await call(h, "GET", "/accounts/me", { headers });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      id: 0,
      number: "FG0001",
      holder: "string",
      status: "open",
      opened: "2024-01-01",
      tags: ["string"],
      limits: { daily: 500, currency: "EUR" },
    });
    expect((await call(h, "GET", "/accounts/me", { headers })).text).toBe(r.text);
  });

  it("uses the schema's own example", async () => {
    const r = await call(h, "GET", "/accounts/7/statements/2024-01");
    expect(r.body).toEqual({ month: "2024-01", entries: 3, closingBalance: 120.5 });
  });

  it("checks a JSON body and answers with the operation's example", async () => {
    const r = await call(h, "POST", "/accounts", {
      body: { holder: "Sample Holder", currency: "EUR" },
    });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ id: 3, number: "FG0003", holder: "Sample Holder", status: "open" });
  });

  it("sends no body for 204", async () => {
    const r = await call(h, "DELETE", "/accounts/42");
    expect(r.status).toBe(204);
    expect(r.text).toBe("");
    expect(r.headers["content-type"]).toBeUndefined();
  });
});

describe("stubHandler: validation", () => {
  const h = stubHandler(buildStub(ACCOUNTS));
  const problem = (r: Reply) => {
    expect(r.status).toBe(400);
    expect(r.headers["content-type"]).toBe("application/problem+json");
    return r.body as { type: string; title: string; detail: string; errors: unknown[] };
  };

  it("reports a missing required query parameter", async () => {
    const p = problem(await call(h, "GET", "/accounts"));
    expect(p).toEqual({
      type: "urn:atticus:stub:invalid-request",
      title: "The request doesn't match the spec",
      status: 400,
      detail: "1 problem with GET /accounts.",
      instance: "/accounts",
      errors: [{ in: "query", name: "status", message: "is required" }],
    });
  });

  it("checks enums and ranges of query parameters", async () => {
    const p = problem(await call(h, "GET", "/accounts?status=pending&limit=500"));
    expect(p.errors).toEqual([
      { in: "query", name: "status", message: "must be one of open, closed" },
      { in: "query", name: "limit", message: "must be at most 100" },
    ]);
    expect(p.detail).toBe("2 problems with GET /accounts.");
  });

  it("checks path parameter types", async () => {
    expect(problem(await call(h, "GET", "/accounts/abc")).errors).toEqual([
      { in: "path", name: "id", message: "must be an integer" },
    ]);
  });

  it("checks required headers and their format", async () => {
    expect(problem(await call(h, "GET", "/accounts/me")).errors).toEqual([
      { in: "header", name: "X-Customer-Id", message: "is required" },
    ]);
    expect(
      problem(await call(h, "GET", "/accounts/me", { headers: { "X-Customer-Id": "nope" } }))
        .errors,
    ).toEqual([{ in: "header", name: "X-Customer-Id", message: "must be a UUID" }]);
  });

  it("reports a missing required body and a body that isn't JSON", async () => {
    expect(problem(await call(h, "POST", "/accounts")).errors).toEqual([
      { in: "body", pointer: "", message: "is required" },
    ]);
    expect(problem(await call(h, "POST", "/accounts", { body: "{" })).errors).toEqual([
      { in: "body", pointer: "", message: "isn't valid JSON" },
    ]);
  });

  it("checks the body against the schema: required, type, enum, format, ranges, items", async () => {
    expect(problem(await call(h, "POST", "/accounts", { body: {} })).errors).toEqual([
      { in: "body", pointer: "/holder", message: "is required" },
      { in: "body", pointer: "/currency", message: "is required" },
    ]);
    const p = problem(
      await call(h, "POST", "/accounts", {
        body: { holder: "", currency: "JPY", email: "nope", initialDeposit: -1, tags: [1] },
      }),
    );
    expect(p.errors).toEqual([
      { in: "body", pointer: "/holder", message: "must be at least 1 character long" },
      { in: "body", pointer: "/currency", message: "must be one of EUR, USD, GBP" },
      { in: "body", pointer: "/email", message: "must be an email address" },
      { in: "body", pointer: "/initialDeposit", message: "must be at least 0" },
      { in: "body", pointer: "/tags/0", message: "must be a string" },
    ]);
    expect(problem(await call(h, "POST", "/accounts", { body: [] })).errors).toEqual([
      { in: "body", pointer: "", message: "must be an object" },
    ]);
  });
});

describe("stubHandler: unknown routes and scenarios", () => {
  const h = stubHandler(buildStub(ACCOUNTS));

  it("answers 404 with a problem body that lists the operations", async () => {
    const r = await call(h, "GET", "/nope");
    expect(r.status).toBe(404);
    expect(r.headers["content-type"]).toBe("application/problem+json");
    expect(r.body).toEqual({
      type: "urn:atticus:stub:no-route",
      title: "No such operation",
      status: 404,
      detail: "The spec has no operation for GET /nope.",
      instance: "/nope",
      operations: [
        "GET /accounts",
        "POST /accounts",
        "GET /accounts/me",
        "DELETE /accounts/{id}",
        "GET /accounts/{id}",
        "GET /accounts/{id}/statements/{month}",
      ],
    });
  });

  it("answers 405 with Allow when the path exists but the method doesn't", async () => {
    const r = await call(h, "PATCH", "/accounts/42");
    expect(r.status).toBe(405);
    expect(r.headers.allow).toBe("DELETE, GET");
    expect(r.body).toMatchObject({
      type: "urn:atticus:stub:method-not-allowed",
      status: 405,
      detail: "/accounts/{id} takes DELETE or GET, not PATCH.",
    });
  });

  it("returns a documented response for X-Stub-Status or Prefer: code=", async () => {
    const down = await call(h, "GET", "/accounts/42", { headers: { "X-Stub-Status": "503" } });
    expect(down.status).toBe(503);
    expect(down.body).toEqual({ title: "Ledger unavailable", status: 503, retryAfter: 30 });
    const missing = await call(h, "GET", "/accounts/42", { headers: { Prefer: "code=404" } });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ title: "No such account", status: 404 });
  });

  it("keeps the documented media type for a scenario", async () => {
    const r = await call(h, "POST", "/accounts", {
      headers: { Prefer: "code=422" },
      body: { holder: "Sample Holder", currency: "EUR" },
    });
    expect(r.status).toBe(422);
    expect(r.headers["content-type"]).toBe("application/problem+json");
    expect(r.body).toEqual({ title: "The holder failed checks", status: 422 });
  });

  it("matches a scenario to a status range like 5XX", async () => {
    const r = await call(h, "GET", "/accounts/1/statements/2024-01", {
      headers: { "X-Stub-Status": "502" },
    });
    expect(r.status).toBe(502);
    expect(r.body).toEqual({ title: "Statements are unavailable" });
  });

  it("refuses a scenario the spec doesn't document", async () => {
    const r = await call(h, "GET", "/accounts/42", { headers: { "X-Stub-Status": "418" } });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({
      type: "urn:atticus:stub:unknown-scenario",
      title: "No such response in the spec",
      status: 400,
      detail: "GET /accounts/{id} documents 200, 404, 503, not 418.",
      instance: "/accounts/42",
      documented: ["200", "404", "503"],
    });
  });
});

describe("stubHandler: Swagger 2.0 and the Forge specs", () => {
  it("serves the Swagger fixture under its basePath, with body parameters checked", async () => {
    const h = stubHandler(buildStub(FX));
    expect((await call(h, "GET", "/fx/rates/EUR")).body).toEqual({
      base: "EUR",
      rates: { USD: 1.08 },
    });
    const bad = await call(h, "GET", "/fx/rates/GBP?date=yesterday");
    expect(bad.status).toBe(400);
    expect((bad.body as { errors: unknown[] }).errors).toEqual([
      { in: "path", name: "base", message: "must be one of EUR, USD" },
      { in: "query", name: "date", message: "must be a date (YYYY-MM-DD)" },
    ]);
    const quote = await call(h, "POST", "/fx/quotes", {
      body: { from: "EUR", to: "USD", amount: 10 },
    });
    expect(quote.status).toBe(201);
    expect(quote.body).toEqual({
      id: "00000000-0000-4000-8000-000000000000",
      rate: 1.08,
      expiresAt: "2024-01-01T00:00:00Z",
    });
    const zero = await call(h, "POST", "/fx/quotes", {
      body: { from: "EUR", to: "USD", amount: 0 },
    });
    expect((zero.body as { errors: unknown[] }).errors).toEqual([
      { in: "body", pointer: "/amount", message: "must be at least 0.01" },
    ]);
    const err = await call(h, "POST", "/fx/quotes", {
      headers: { "X-Stub-Status": "500" },
      body: { from: "EUR", to: "USD", amount: 10 },
    });
    expect(err.status).toBe(500);
    expect(err.body).toEqual({ message: "Something went wrong" });
  });

  it("answers {} for documented responses without a body", async () => {
    const ledger = stubHandler(buildStub(LEDGER));
    const bal = await call(ledger, "GET", "/accounts/7/balance");
    expect([bal.status, bal.body, bal.headers["content-type"]]).toEqual([
      200,
      {},
      "application/json",
    ]);
    const t = await call(ledger, "POST", "/transfers", { body: { amount: 5 } });
    expect([t.status, t.body]).toEqual([201, {}]);
    const nw = await call(stubHandler(buildStub(NORTHWIND)), "POST", "/v2/payments", {
      body: {},
    });
    expect([nw.status, nw.body]).toEqual([202, {}]);
  });
});

describe("stubFromCatalog", () => {
  const records = forgeCatalog();

  it("serves a system's endpoints known in the catalog, also under the gateway base path", async () => {
    const s = stubFromCatalog(records, "ledger");
    expect(s.title).toBe("Catalog stub for ledger");
    expect(s.basePaths).toEqual(["/ledger/v1"]);
    expect(routes(s)).toEqual([
      ["GET", "/accounts/{id}/balance", "ledger-api.get-balance", 200, "catalog"],
      ["POST", "/transfers", "ledger-api.post-transfer", 200, "catalog"],
    ]);
    const h = stubHandler(s);
    const r = await call(h, "GET", "/ledger/v1/accounts/7/balance");
    expect([r.status, r.body]).toEqual([200, {}]);
    expect((await call(h, "POST", "/transfers")).status).toBe(200);
    expect((await call(h, "GET", "/transfers")).status).toBe(405);
  });

  it("takes a component id, or a vendor system that owns endpoints directly", () => {
    expect(routes(stubFromCatalog(records, "ledger-api"))).toEqual(
      routes(stubFromCatalog(records, "ledger")),
    );
    expect(routes(stubFromCatalog(records, "northwind-pay"))).toEqual([
      ["POST", "/v2/payments", "northwind-pay.post-payment", 200, "catalog"],
    ]);
  });

  it("refuses an id that is neither a component nor a system", () => {
    expect(() => stubFromCatalog(records, "nope")).toThrow(/No component or system "nope"/);
  });
});
