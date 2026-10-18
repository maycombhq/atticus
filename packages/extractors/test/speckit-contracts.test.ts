import { describe, expect, it } from "vitest";
import { memoryRepo, runExtractor } from "@maycombhq/sdk";
import { asyncapiExtractor, openapiExtractor } from "../src/index.js";

const SHA = "a".repeat(40);
const spec =
  "openapi: 3.0.3\ninfo: { title: x, version: '1' }\npaths:\n  /limits:\n    get:\n      responses: { '200': { description: ok } }\n";
const events =
  "asyncapi: 3.0.0\ninfo: { title: x, version: '1' }\nchannels:\n  limits:\n    address: limits.changed\noperations:\n  send:\n    action: send\n    channel: { $ref: '#/channels/limits' }\n";

describe("contracts inside a Spec Kit feature are plans, not current facts (ADR 0030)", () => {
  it("the OpenAPI and AsyncAPI extractors skip specs/<feature>/contracts/", async () => {
    const repo = memoryRepo("svc", SHA, {
      "specs/1-2/contracts/ledger-openapi.yaml": spec,
      "specs/1-2/contracts/ledger-asyncapi.yaml": events,
      "api/svc-openapi.yaml": spec,
    });
    const o = await runExtractor(openapiExtractor, repo);
    expect(o.records.map((r) => r.evidence[0]!.path)).toEqual(["api/svc-openapi.yaml"]);
    const a = await runExtractor(asyncapiExtractor, repo);
    expect(a.records).toEqual([]);
  });
});
