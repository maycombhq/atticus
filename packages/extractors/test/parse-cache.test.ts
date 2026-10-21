import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Dialect, FrameworkModel } from "@maycombhq/core";
import {
  createParseCache,
  fsRepo,
  memoryRepo,
  scanRepo,
  withParseCache,
  type RepoScan,
} from "@maycombhq/sdk";
import {
  BUILT_IN_EXTRACTORS,
  SourceFile,
  applyAnnotations,
  dialectExtractor,
  flattenYaml,
  parseHcl,
  parseJava,
  parseJavaMembers,
  querySyntax,
  readYamlDocs,
  springExtractor,
} from "../src/index.js";
import { withTree } from "../src/lang/code-tree.js";
import { liveTrees } from "../src/lang/syntax.js";

/**
 * The shared parse cache (ADR 0067) as the readers use it: each file parsed once per repo scan,
 * every reader handed the same frozen value, trees freed, and the same records as without it.
 */
const SHA = "0".repeat(40);
const AT = "2026-10-20T09:00:00Z";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

const CONTROLLER = `package forge.ledger;
import org.springframework.web.bind.annotation.*;
import tide.platform.web.Op;
@RestController
@RequestMapping("/ledger")
class LedgerController {
  @GetMapping("/{id}") Entry one(String id) { return null; }
  @Op(verb = "POST", path = "/entries") Entry add() { return null; }
}`;

const dialect = Dialect.parse({
  schemaVersion: 1,
  name: "forge-ops",
  version: "0.1.0",
  appliesTo: {},
  rules: [
    {
      id: "ops",
      description: "A house @Op method is an endpoint.",
      match: { annotation: "Op", target: "method", files: ["**/*.java"] },
      emit: {
        kind: "Unresolved",
        id: "app.op.${file.line}",
        fields: { unresolvedKind: "http-endpoint", raw: "${attr.verb} ${attr.path}", owner: "app" },
      },
      confidence: "inferred",
    },
    {
      id: "gets",
      description: "A GetMapping, read from the syntax tree.",
      match: {
        syntax: `(annotation name: (identifier) @a (#eq? @a "GetMapping") arguments: (annotation_argument_list (string_literal) @path))`,
        files: ["**/*.java"],
      },
      emit: {
        kind: "Unresolved",
        id: "app.get.${file.line}",
        fields: { unresolvedKind: "http-endpoint", raw: "GET ${capture.path}", owner: "app" },
      },
      confidence: "inferred",
    },
  ],
  tests: [{ name: "t", files: {}, expect: [] }],
});

const model = FrameworkModel.parse({
  schemaVersion: 1,
  name: "tide-platform",
  packages: ["tide.platform"],
  annotations: [
    {
      name: "Op",
      means: ["RequestMapping"],
      attributes: { verb: "method", path: "path" },
      source: { kind: "code" },
    },
  ],
});

const plain = (s: RepoScan) => JSON.stringify(s.records);

