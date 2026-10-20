import { describe, expect, it } from "vitest";
import { Dialect } from "@maycombhq/core";
import { memoryRepo, scanRepo } from "@maycombhq/sdk";
import { dialectExtractor, querySyntax, runDialectTests, syntaxOutline } from "../src/index.js";

const SHA = "0".repeat(40);

describe("syntax trees (ADR 0060)", () => {
  it("parses a dozen languages and captures what a query names, string values unquoted", async () => {
    const java = await querySyntax(
      "java",
      `class A {
  // bankHttp.exchange(Services.OLD, "GET", "/in-a-comment");
  void f() { String s = "bankHttp.exchange(x, \\"GET\\", \\"/in-a-string\\")";
    bankHttp.exchange(Services.AUDIT, "POST", "/audit/events"); } }`,
      `(method_invocation object: (identifier) @client name: (identifier) @m (#eq? @m "exchange")
         arguments: (argument_list . (_) @service . (string_literal) @verb . (string_literal) @path))`,
    );
    // Only the real call: not the one in a comment, nor the one in a string.
    expect(java).toEqual([
      {
        line: 4,
        captures: {
          client: { value: "bankHttp", line: 4 },
          m: { value: "exchange", line: 4 },
          service: { value: "Services.AUDIT", line: 4 },
          verb: { value: "POST", line: 4 },
          path: { value: "/audit/events", line: 4 },
        },
      },
    ]);
    for (const [lang, src] of [
      ["kotlin", "fun f() = 1"],
      ["typescript", "const x: number = 1;"],
      ["tsx", "const a = <b/>;"],
      ["javascript", "x()"],
      ["c_sharp", "class A {}"],
      ["python", "x = 1"],
      ["go", "package a"],
      ["scala", "object A"],
      ["ruby", "x = 1"],
      ["php", "<?php echo 1;"],
      ["rust", "fn f() {}"],
      [
        "groovy",
        'pipeline { stages { stage("Deploy") { steps { sh "helm upgrade cards ./chart" } } } }',
      ],
    ] as const)
      expect(await syntaxOutline(lang, src), lang).not.toMatch(/ERROR|MISSING/);
  });

  const dialect = (rules: unknown[], extra: Record<string, unknown> = {}) =>
    Dialect.parse({
      schemaVersion: 1,
      name: "house-http",
      version: "0.1.0",
      appliesTo: {},
      rules,
      tests: [{ name: "t", files: {}, expect: [] }],
      ...extra,
    });
  const lookups = {
    constants: {
      match: {
        syntax: `(class_declaration name: (identifier) @cls body: (class_body (field_declaration
                   declarator: (variable_declarator name: (identifier) @name value: (string_literal) @value))))`,
        files: ["**/*.java"],
      },
      key: "${capture.cls}.${capture.name}",
      values: { value: "${capture.value}" },
    },
  };
  const call = (lang: string, query: string, files: string[]) => ({
    id: `exchange-${lang}`,
    description: "The house HTTP wrapper's exchange(service, verb, path) is an HTTP call.",
    match: { syntax: query, files },
    emit: {
      kind: "Unresolved",
      id: "app.http-call.${file.line}-${capture.verb | lower}",
      fields: {
        unresolvedKind: "http-call",
        raw: "${capture.verb} ${lookup:constants(capture.service).value | default('')}${capture.path}",
        owner: "app",
      },
    },
    confidence: "inferred",
  });

  it("reads a house client in Java, Kotlin and TypeScript, its constants from a lookup over the tree", async () => {
    const d = dialect(
      [
        call(
          "java",
          `(method_invocation name: (identifier) @m (#eq? @m "exchange")
             arguments: (argument_list . (_) @service . (string_literal) @verb . (string_literal) @path))`,
          ["**/*.java"],
        ),
        call(
          "kotlin",
          `(call_expression (navigation_expression (navigation_suffix (simple_identifier) @m (#eq? @m "exchange")))
             (call_suffix (value_arguments . (value_argument (_) @service) . (value_argument (string_literal) @verb) . (value_argument (string_literal) @path))))`,
          ["**/*.kt"],
        ),
        call(
          "ts",
          `(call_expression function: (member_expression property: (property_identifier) @m (#eq? @m "exchange"))
             arguments: (arguments . (_) @service . (string) @verb . (string) @path))`,
          ["**/*.ts"],
        ),
      ],
      { lookups },
    );
    const s = await scanRepo({
      repo: memoryRepo("app", SHA, {
        "src/Services.java": `public final class Services { public static final String AUDIT = "https://audit.tide.internal"; }`,
        "src/Audit.java": `class Audit { void r() { bankHttp.exchange(Services.AUDIT, "POST", "/audit/events"); } }`,
        "src/Cards.kt": `fun f() {\n  bankHttp.exchange(Services.AUDIT, "GET", "/audit/cards")\n}`,
        "web/api.ts": `export const g = () => bank.exchange(Services.AUDIT, 'DELETE', '/audit/x');`,
      }),
      extractors: [dialectExtractor(d)],
      dialects: ["house-http"],
    });
    expect(s.rejected).toEqual([]);
    expect(s.records.map((r) => (r as unknown as { raw: string }).raw).sort()).toEqual([
      "DELETE https://audit.tide.internal/audit/x",
      "GET https://audit.tide.internal/audit/cards",
      "POST https://audit.tide.internal/audit/events",
    ]);
  });

  it("fails the dialect's tests when a query doesn't compile, so it never loads", async () => {
    const d = Dialect.parse({
      schemaVersion: 1,
      name: "bad",
      version: "0.1.0",
      appliesTo: {},
      rules: [
        {
          id: "r",
          description: "d",
          match: { syntax: "(method_invocation name: (identifier @m", files: ["**/*.java"] },
          emit: {
            kind: "Unresolved",
            id: "x.${capture.m}",
            fields: { unresolvedKind: "http-call", raw: "${capture.m}" },
          },
          confidence: "inferred",
        },
      ],
      tests: [{ name: "t", files: { "A.java": "class A {}" }, expect: [] }],
    });
    const f = await runDialectTests(d, ".");
    expect(f[0]!.message).toMatch(/^failed: the java query doesn't compile/);
  });
});

describe("vendored grammars", () => {
  it("are the files their manifest names, by checksum, each with its licence beside it", async () => {
    const { createHash } = await import("node:crypto");
    const { existsSync, readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const dir = fileURLToPath(new URL("../grammars/", import.meta.url));
    const list = JSON.parse(readFileSync(dir + "vendored.json", "utf8")) as {
      file: string;
      licenceFile: string;
      sha256: string;
    }[];
    expect(list.length).toBeGreaterThan(0);
    for (const v of list) {
      expect(
        createHash("sha256")
          .update(readFileSync(dir + v.file))
          .digest("hex"),
        v.file,
      ).toBe(v.sha256);
      expect(existsSync(dir + v.licenceFile), v.licenceFile).toBe(true);
    }
  });
});
