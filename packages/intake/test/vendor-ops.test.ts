import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { diffVendorSpecs, readVendorSpec, scanInputs } from "../src/index.js";

/**
 * A vendor's operations read from its published spec, and two versions compared (ADR 0130).
 * Northwind Pay is an invented vendor; v2 adds an operation, renames a field, makes an optional
 * field required and removes an operation. The expected diff is written by hand.
 */

const FX = join(__dirname, "..", "..", "..", "fixtures", "vendor-impact");
const V1 = "inputs/partner-specs/northwind-pay-openapi-v1.yaml";
const V2 = "inputs/partner-specs/northwind-pay-openapi-v2.yaml";
const text = (p: string) => readFileSync(join(FX, p), "utf8");
const v1 = () => readVendorSpec(V1, text(V1), "northwind-pay")!;
const v2 = () => readVendorSpec(V2, text(V2), "northwind-pay")!;

describe("readVendorSpec", () => {
  it("reads the operations, the hosts and the server path, each operation citing its line", () => {
    const s = v1();
    expect(s.title).toBe("Northwind Pay API");
    expect(s.version).toBe("1.0.0");
    expect(s.hosts).toEqual(["api.northwindpay.example"]);
    expect(s.serverPath).toBe("/v1");
    expect(
      s.operations.map((o) => [
        o.id,
        o.method,
        o.path,
        o.fullPath,
        o.operationId,
        o.cite,
        o.auth,
        o.scopes,
      ]),
    ).toEqual([
      [
        "northwind-pay.post-charge",
        "POST",
        "/charges",
        "/v1/charges",
        "createCharge",
        `${V1}:12`,
        "oauth2",
        ["charges.write"],
      ],
      [
        "northwind-pay.get-charge",
        "GET",
        "/charges/{chargeId}",
        "/v1/charges/{chargeId}",
        "getCharge",
        `${V1}:28`,
        "oauth2",
        ["charges.read"],
      ],
      [
        "northwind-pay.post-capture",
        "POST",
        "/charges/{chargeId}/capture",
        "/v1/charges/{chargeId}/capture",
        "captureCharge",
        `${V1}:42`,
        "oauth2",
        ["charges.write"],
      ],
      [
        "northwind-pay.post-refund",
        "POST",
        "/charges/{chargeId}/refunds",
        "/v1/charges/{chargeId}/refunds",
        "createRefund",
        `${V1}:54`,
        "oauth2",
        ["charges.write"],
      ],
    ]);
  });

  it("reads request and response fields through $ref, required or optional, with their types, enums and lines", () => {
    const charge = v1().operations.find((o) => o.operationId === "createCharge")!;
    expect(charge.request).toEqual([
      {
        name: "amount",
        in: "body",
        type: "number",
        required: true,
        cite: `${V1}:93`,
        requiredCite: `${V1}:91`,
      },
      {
        name: "currency",
        in: "body",
        type: "string",
        required: true,
        enum: ["USD", "EUR"],
        cite: `${V1}:95`,
        requiredCite: `${V1}:91`,
      },
      { name: "reference", in: "body", type: "string", required: false, cite: `${V1}:98` },
      { name: "description", in: "body", type: "string", required: false, cite: `${V1}:100` },
    ]);
    expect(charge.response.map((f) => [f.name, f.type, f.required, f.enum])).toEqual([
      ["id", "string", true, undefined],
      ["status", "string", true, ["pending", "captured", "failed"]],
      ["amount", "number", true, undefined],
    ]);
  });

  it("leaves a path parameter to the path, and reads a query parameter and an array's items", () => {
    const list = v2().operations.find((o) => o.operationId === "listCharges")!;
    expect(list.request).toEqual([
      {
        name: "status",
        in: "query",
        type: "string",
        required: false,
        enum: ["pending", "captured", "failed"],
        cite: `${V2}:17`,
      },
    ]);
    expect(list.response.map((f) => f.name)).toEqual([
      "items",
      "items[].id",
      "items[].status",
      "items[].amount",
    ]);
    expect(v1().operations.find((o) => o.operationId === "getCharge")!.request).toEqual([]);
  });

  it("gives two operations the same name a short path hash, as the catalog does", () => {
    expect(v2().operations.map((o) => o.id)).toEqual([
      "northwind-pay.get-charge-625a4a",
      "northwind-pay.post-charge",
      "northwind-pay.get-charge-8fbd38",
      "northwind-pay.post-refund",
    ]);
  });

  it("reads Swagger 2: host, basePath, a body parameter and a 200 response", () => {
    const s = readVendorSpec(
      "inputs/tailspin-swagger.yaml",
      [
        "swagger: '2.0'",
        "info: { title: Tailspin Freight, version: '3' }",
        "host: api.tailspin.example",
        "basePath: /freight",
        "paths:",
        "  /quotes:",
        "    post:",
        "      parameters:",
        "        - in: body",
        "          name: body",
        "          schema:",
        "            $ref: '#/definitions/Quote'",
        "      responses:",
        "        '200':",
        "          schema: { $ref: '#/definitions/Quote' }",
        "definitions:",
        "  Quote:",
        "    type: object",
        "    required: [weight]",
        "    properties:",
        "      weight: { type: integer }",
        "      lane: { type: string }",
        "",
      ].join("\n"),
      "tailspin",
    )!;
    expect(s.hosts).toEqual(["api.tailspin.example"]);
    expect(s.operations.map((o) => [o.method, o.path, o.fullPath])).toEqual([
      ["POST", "/freight/quotes", "/freight/quotes"],
    ]);
    expect(s.operations[0]!.request.map((f) => [f.name, f.type, f.required])).toEqual([
      ["weight", "integer", true],
      ["lane", "string", false],
    ]);
    expect(s.operations[0]!.response.map((f) => f.name)).toEqual(["weight", "lane"]);
  });

  it("is undefined for text that is neither OpenAPI 3 nor Swagger 2", () => {
    expect(readVendorSpec("x.yaml", "asyncapi: 2.6.0\n", "x")).toBeUndefined();
  });
});

