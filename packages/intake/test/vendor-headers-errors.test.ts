import { describe, expect, it } from "vitest";
import { diffVendorSpecs, readVendorSpec } from "../src/index.js";

/**
 * A vendor's response headers and error responses (ADR 0156, on ADR 0142): the spec reader reads
 * the headers a success response lists (OpenAPI 3 and Swagger 2) as response fields `in: header`,
 * so the prototype comparison and the vendor diff compare them; and the diff compares the 4xx and
 * 5xx responses of two versions: one added, one removed, and the fields of one whose schema
 * changed. Northwind Pay is an invented vendor.
 */

const spec = (version: string, responses: string[], headers: string[] = []) =>
  [
    "openapi: 3.0.3",
    `info: { title: Northwind Pay API, version: ${version} }`,
    "paths:",
    "  /charges:",
    "    post:",
    "      operationId: createCharge",
    "      responses:",
    "        '201':",
    "          description: created",
    ...(headers.length ? ["          headers:", ...headers] : []),
    "          content:",
    "            application/json:",
    "              schema:",
    "                type: object",
    "                properties:",
    "                  id: { type: string }",
    ...responses,
    "components:",
    "  headers:",
    "    RateLimit:",
    "      required: true",
    "      schema: { type: integer }",
    "",
  ].join("\n");

const HEADERS = [
  "            X-Request-Id:",
  "              schema: { type: string }",
  "            X-RateLimit-Remaining:",
  "              $ref: '#/components/headers/RateLimit'",
];
const ERRORS_V1 = [
  "        '402':",
  "          description: declined",
  "          content:",
  "            application/json:",
  "              schema:",
  "                type: object",
  "                required: [code]",
  "                properties:",
  "                  code: { type: string, enum: [card_declined, limit] }",
  "                  message: { type: string }",
  "        '422':",
  "          description: can't be charged",
];
const ERRORS_V2 = [
  "        '402':",
  "          description: declined",
  "          content:",
  "            application/json:",
  "              schema:",
  "                type: object",
  "                required: [code]",
  "                properties:",
  "                  code: { type: string, enum: [card_declined, limit, fraud] }",
  "        '409':",
  "          description: a charge with this key is under way",
];

describe("a vendor's response headers (ADR 0156)", () => {
  it("reads each header a success response lists as a response field in: header, cited", () => {
    const s = readVendorSpec("a.yaml", spec("1.0.0", [], HEADERS), "northwind-pay")!;
    const op = s.operations[0]!;
    expect(op.response.filter((f) => f.in === "header")).toEqual([
      { name: "X-Request-Id", in: "header", type: "string", required: false, cite: "a.yaml:11" },
      {
        name: "X-RateLimit-Remaining",
        in: "header",
        type: "integer",
        required: true,
        cite: "a.yaml:13",
      },
    ]);
    expect(op.response.find((f) => f.name === "id")?.in).toBe("body");
  });

  it("reads Swagger 2's response headers", () => {
    const s = readVendorSpec(
      "s.yaml",
      [
        "swagger: '2.0'",
        "info: { title: Northwind Pay API, version: 1.0.0 }",
        "paths:",
        "  /charges:",
        "    get:",
        "      responses:",
        "        '200':",
        "          description: ok",
        "          headers:",
        "            X-Total-Count: { type: integer }",
        "",
      ].join("\n"),
      "northwind-pay",
    )!;
    expect(s.operations[0]!.response).toEqual([
      { name: "X-Total-Count", in: "header", type: "integer", cite: "s.yaml:10" },
    ]);
  });

  it("compares them between versions: a header the response no longer sends breaks", () => {
    const older = readVendorSpec("a.yaml", spec("1.0.0", [], HEADERS), "northwind-pay")!;
    const newer = readVendorSpec(
      "b.yaml",
      spec("2.0.0", [], HEADERS.slice(0, 2)),
      "northwind-pay",
    )!;
    expect(diffVendorSpecs(older, newer).map((c) => [c.kind, c.severity, c.field, c.says])).toEqual(
      [
        [
          "field-removed",
          "breaking",
          "X-RateLimit-Remaining",
          "POST /charges: the response header X-RateLimit-Remaining is gone; a caller that reads it gets nothing.",
        ],
      ],
    );
  });
});

describe("a vendor's error responses between versions (ADR 0156)", () => {
  const older = () => readVendorSpec("a.yaml", spec("1.0.0", ERRORS_V1), "northwind-pay")!;
  const newer = () => readVendorSpec("b.yaml", spec("2.0.0", ERRORS_V2), "northwind-pay")!;

  it("reads each error response's fields beside its status", () => {
    const errors = older().operations[0]!.errors!;
    expect(errors.map((e) => [e.status, e.cite, (e.fields ?? []).map((f) => f.name)])).toEqual([
      ["402", "a.yaml:16", ["code", "message"]],
      ["422", "a.yaml:26", []],
    ]);
  });

  it("says each error added, removed or whose schema changed, and whether it breaks a caller", () => {
    const got = diffVendorSpecs(older(), newer());
    expect(got.map((c) => [c.kind, c.severity, c.status, c.field ?? "", c.says])).toEqual([
      [
        "error-added",
        "breaking",
        "409",
        "",
        "POST /charges: it may now answer 409; a caller that doesn't handle 409 must.",
      ],
      [
        "error-schema",
        "breaking",
        "402",
        "code",
        "POST /charges (its 402 response): the response field code may now be fraud; a caller that reads it must handle the new value.",
      ],
      [
        "error-schema",
        "breaking",
        "402",
        "message",
        "POST /charges (its 402 response): the response field message is gone; a caller that reads it gets nothing.",
      ],
      [
        "error-removed",
        "additive",
        "422",
        "",
        "POST /charges: it no longer answers 422; no caller has to change.",
      ],
    ]);
    const added = got.find((c) => c.kind === "error-added")!;
    expect(added.id).toBe("error-added.post-charges.409");
    expect(added.after).toEqual({ value: "409", cite: "b.yaml:25" });
    const removed = got.find((c) => c.kind === "error-removed")!;
    expect(removed.before).toEqual({ value: "422", cite: "a.yaml:26" });
    expect(got.find((c) => c.field === "message")!.id).toBe(
      "error-schema.post-charges.402.response.message",
    );
    expect(diffVendorSpecs(older(), older())).toEqual([]);
  });
});