describe("parse cache (ADR 0067)", () => {
  it("parses each Java file once for spring, a dialect's annotation rule and its syntax rule", async () => {
    const cache = createParseCache();
    const repo = withParseCache(
      memoryRepo("forge-ledger", SHA, { "src/main/java/LedgerController.java": CONTROLLER }),
      cache,
    );
    const s = await scanRepo({
      repo,
      extractors: [springExtractor, dialectExtractor(dialect)],
      dialects: ["forge-ops"],
      repoInfo: { component: "forge-ledger" },
    });
    expect(s.rejected).toEqual([]);
    expect(s.records.length).toBeGreaterThan(0);
    const k = cache.stats().byKind;
    // One tree, one reading of it; every other reader got the cached ones.
    expect(k["tree:java"]).toEqual({ misses: 1, hits: 1 });
    expect(k["java:java"]!.misses).toBe(1);
    expect(k["java:java"]!.hits).toBeGreaterThan(0);
    cache.dispose();
  });

  it("one reader changing its copy can't change another's: spring's house annotations stay out of the dialect's view", async () => {
    const files = { "src/main/java/LedgerController.java": CONTROLLER };
    const run = (extractors: Parameters<typeof scanRepo>[0]["extractors"]) =>
      scanRepo({
        repo: memoryRepo("forge-ledger", SHA, files),
        extractors,
        dialects: ["forge-ops"],
        repoInfo: { component: "forge-ledger" },
        frameworks: [model],
        scannedAt: AT,
      });
    // The dialect alone, then after spring has added RequestMapping beside @Op in its reading.
    const alone = await run([dialectExtractor(dialect)]);
    const after = await run([springExtractor, dialectExtractor(dialect)]);
    const dialectOf = (s: RepoScan) =>
      JSON.stringify(s.records.filter((r) => JSON.stringify(r).includes("forge-ops")));
    expect(dialectOf(after)).toBe(dialectOf(alone));
    // Spring did read the house annotation as RequestMapping.
    expect(
      after.records.some(
        (r) =>
          r.kind === "Endpoint" &&
          (r as unknown as { pathOrTopic: string }).pathOrTopic === "/ledger/entries",
      ),
    ).toBe(true);

    // And straight on the cached value: changing it fails instead of leaking into the next reader.
    const cache = createParseCache();
    const file = await parseJava(CONTROLLER, "A.java", cache);
    expect(() => applyAnnotations(file, [model])).toThrow(TypeError);
    const again = await parseJava(CONTROLLER, "A.java", cache);
    expect(again).toBe(file);
    const add = again.decls.find((d) => d.name === "add")!;
    expect(add.annotations.map((a) => a.name)).toEqual(["Op"]);
    cache.dispose();
  });

  it("shares one tree between every tree reader of a file, and frees it when the scan ends", async () => {
    const cache = createParseCache();
    const at = { cache, path: "A.java" };
    const before = liveTrees();
    await parseJava(CONTROLLER, "A.java", cache);
    await parseJavaMembers(CONTROLLER, at);
    await querySyntax("java", CONTROLLER, "(class_declaration name: (identifier) @n)", at);
    const n = await withTree("java", CONTROLLER, (root) => root.namedChildren.length, at);
    expect(n).toBeGreaterThan(0);
    expect(cache.stats().byKind["tree:java"]).toEqual({ misses: 1, hits: 3 });
    expect(liveTrees()).toBe(before + 1);
    cache.dispose();
    expect(liveTrees()).toBe(before);
    // Without a cache, each reader parses and frees its own tree.
    await parseJavaMembers(CONTROLLER);
    expect(liveTrees()).toBe(before);
  });

  it("frees the trees of a scan whose extractor failed", async () => {
    const before = liveTrees();
    const failing = {
      id: "failing",
      version: "1.0.0",
      claims: ["**/*.java"],
      async *scan(repo: Parameters<typeof springExtractor.scan>[0]) {
        await querySyntax("java", CONTROLLER, "(identifier) @i", {
          cache: repo.parseCache,
          path: "A.java",
        });
        yield* [];
        throw new Error("a reader bug");
      },
    };
    const s = await scanRepo({
      repo: memoryRepo("r", SHA, { "A.java": CONTROLLER }),
      extractors: [failing],
    });
    expect(s.runs[0]!.status).toBe("failed");
    expect(liveTrees()).toBe(before);
  });

  it("hands JavaScript, YAML, HCL and config readers frozen, shared values", async () => {
    const cache = createParseCache();
    const src = await SourceFile.parse("a.ts", "fetch('/api/cards')", "js", cache);
    expect(await SourceFile.parse("a.ts", "fetch('/api/cards')", "js", cache)).toBe(src);
    expect(Object.isFrozen(src.calls[0])).toBe(true);

    const yaml = "kind: Deployment\nspec:\n  replicas: 2\n";
    const docs = readYamlDocs(yaml, { cache, path: "d.yaml" })!;
    expect(readYamlDocs(yaml, { cache, path: "d.yaml" })).toBe(docs);
    expect(() => ((docs[0]!.value as { kind: string }).kind = "Job")).toThrow(TypeError);
    expect(docs[0]!.line(["spec", "replicas"])).toBe(3);

    const flat = flattenYaml(yaml, "d.yaml", cache);
    expect(flattenYaml(yaml, "d.yaml", cache)).toBe(flat);
    expect(() => flat.set("x", { value: "", line: 1, file: "d.yaml" })).toThrow(TypeError);
    expect(flat.get("spec.replicas")).toEqual({ value: "2", line: 3, file: "d.yaml" });

    const tf = 'resource "aws_s3_bucket" "b" { bucket = "forge" }';
    const hcl = parseHcl(tf, { cache, path: "main.tf" });
    expect(parseHcl(tf, { cache, path: "main.tf" })).toBe(hcl);
    expect(() => (hcl.blocks as unknown[]).push({})).toThrow(TypeError);
    cache.dispose();
  });

  it("finds the same records in the Forge and messy repos with a cache that keeps nothing", async () => {
    const repos = [
      ...readdirSync(join(ROOT, "fixtures/forge/repos")).map((r) => `fixtures/forge/repos/${r}`),
      ...readdirSync(join(ROOT, "fixtures/messy/repos")).map((r) => `fixtures/messy/repos/${r}`),
    ];
    expect(repos.length).toBeGreaterThan(5);
    for (const dir of repos) {
      const handle = () => fsRepo(dir.split("/").at(-1)!, join(ROOT, dir), SHA);
      const shared = await scanRepo({
        repo: handle(),
        extractors: BUILT_IN_EXTRACTORS,
        scannedAt: AT,
      });
      const none = createParseCache({ maxChars: 0, maxNativeChars: 0, maxTextChars: 0 });
      const alone = await scanRepo({
        repo: withParseCache(handle(), none),
        extractors: BUILT_IN_EXTRACTORS,
        scannedAt: AT,
      });
      expect(none.stats().hits, dir).toBe(0);
      expect(plain(shared), dir).toBe(plain(alone));
      expect(JSON.stringify(shared.warnings), dir).toBe(JSON.stringify(alone.warnings));
      expect(
        shared.runs.map((r) => `${r.extractor} ${r.status} ${r.error ?? ""}`),
        dir,
      ).toEqual(alone.runs.map((r) => `${r.extractor} ${r.status} ${r.error ?? ""}`));
    }
  }, 300_000);
});
