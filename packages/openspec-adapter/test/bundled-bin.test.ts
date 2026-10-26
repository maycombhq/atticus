import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { bundledOpenSpecBin } from "../src/index.js";

/**
 * ADR 0124 addendum D-npm2: installed from npm, Atticus is one bundled package
 * (@maycombhq/atticus) and OpenSpec is bundled into it as a program of its own, at
 * dist/vendor/@fission-ai/openspec/bin/openspec.js; the adapter's module keeps its place,
 * dist/packages/openspec-adapter/dist/adapter.js. The adapter runs that copy, and in a checkout
 * (no such file) the pinned @fission-ai/openspec from node_modules.
 */
describe("which OpenSpec CLI the adapter runs (ADR 0124 addendum D-npm2)", () => {
  it("runs the copy the bundled package carries in vendor/", () => {
    const root = mkdtempSync(join(tmpdir(), "atticus-openspec-bin-"));
    const bin = join(root, "vendor/@fission-ai/openspec/bin/openspec.js");
    mkdirSync(join(bin, ".."), { recursive: true });
    writeFileSync(bin, "// invented");
    const here = pathToFileURL(join(root, "packages/openspec-adapter/dist/adapter.js")).href;
    expect(bundledOpenSpecBin(here)).toBe(bin);
  });

  it("runs the installed package where there is no such copy (a checkout)", () => {
    const root = mkdtempSync(join(tmpdir(), "atticus-openspec-bin-"));
    const here = pathToFileURL(join(root, "packages/openspec-adapter/dist/adapter.js")).href;
    const expected = `${sep}@fission-ai${sep}openspec${sep}bin${sep}openspec.js`;
    expect(bundledOpenSpecBin(here)).toContain(expected);
    expect(bundledOpenSpecBin()).toContain(`${sep}node_modules${sep}`);
  });
});
