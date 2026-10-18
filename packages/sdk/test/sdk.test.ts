import { describe, expect, it } from "vitest";
import { defineExtractor, globToRegExp, memoryRepo, runExtractor } from "../src/index.js";

describe("globToRegExp", () => {
  it("handles ** across folders, * within one, and ?", () => {
    expect(globToRegExp("**/*.java").test("src/a/B.java")).toBe(true);
    expect(globToRegExp("**/*.java").test("B.java")).toBe(true);
    expect(globToRegExp("src/*.yml").test("src/a/b.yml")).toBe(false);
    expect(globToRegExp("src/?.yml").test("src/a.yml")).toBe(true);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
  });
});

describe("defineExtractor", () => {
  const ok = { id: "demo", version: "0.1.0", claims: ["**/*.yaml"], scan: async function* () {} };
  it("accepts a well-formed extractor", () => {
    expect(defineExtractor(ok).id).toBe("demo");
  });
  it("rejects bad ids, versions and empty claims", () => {
    expect(() => defineExtractor({ ...ok, id: "Demo" })).toThrow();
    expect(() => defineExtractor({ ...ok, version: "1" })).toThrow();
    expect(() => defineExtractor({ ...ok, claims: [] })).toThrow();
  });
});

describe("runExtractor", () => {
  it("keeps valid records, rejects invalid ones and collects warnings", async () => {
    const extractor = defineExtractor({
      id: "systems",
      version: "0.1.0",
      claims: ["systems/*.txt"],
      async *scan(repo, ctx) {
        for await (const path of repo.listFiles(this.claims)) {
          const name = (await repo.readText(path)).trim();
          if (name === "") {
            ctx.warn("empty file", path);
            continue;
          }
          yield {
            schemaVersion: 1,
            kind: "System",
            id: name.toLowerCase(),
            status: "current",
            confidence: "verified",
            evidence: [
              {
                source: "code",
                repo: repo.name,
                path,
                commit: repo.commit,
                extractor: "systems@0.1.0",
              },
            ],
            name,
            boundary: "product",
            repos: [repo.name],
            tags: [],
            accessGroup: "everyone",
          };
        }
      },
    });
    const repo = memoryRepo("forge-demo", "abc1234", {
      "systems/a.txt": "Ledger",
      "systems/b.txt": "Not A Slug!",
      "systems/c.txt": "  ",
      "README.md": "ignored",
    });
    const result = await runExtractor(extractor, repo, { scannedAt: "2026-10-18T00:00:00Z" });
    expect(result.records.map((r) => r.id)).toEqual(["ledger"]);
    expect(result.rejected).toHaveLength(1);
    expect(result.warnings).toEqual([{ message: "empty file", path: "systems/c.txt" }]);
  });
});
