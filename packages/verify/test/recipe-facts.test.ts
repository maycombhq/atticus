import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { ReadingRulesFile, runRecipe, type RecipeFile } from "@maycombhq/core";
import { verifyFacts, type FileSource } from "../src/index.js";

/**
 * ADR 0210 part 2: a recipe's facts are checked by the verifier as any other: each cite's value
 * on its line, each part of a path on the line or a `with` line. The invented
 * `fixtures/gateway-shape` modules, read by the fixture's recipe.
 */
const FIX = join(__dirname, "..", "..", "..", "fixtures", "gateway-shape");
const filesOf = (repo: string): RecipeFile[] => {
  const root = join(FIX, "repos", repo);
  const out: RecipeFile[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.push({ path: relative(root, p).replace(/\\/g, "/"), text: readFileSync(p, "utf8") });
    }
  };
  walk(root);
  return out;
};
/** The fixture's `org-pack/reading-rules/types/integration-module.yaml`, as data (no YAML reader here). */
const rules = ReadingRulesFile.parse({
  schemaVersion: 3,
  rules: [
    {
      key: "blueprint-rest-entries",
      status: "draft",
      rule: "Each verb element under a <rest> block is an entry.",
      files: ["src/main/resources/OSGI-INF/blueprint/*.xml"],
      extract: {
        fact: "entry",
        pattern: '<(?<verb>get|post|put|delete|patch)(?: uri="(?<uri>[^"]*)")?',
        scopes: [
          { name: "context", pattern: 'contextPath="(?<context>[^"]*)"' },
          { name: "rest", pattern: '<rest path="(?<rest>[^"]*)"', end: "</rest>" },
        ],
        optional: ["uri"],
        fields: { method: "{verb}", path: "{context}{rest}{uri}" },
      },
    },
    {
      key: "deploy-settings",
      status: "draft",
      rule: "Each leaf key of a deploy file is a setting.",
      files: ["deploy/*.yaml"],
      extract: { fact: "config", yaml: "leaves" },
    },
  ],
}).rules;

describe("a recipe's facts pass the verifier (ADR 0210 part 2)", () => {
  for (const repo of ["forge-wallets-module", "forge-ledger-module"])
    it(repo, async () => {
      const files = filesOf(repo);
      const facts = rules.flatMap((r) => runRecipe(r, files, { repo, commit: "5d6e7f8" }));
      const byPath = new Map(files.map((f) => [f.path, f.text]));
      const source: FileSource = { list: () => [...byPath.keys()], read: (p) => byPath.get(p) };
      const r = await verifyFacts({ facts, source, commit: "5d6e7f8" });
      expect(r.rejected).toEqual([]);
      expect(r.accepted.length).toBe(facts.length);
    });
});
