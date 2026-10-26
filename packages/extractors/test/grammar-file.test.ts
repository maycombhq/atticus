import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { grammarFile } from "../src/lang/syntax.js";

/**
 * ADR 0124 addendum D-npm2: installed from npm, Atticus is one bundled package
 * (@maycombhq/atticus) with no node_modules for tree-sitter-wasms. Each bundled module keeps its
 * place (dist/packages/extractors/dist/lang/syntax.js), and the grammars it parses with are
 * copied to dist/vendor/tree-sitter-wasms/out/. The lookup prefers that copy, and in a checkout
 * (no such folder) takes the installed package.
 */
describe("where a grammar's WebAssembly is (ADR 0124 addendum D-npm2)", () => {
  // An installed @maycombhq/atticus, invented: syntax.js's place and the vendored grammars.
  const root = mkdtempSync(join(tmpdir(), "atticus-grammar-"));
  const here = pathToFileURL(join(root, "packages/extractors/dist/lang/syntax.js")).href;
  const vendored = join(root, "vendor/tree-sitter-wasms/out");
  mkdirSync(vendored, { recursive: true });
  writeFileSync(join(vendored, "tree-sitter-java.wasm"), "invented");

  it("takes the copy the bundled package carries in vendor/", () => {
    expect(grammarFile("java", here)).toBe(join(vendored, "tree-sitter-java.wasm"));
  });

  it("takes tree-sitter-wasms from node_modules where there is no such copy (a checkout)", () => {
    expect(grammarFile("python", here)).toContain(
      `${sep}tree-sitter-wasms${sep}out${sep}tree-sitter-python.wasm`,
    );
    expect(grammarFile("java")).toContain(`${sep}node_modules${sep}`);
  });

  it("finds Groovy's, which extractors vendors itself, beside the module", () => {
    expect(grammarFile("groovy", here)).toBe(
      join(root, "packages/extractors/grammars/tree-sitter-groovy.wasm"),
    );
    expect(grammarFile("groovy")).toMatch(/extractors[\\/]grammars[\\/]tree-sitter-groovy\.wasm$/);
  });
});