describe("diffVendorSpecs", () => {
  it("gives the hand-written v1 → v2 diff, breaking first, each change citing both versions", () => {
    const want = parse(text("expected/diff.yaml")) as { changes: unknown[] };
    expect(JSON.parse(JSON.stringify(diffVendorSpecs(v1(), v2())))).toEqual(want.changes);
  });

  it("is empty for the same spec, and deterministic", () => {
    expect(diffVendorSpecs(v1(), v1())).toEqual([]);
    expect(diffVendorSpecs(v1(), v2())).toEqual(diffVendorSpecs(v1(), v2()));
  });

  it("says every kind of change plainly, breaking or additive by fixed rules", () => {
    const older = readVendorSpec(
      "a.yaml",
      [
        "openapi: 3.0.3",
        "info: { title: Northwind Pay API, version: 1.0.0 }",
        "components:",
        "  securitySchemes:",
        "    oauth: { type: oauth2 }",
        "    key: { type: apiKey, in: header, name: X-Key }",
        "paths:",
        "  /payouts:",
        "    post:",
        "      operationId: createPayout",
        "      security: [{ oauth: [payouts.write] }]",
        "      requestBody:",
        "        content:",
        "          application/json:",
        "            schema:",
        "              type: object",
        "              required: [amount, currency]",
        "              properties:",
        "                amount: { type: number }",
        "                currency: { type: string, enum: [USD, EUR, GBP] }",
        "                memo: { type: string }",
        "      responses:",
        "        '201':",
        "          content:",
        "            application/json:",
        "              schema:",
        "                type: object",
        "                required: [id]",
        "                properties:",
        "                  id: { type: string }",
        "                  state: { type: string, enum: [queued, sent] }",
        "  /payouts/{id}/cancel:",
        "    post:",
        "      operationId: cancelPayout",
        "      responses: { '204': { description: done } }",
        "",
      ].join("\n"),
      "northwind-pay",
    )!;
    const newer = readVendorSpec(
      "b.yaml",
      [
        "openapi: 3.0.3",
        "info: { title: Northwind Pay API, version: 2.0.0 }",
        "components:",
        "  securitySchemes:",
        "    oauth: { type: oauth2 }",
        "    key: { type: apiKey, in: header, name: X-Key }",
        "paths:",
        "  /payouts:",
        "    post:",
        "      operationId: createPayout",
        "      security: [{ oauth: [payouts.write, payouts.approve] }]",
        "      requestBody:",
        "        content:",
        "          application/json:",
        "            schema:",
        "              type: object",
        "              required: [amount, currency, account]",
        "              properties:",
        "                amount: { type: string }",
        "                currency: { type: string, enum: [USD, EUR, CHF] }",
        "                account: { type: string }",
        "                note: { type: integer }",
        "      responses:",
        "        '201':",
        "          content:",
        "            application/json:",
        "              schema:",
        "                type: object",
        "                properties:",
        "                  id: { type: string }",
        "                  state: { type: string, enum: [queued, sent, held] }",
        "                  fee: { type: number }",
        "  /payouts/{id}/cancellation:",
        "    put:",
        "      operationId: cancelPayout",
        "      security: [{ key: [] }]",
        "      responses: { '204': { description: done } }",
        "",
      ].join("\n"),
      "northwind-pay",
    )!;
    expect(
      diffVendorSpecs(older, newer).map((c) => [c.kind, c.severity, c.field ?? "", c.says]),
    ).toEqual([
      [
        "scopes",
        "breaking",
        "",
        "POST /payouts: a caller's token now needs payouts.approve as well.",
      ],
      [
        "field-removed",
        "breaking",
        "memo",
        "POST /payouts: the request field memo is gone; a caller that sends it may be refused, and what it meant is lost.",
      ],
      [
        "field-added",
        "breaking",
        "account",
        "POST /payouts: the request needs a new field account; a caller that doesn't send it is refused.",
      ],
      [
        "field-required",
        "breaking",
        "id",
        "POST /payouts: the response field id may now be left out; a caller that counts on it must allow for that.",
      ],
      [
        "field-type",
        "breaking",
        "amount",
        "POST /payouts: the request field amount was number and is now string; a caller that sends it must change.",
      ],
      [
        "field-enum",
        "breaking",
        "currency",
        "POST /payouts: the request field currency no longer takes GBP and now takes CHF; a caller that sends a value it no longer takes is refused.",
      ],
      [
        "field-enum",
        "breaking",
        "state",
        "POST /payouts: the response field state may now be held; a caller that reads it must handle the new value.",
      ],
      [
        "operation-moved",
        "breaking",
        "",
        "cancelPayout moved from POST /payouts/{id}/cancel to PUT /payouts/{id}/cancellation; a call to the old one will fail.",
      ],
      [
        "auth",
        "breaking",
        "",
        "PUT /payouts/{id}/cancellation: auth was none and is now api-key; every caller must change how it signs in.",
      ],
      [
        "field-added",
        "additive",
        "note",
        "POST /payouts: the request takes a new optional field note; no caller has to change.",
      ],
      [
        "field-added",
        "additive",
        "fee",
        "POST /payouts: the response has a new field fee; no caller has to change.",
      ],
    ]);
  });
});

