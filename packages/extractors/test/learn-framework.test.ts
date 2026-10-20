import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fsRepo } from "@maycombhq/sdk";
import { learnFramework, learnFrameworkFromJar } from "../src/index.js";

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
      calls: [],
      routes: [],
      tests: [],
      services: {},
      constants: {
        "Services.AUDIT": { value: "audit", source: code(`${HTTP}/Services.java`) },
        "Services.PAYMENTS": { value: "payments", source: code(`${HTTP}/Services.java`) },
      },
    });
    // What it couldn't learn from code alone, said plainly (see the JAR test below).
    expect(r.notes).toContain(
      "Services.AUDIT, Services.PAYMENTS look like service ids: their base URLs aren't in the code; add them under services: (from the registry's config or a person).",
    );
  });
});

describe("learning a framework model from a starter's JAR (ADR 0054)", () => {
  const JAR = join(dirname(PLATFORM), "../jars/tide-web-starter-3.2.0.jar");

  it("reads the compiled classes into the same model as the source, every entry from bytecode", async () => {
    const bytes = await readFile(JAR);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const fromJar = learnFrameworkFromJar(bytes, {
      name: "tide-platform",
      jarName: "tide-web-starter-3.2.0.jar",
    });
    const fromSource = await learnFramework(fsRepo("tide-platform", PLATFORM, SHA), {
      name: "tide-platform",
    });
    // Same meaning, whichever was read.
    const meaning = (m: typeof fromJar.model) =>
      JSON.parse(JSON.stringify(m, (k, v) => (k === "source" ? undefined : v)));
    expect(meaning(fromJar.model)).toEqual(meaning(fromSource.model));
    // Each entry says it came from bytecode: the class inside the JAR, and the JAR's checksum.
    expect(fromJar.model.annotations.find((a) => a.name === "InternalApi")!.source).toEqual({
      kind: "bytecode",
      ref: `tide-web-starter-3.2.0.jar!tide/platform/web/InternalApi.class sha256:${sha}`,
    });
    expect(fromJar.model.clients.every((c) => c.source.kind === "bytecode")).toBe(true);
    expect(fromJar.notes).toEqual(fromSource.notes);
  });

  it("refuses what isn't a JAR", () => {
    expect(() =>
      learnFrameworkFromJar(new Uint8Array([1, 2, 3]), { name: "x", jarName: "x.jar" }),
    ).toThrow();
  });
});
