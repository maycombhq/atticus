import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import { describe, expect, it } from "vitest";
import { CONCEPTS, GENERATED_NOTE, SPEC_VERSION, docComments, specPages } from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC = join(HERE, "../../../docs/spec");

describe("the published specification", () => {
  it("matches the committed pages in docs/spec (run pnpm spec:doc after changing a schema)", async () => {
    const pages = specPages();
    expect(Object.keys(pages).sort()).toEqual([
      "README.md",
      "contracts/c1-catalog-records.md",
      "contracts/c2-dialects.md",
      "contracts/c3-rules-and-findings.md",
      "contracts/c4-plugins-workspace-and-api.md",
      "contracts/c5-ai-runtime.md",
      "contracts/c6-org-pack.md",
    ]);
    for (const [path, text] of Object.entries(pages)) {
      const file = join(SPEC, path);
      const options = (await resolveConfig(file)) ?? {};
      const want = await format(text, { ...options, parser: "markdown" });
      expect(readFileSync(file, "utf8"), path).toBe(want);
      expect(want.startsWith(GENERATED_NOTE)).toBe(true);
    }
  });

  it("is versioned in docs/spec/VERSION, which the conformance suite reports", () => {
    expect(readFileSync(join(SPEC, "VERSION"), "utf8").trim()).toBe(SPEC_VERSION);
  });

  it("has every hand-written concept page the index links to", () => {
    for (const c of CONCEPTS) {
      const file = join(SPEC, "concepts", c.file);
      expect(existsSync(file), c.file).toBe(true);
      expect(readFileSync(file, "utf8").startsWith(`# ${c.title}\n`), c.file).toBe(true);
    }
  });

  it("documents the ADR 0040 vocabulary from the schema's own comments", () => {
    const c1 = specPages()["contracts/c1-catalog-records.md"]!;
    for (const v of [
      "`graphql`",
      "`websocket`",
      "`sse`",
      "`webhook`",
      "`function`",
      "`transaction`",
      "`mesh`",
      "`schedule`",
    ])
      expect(c1).toContain(v);
    expect(c1).toContain(
      "| `ingress[].tls` | boolean | no |  | True when the route terminates TLS. |",
    );
    expect(c1).toContain("`feature-store`");
  });

  it("reads doc comments by export and nested field path", () => {
    const src = [
      "/** The thing. */",
      "export const Thing = z.strictObject({",
      "  /** Its name. */",
      "  name: z.string(),",
      "  inner: z",
      "    .strictObject({",
      "      /** Deep. */",
      "      deep: z.string(),",
      "    }),",
      "  /** After inner. */",
      "  after: z.string(),",
      "});",
      "const helper = 1;",
      "/** Orphan. */",
      "export const Other = z.string();",
    ].join("\n");
    const d = docComments(src);
    expect(d.get("Thing")?.doc).toBe("The thing.");
    expect([...d.get("Thing")!.fields]).toEqual([
      ["name", "Its name."],
      ["inner.deep", "Deep."],
      ["after", "After inner."],
    ]);
    expect(d.get("Other")?.doc).toBe("Orphan.");
  });

  it("names no vendor or company in the hand-written prose", () => {
    const words =
      /\b(aws|azure|gcp|google|amazon|microsoft|oracle|ibm|jira|servicenow|github|gitlab|bitbucket|kafka|apigee|kong|spring|openshift|istio|linkerd|bank)\b/i;
    for (const c of CONCEPTS) {
      const text = readFileSync(join(SPEC, "concepts", c.file), "utf8");
      const hits = text
        .split("\n")
        .filter((l) => words.test(l) && !/\(example\)|for example/i.test(l));
      expect(hits, c.file).toEqual([]);
    }
  });
});
