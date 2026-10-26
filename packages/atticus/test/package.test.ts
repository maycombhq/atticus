import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SYNTAX_LANGUAGES } from "@maycombhq/extractors";
import { VERSION } from "@maycombhq/cli/dist/version.js";

/**
 * ADR 0124 addendum D-npm2: @maycombhq/atticus is the one package Atticus installs from. Built
 * by scripts/bundle/npm-atticus.mjs: the command line bundled into dist/, and every file it reads
 * at run time at the place it had in the repository. This checks the built package: what it
 * carries, that it lists every file with its sha256, its licences, and that it runs.
 */

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(PKG, "dist");
const files = (d: string): string[] =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(d, e.name)) : [join(d, e.name)],
  );
const rel = (f: string) => relative(PKG, f).split("\\").join("/");
const manifest = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")) as {
  version: string;
};

describe("@maycombhq/atticus as built (ADR 0124 addendum D-npm2)", () => {
  it("runs: atticus --version is this version", () => {
    const r = spawnSync(process.execPath, [join(DIST, "bin.js"), "--version"], {
      encoding: "utf8",
    });
    expect(r.stdout.trim()).toBe(manifest.version);
    expect(VERSION).toBe(manifest.version);
    expect(readFileSync(join(DIST, "bin.js"), "utf8").startsWith("#!/usr/bin/env node\n")).toBe(
      true,
    );
  });

  it("carries what the command line reads at run time, each at its place", () => {
    const want = [
      "dist/packages/ui/dist/index.html",
      "dist/packages/naysayer/constitution/constitution.yaml",
      "dist/packages/naysayer/starter/review.yaml",
      "dist/packages/speckit/rules/drift.yaml",
      "dist/packages/taskrun/rules/conform.yaml",
      "dist/packages/testgen/rules/trace.yaml",
      "dist/packages/executors/reference/reference-executor.mjs",
      "dist/packages/extractors/grammars/tree-sitter-groovy.wasm",
      "dist/packages/learn/lessons",
      "dist/packages/assistant-kit/kit",
      "dist/packages/conformance/sample",
      "dist/fixtures/forge/README.md",
      "dist/fixtures/forge-change",
      "dist/vendor/@fission-ai/openspec/bin/openspec.js",
      "dist/vendor/@fission-ai/openspec/package.json",
      "dist/vendor/@fission-ai/openspec/schemas",
      "dist/vendor/web-tree-sitter/tree-sitter.wasm",
      ...SYNTAX_LANGUAGES.filter((l) => l !== "groovy").map(
        (l) => `dist/vendor/tree-sitter-wasms/out/tree-sitter-${l}.wasm`,
      ),
    ];
    for (const f of want) expect(existsSync(join(PKG, f)), f).toBe(true);
    // Compiled code only as the bundle: no source maps, declarations or packages' own dist JS
    // (the app's web files are the browser's, not Node's).
    const all = files(DIST).map(rel);
    expect(all.filter((f) => /\.(map|d\.ts)$/.test(f))).toEqual([]);
    expect(
      all.filter((f) => /^dist\/packages\/(?!ui\/)[^/]+\/dist(-lib)?\/.*\.js$/.test(f)),
    ).toEqual([]);
  });

  it("imports no other Atticus package but the model and onnxruntime, which it finds at run time", () => {
    for (const f of files(DIST).filter((f) => /\.m?js$/.test(f) && !f.includes("/fixtures/"))) {
      const text = readFileSync(f, "utf8");
      const specs = [
        ...text.matchAll(/^\s*(?:import|export)\b[^"';]*?\bfrom\s*["'](@maycombhq\/[^"']+)["']/gm),
        ...text.matchAll(/\bimport\(\s*["'](@maycombhq\/[^"']+)["']/g),
      ].map((m) => m[1]);
      expect(specs, rel(f)).toEqual([]);
    }
  });

  it("lists every file it carries with its sha256 (the pack check reads it)", () => {
    const listed = (
      JSON.parse(readFileSync(join(DIST, "files.json"), "utf8")) as {
        files: { path: string; sha256: string }[];
      }
    ).files;
    const want = [
      ...files(DIST)
        .map(rel)
        .filter((f) => f !== "dist/files.json"),
      "THIRD-PARTY-LICENSES.txt",
    ].sort();
    expect(listed.map((f) => f.path).sort()).toEqual(want);
    for (const f of listed.slice(0, 50))
      expect(
        createHash("sha256")
          .update(readFileSync(join(PKG, f.path)))
          .digest("hex"),
      ).toBe(f.sha256);
  });

  it("holds every bundled third party's licence in THIRD-PARTY-LICENSES.txt", () => {
    const third = JSON.parse(readFileSync(join(DIST, "third-party.json"), "utf8")) as {
      name: string;
      version: string;
      licence: string;
      licenceText: boolean;
    }[];
    const txt = readFileSync(join(PKG, "THIRD-PARTY-LICENSES.txt"), "utf8");
    const names = third.map((t) => t.name);
    // The CLI's own (yaml, zod, undici), the parser's, OpenSpec and its dependencies, the app's.
    for (const n of ["yaml", "zod", "undici", "web-tree-sitter", "tree-sitter-wasms"])
      expect(names).toContain(n);
    for (const n of ["@fission-ai/openspec", "commander", "react", "@xyflow/react", "elkjs"])
      expect(names).toContain(n);
    expect(names).toContain("tree-sitter-groovy");
    for (const t of third) expect(txt).toContain(`${t.name}@${t.version} (${t.licence})`);
    expect(names.filter((n) => n.startsWith("@maycombhq/"))).toEqual([]);
  });
});
