import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import SwaggerParser from "@apidevtools/swagger-parser";
import { describe, expect, it } from "vitest";
import { Api, openApiDocument, RECORD_KINDS } from "../src/index.js";

type Doc = {
  openapi: string;
  paths: Record<
    string,
    Record<
      string,
      { operationId: string; responses: Record<string, unknown>; requestBody?: unknown }
    >
  >;
  components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
};

describe("local API (contract C4)", () => {
  const doc = openApiDocument() as unknown as Doc;

  it("is a valid OpenAPI 3.1 document with every reference resolving", async () => {
    expect(doc.openapi).toBe("3.1.0");
    await expect(SwaggerParser.validate(structuredClone(doc) as never)).resolves.toBeDefined();
  });

  it("covers the calls the plan lists", () => {
    const ops = Object.values(doc.paths).flatMap((m) => Object.values(m).map((o) => o.operationId));
    for (const id of [
      "listRecords",
      "getGraph",
      "getImpact",
      "startScan",
      "getJob",
      "createChange",
      "getArtifact",
      "saveArtifact",
      "startRun",
      "markRunDone",
      "listFindings",
      "actOnFinding",
    ]) {
      expect(ops, id).toContain(id);
    }
    expect(new Set(ops).size).toBe(ops.length);
  });

  it("requires the session token everywhere and documents 401 on every call", () => {
    expect(doc.components.securitySchemes).toHaveProperty("sessionToken");
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const [m, op] of Object.entries(methods))
        expect(op.responses, `${m} ${path}`).toHaveProperty("401");
    }
  });

  it("includes every catalog record kind as a schema", () => {
    for (const k of RECORD_KINDS) expect(doc.components.schemas, k).toHaveProperty(k);
  });

  it("refuses an unknown finding action in the request schema", () => {
    expect(Api.FindingActionRequest.safeParse({ action: "approve" }).success).toBe(false);
    expect(
      Api.FindingActionRequest.safeParse({ action: "waive", reason: "Fixed next release" }).success,
    ).toBe(true);
  });

  it("matches the committed copy in docs/api/openapi.json (run pnpm api:doc after changing it)", () => {
    const committed = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../../docs/api/openapi.json"),
      "utf8",
    );
    expect(committed).toBe(JSON.stringify(openApiDocument(), null, 2) + "\n");
  });

  it("describes the live events", () => {
    expect(Api.LiveEvent.safeParse({ type: "job.done", jobId: "j1", state: "done" }).success).toBe(
      true,
    );
    expect(Api.LiveEvent.safeParse({ type: "job.exploded" }).success).toBe(false);
  });
});
