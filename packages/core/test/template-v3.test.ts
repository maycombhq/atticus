import { describe, expect, it } from "vitest";
import {
  Dialect,
  parseTemplate,
  renderTemplate,
  templateSources,
  type TemplateSource,
} from "../src/index.js";

describe("templates v3 (ADR 0058)", () => {
  it("parses a lookup whose key has filters of its own, and node values", () => {
    expect(templateSources("${lookup:basepaths(file.path | parent | parent).path}")).toEqual([
      {
        type: "lookup",
        table: "basepaths",
        key: {
          source: { type: "file", name: "path" },
          filters: [{ name: "parent" }, { name: "parent" }],
        },
        field: "path",
      },
      { type: "file", name: "path" },
    ]);
    expect(templateSources("${node.key}${node.up.name}${node.up.up.key}")).toEqual([
      { type: "node", up: 0, name: "key" },
      { type: "node", up: 1, name: "name" },
      { type: "node", up: 2, name: "key" },
    ]);
  });

  it("rejects malformed lookups and node values", () => {
    expect(() => parseTemplate("${lookup:t.host}")).toThrow(/lookup:<table>/);
    expect(() => parseTemplate("${lookup:t().host}")).toThrow(/lookup:<table>/);
    expect(() => parseTemplate("${node.name}")).toThrow(/node.key/);
  });

  it("renders parent and basename, and a lookup through the resolver", () => {
    const resolve = (s: TemplateSource) =>
      s.type === "file"
        ? "p/orders-api/apiproxy/targets/default.xml"
        : s.type === "lookup"
          ? `row(${s.table}.${s.field})`
          : undefined;
    expect(renderTemplate("${file.path | parent | parent | parent | basename}", resolve)).toBe(
      "orders-api",
    );
    expect(renderTemplate("${lookup:t(file.path | parent).host}", resolve)).toBe("row(t.host)");
    expect(renderTemplate("${file.path | basename | parent}", resolve)).toBe("");
  });

  it("checks a dialect's lookups and node values against its rules", () => {
    const base = {
      schemaVersion: 1,
      name: "t",
      version: "0.1.0",
      appliesTo: {},
      tests: [{ name: "t", files: {}, expect: [] }],
    };
    const rule = (match: unknown, target: string) => ({
      id: "r",
      description: "d",
      match,
      emit: { kind: "GatewayRoute", id: "r", fields: { proxy: "p", basepath: "/", target } },
      confidence: "verified",
    });
    const issues = (d: unknown) => {
      const r = Dialect.safeParse(d);
      return r.success ? [] : r.error.issues.map((i) => i.message);
    };
    expect(
      issues({ ...base, rules: [rule({ regex: "x", files: ["*"] }, "${lookup:nope(match.0).h}")] }),
    ).toContain("lookup nope isn't declared under lookups");
    expect(
      issues({ ...base, rules: [rule({ regex: "x", files: ["*"] }, "${node.up.url}")] }),
    ).toContain("${node...} needs an xpath, jsonPath or hclBlock match");
    expect(
      issues({
        ...base,
        lookups: {
          a: {
            match: { regex: "x", files: ["*"] },
            key: "${match.0}",
            values: { v: "${lookup:b(match.0).v}" },
          },
          b: {
            match: { regex: "x", files: ["*"] },
            key: "${match.0}",
            values: { v: "${match.0}" },
          },
        },
        rules: [rule({ jsonPath: "$.a", files: ["*"] }, "${lookup:a(node.key).v}")],
      }),
    ).toEqual(["a lookup's templates can't use another lookup"]);
  });
});
