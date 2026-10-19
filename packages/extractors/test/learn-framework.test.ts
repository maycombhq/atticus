import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fsRepo } from "@maycombhq/sdk";
import { learnFramework } from "../src/index.js";

const PLATFORM = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/messy/repos/tide-platform",
);
const SHA = "c".repeat(40);
const code = (path: string) => ({ kind: "code", ref: `tide-platform:${path}` });
const WEB = "src/main/java/tide/platform/web";
const HTTP = "src/main/java/tide/platform/http";

describe("learning a framework model from a starter's source (ADR 0054)", () => {
  it("reads its annotations (meta-annotations and @AliasFor), wrapper clients and constants", async () => {
    const r = await learnFramework(fsRepo("tide-platform", PLATFORM, SHA), {
      name: "tide-platform",
    });
    expect(r.model).toEqual({
      schemaVersion: 1,
      name: "tide-platform",
      packages: ["tide.platform"],
      artifacts: ["tide.platform:tide-web-starter"],
      annotations: [
        {
          name: "InternalApi",
          means: ["RestController", "RequestMapping"],
          attributes: { basePath: "path" },
          fixed: {},
          source: code(`${WEB}/InternalApi.java`),
        },
        {
          name: "Op",
          means: ["RequestMapping"],
          attributes: { verb: "method", path: "path" },
          fixed: {},
          source: code(`${WEB}/Op.java`),
        },
        // A house annotation built on another: @ReadOp is an @Op that is always a GET.
        {
          name: "ReadOp",
          means: ["RequestMapping"],
          attributes: { value: "path" },
          fixed: { method: "GET" },
          source: code(`${WEB}/ReadOp.java`),
        },
      ],
      clients: [
        {
          type: "BankHttp",
          method: "exchange",
          service: { arg: 0 },
          httpMethod: { arg: 1 },
          path: { arg: 2 },
          source: code(`${HTTP}/BankHttp.java`),
        },
        {
          type: "BankHttp",
          method: "get",
          service: { arg: 0 },
          httpMethod: { value: "GET" },
          path: { arg: 1 },
          source: code(`${HTTP}/BankHttp.java`),
        },
      ],
      services: {},
      constants: {
        "Services.AUDIT": { value: "audit", source: code(`${HTTP}/Services.java`) },
        "Services.PAYMENTS": { value: "payments", source: code(`${HTTP}/Services.java`) },
      },
    });
    // What it couldn't learn from code alone, said plainly.
    expect(r.notes).toContain(
      "Services.AUDIT, Services.PAYMENTS look like service ids: their base URLs aren't in the code; add them under services: (from the registry's config or a person).",
    );
  });
});
