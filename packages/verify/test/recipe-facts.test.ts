import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
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
const rules = ReadingRulesFile.parse(
  parse(
    readFileSync(
      join(FIX, "org-pack", "reading-rules", "types", "integration-module.yaml"),
      "utf8",
    ),
  ),
).rules;

describe("a recipe's facts pass the verifier (ADR 0210 part 2)", () => {
  for (const repo of ["forge-wallets-module", "forge-ledger-module"])
    it(repo, async () => {
      const files = filesOf(repo);
      const facts = rules.flatMap((r) => runRecipe(r, files, { repo, commit: "5d6e7f8" }).facts);
      const byPath = new Map(files.map((f) => [f.path, f.text]));
      const source: FileSource = { list: () => [...byPath.keys()], read: (p) => byPath.get(p) };
      const r = await verifyFacts({ facts, source, commit: "5d6e7f8" });
      expect(r.rejected).toEqual([]);
      expect(r.accepted.length).toBe(facts.length);
    });
});