describe("a vendor's operations in the catalog (scanInputs)", () => {
  it("reads the newer version, and gives each operation a request and a response Schema with required said", async () => {
    const res = await scanInputs({ root: FX, scannedAt: "2026-10-26T09:00:00Z" });
    expect(res.problems).toEqual([]);
    expect(res.documents.map((d) => [d.path, d.status, d.supersededBy, d.systems])).toEqual([
      [V1, "superseded", "doc.northwind-pay-openapi-v2", ["northwind-pay"]],
      [V2, "read", undefined, ["northwind-pay"]],
    ]);
    const byId = new Map(res.records.map((r) => [r.id, r as Record<string, unknown>]));
    expect(byId.get("northwind-pay.post-charge")).toMatchObject({
      kind: "Endpoint",
      component: "northwind-pay",
      method: "POST",
      normalizedPath: "/charges",
      schemaRefs: ["northwind-pay.post-charge.request", "northwind-pay.post-charge.response"],
    });
    expect(byId.get("northwind-pay.post-charge.request")).toMatchObject({
      kind: "Schema",
      confidence: "verified",
      format: "openapi",
      ref: `${V2}#/paths/~1charges/post/requestBody`,
      version: "2.0.0",
      fields: [
        { name: "amount", type: "number", required: true },
        { name: "currency", type: "string", required: true },
        { name: "merchantReference", type: "string", required: false },
        { name: "description", type: "string", required: false },
      ],
      evidence: [
        { source: "spec", path: V2, line: 30, side: "definition" },
        { source: "spec", path: V2, line: 99, side: "definition" },
        { source: "spec", path: V2, line: 101, side: "definition" },
        { source: "spec", path: V2, line: 104, side: "definition" },
        { source: "spec", path: V2, line: 106, side: "definition" },
      ],
    });
    expect(
      (
        byId.get("northwind-pay.post-refund.request")!.fields as {
          name: string;
          required: boolean;
        }[]
      ).map((f) => [f.name, f.required]),
    ).toEqual([
      ["amount", true],
      ["reason", true],
    ]);
    // The superseded version's operations are not in the catalog: only what the vendor says now.
    expect(byId.has("northwind-pay.post-capture")).toBe(false);
  });
});
