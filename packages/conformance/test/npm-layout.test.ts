import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * ADR 0124 addendum D-npm2: Atticus is published as one package, @maycombhq/atticus, with its
 * workspace code and third-party JavaScript bundled by esbuild, and every module keeping its
 * place (dist/packages/<dir>/... for Atticus's own, dist/vendor/<name>/... for a third party's)
 * so the files it reads at run time are found as in a checkout. These are the rules of that
 * layout (scripts/bundle/npm-layout.mjs), on invented inputs, and the SDK's published layout
 * (packages/sdk/npm, built with the SDK), which depends on no other Atticus package.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../../..");
interface Layout {
  PUBLIC_PACKAGES: string[];
  placeOf: (file: string, repo: string) => string | undefined;
  nodeModulesPackage: (file: string) => { name: string; dir: string; inner: string } | undefined;
  injectPlace: (text: string, place: string) => string;
  inlineCreatedRequires: (text: string) => string;
  banner: (root: string) => string;
  assetEntries: (m: { main?: string; files?: string[] }) => string[];
  skipAsset: (path: string) => boolean;
}
const load = async () =>
  (await import(pathToFileURL(join(REPO, "scripts/bundle/npm-layout.mjs")).href)) as Layout;

describe("the bundled package's layout (ADR 0124 addendum D-npm2)", () => {
  it("puts each module at its place: Atticus's at its repository path, a third party's under vendor/", async () => {
    const { placeOf, nodeModulesPackage } = await load();
    const repo = "/r";
    expect(placeOf("/r/packages/naysayer/dist/rules.js", repo)).toBe(
      "packages/naysayer/dist/rules.js",
    );
    expect(
      placeOf(
        "/r/node_modules/.pnpm/web-tree-sitter@0.22.6/node_modules/web-tree-sitter/tree-sitter.js",
        repo,
      ),
    ).toBe("vendor/web-tree-sitter/tree-sitter.js");
    expect(
      placeOf(
        "/r/node_modules/.pnpm/@fission-ai+openspec@1.14.0/node_modules/@fission-ai/openspec/dist/cli/index.js",
        repo,
      ),
    ).toBe("vendor/@fission-ai/openspec/dist/cli/index.js");
    expect(placeOf("/elsewhere/x.js", repo)).toBeUndefined();
    expect(nodeModulesPackage("C:\\r\\node_modules\\@scope\\pkg\\lib\\a.js")).toEqual({
      name: "@scope/pkg",
      dir: "C:/r/node_modules/@scope/pkg",
      inner: "lib/a.js",
    });
  });

  it("gives a module that reads import.meta.url or __dirname its place, after a hashbang and use strict", async () => {
    const { injectPlace } = await load();
    expect(injectPlace("export const a = 1;\n", "packages/x/dist/a.js")).toBe(
      "export const a = 1;\n",
    );
    const esm = injectPlace(
      '#!/usr/bin/env node\nconst u = new URL("../rules/r.yaml", import.meta.url);\n',
      "packages/speckit/dist/rounds.js",
    );
    expect(esm).toBe(
      '#!/usr/bin/env node\nvar __atticus_import_meta_url = __atticusUrl("packages/speckit/dist/rounds.js");\nconst u = new URL("../rules/r.yaml", import.meta.url);\n',
    );
    const cjs = injectPlace(
      '"use strict";\nmodule.exports = __dirname;\n',
      "vendor/web-tree-sitter/tree-sitter.js",
    );
    expect(cjs).toBe(
      '"use strict";\nvar __atticus_filename = __atticusPath("vendor/web-tree-sitter/tree-sitter.js"), __atticus_dirname = __atticusPath("vendor/web-tree-sitter");\nmodule.exports = __dirname;\n',
    );
  });

  it("turns a third party's createRequire'd load of a package into an import the bundler takes in", async () => {
    const { inlineCreatedRequires } = await load();
    const text = [
      "import { createRequire } from 'module';",
      "const require = createRequire(import.meta.url);",
      "const { version } = require('../../package.json');",
      "const fs = require('fs');",
      "const p = require('node:path');",
      "let spawn = require('cross-spawn');",
    ].join("\n");
    const out = inlineCreatedRequires(text);
    expect(out.split("\n")[0]).toBe('import __atticus_required_0 from "cross-spawn";');
    expect(out).toContain("let spawn = __atticus_required_0;");
    expect(out).toContain("require('../../package.json')");
    expect(out).toContain("require('fs')");
    expect(out).toContain("require('node:path')");
    // CommonJS (no import or export): the bundler handles its require itself.
    const cjs = "const { createRequire } = require('module');\nrequire('cross-spawn');\n";
    expect(inlineCreatedRequires(cjs)).toBe(cjs);
  });

  it("starts every output file with Node's require and the bundle's root", async () => {
    const { banner } = await load();
    const b = banner("../../");
    expect(b).toContain("var require = __atticusCreateRequire(import.meta.url);");
    expect(b).toContain('new URL("../../" + p, import.meta.url)');
  });

  it("copies what each package publishes but its compiled code, without maps or declarations", async () => {
    const { assetEntries, skipAsset } = await load();
    expect(
      assetEntries({ main: "./dist/index.js", files: ["dist", "constitution", "starter"] }),
    ).toEqual(["constitution", "starter"]);
    expect(assetEntries({ main: "./dist-lib/index.js", files: ["dist", "dist-lib"] })).toEqual([
      "dist",
    ]);
    expect(assetEntries({ files: ["dist"] })).toEqual([]);
    for (const p of ["a/index.js.map", "a/b.d.ts"]) expect(skipAsset(p)).toBe(true);
    for (const p of ["a/index.html", "a/rules.yaml"]) expect(skipAsset(p)).toBe(false);
  });

  it("assetEntries holds the repo's packages to what they read: rules, schemas, kits, the app", async () => {
    const { assetEntries } = await load();
    const m = (d: string) =>
      JSON.parse(readFileSync(join(REPO, "packages", d, "package.json"), "utf8")) as {
        main?: string;
        files?: string[];
      };
    expect(assetEntries(m("naysayer"))).toEqual(["constitution", "starter"]);
    expect(assetEntries(m("ui"))).toEqual(["dist"]);
    expect(assetEntries(m("learn"))).toEqual(["lessons"]);
    expect(assetEntries(m("extractors"))).toEqual(["dialects", "grammars"]);
  });
});

describe("the offline bundle's deploy of a package npm publishes bundled (ADR 0124 addendum D-npm2)", () => {
  it("takes its compiled folder from the workspace, so the bundle runs one copy of the core", async () => {
    const { workspaceShaped } = (await import(
      pathToFileURL(join(REPO, "scripts/bundle/inventory.mjs")).href
    )) as { workspaceShaped: (deployDir: string, repo: string) => string[] };
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const root = mkdtempSync(join(tmpdir(), "atticus-shaped-"));
    const repo = join(root, "repo");
    const put = (f: string, text: string) => {
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, text);
    };
    const manifest = (name: string, extra: object) =>
      JSON.stringify({ name, main: "./dist/index.js", files: ["npm"], ...extra });
    put(
      join(repo, "packages/sdk/package.json"),
      manifest("@maycombhq/sdk", { atticusBundled: true }),
    );
    put(join(repo, "packages/sdk/dist/index.js"), 'export * from "./plugin.js";');
    put(join(repo, "packages/sdk/dist/plugin.js"), "export const p = 1;");
    put(join(repo, "packages/sdk/dist/plugin.js.map"), "{}");
    put(join(repo, "packages/core/package.json"), manifest("@maycombhq/core", {}));
    // What pnpm deploy left: npm's file list (npm/) and `main` itself, not the rest of dist/.
    const deployed = join(root, "deploy");
    put(
      join(deployed, "node_modules/@maycombhq/sdk/dist/index.js"),
      'export * from "./plugin.js";',
    );
    put(join(deployed, "node_modules/@maycombhq/core/dist/index.js"), "");
    expect(workspaceShaped(deployed, repo)).toEqual(["@maycombhq/sdk"]);
    expect(existsSync(join(deployed, "node_modules/@maycombhq/sdk/dist/plugin.js"))).toBe(true);
    expect(existsSync(join(deployed, "node_modules/@maycombhq/sdk/dist/plugin.js.map"))).toBe(
      false,
    );
  });
});

describe("the SDK as npm publishes it (C4; ADR 0124 addendum D-npm2)", () => {
  const npm = join(REPO, "packages/sdk/npm");
  const files = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(join(d, e.name)) : [join(d, e.name)],
    );

  it("is built with the SDK and imports no other Atticus package", () => {
    expect(existsSync(join(npm, "index.js")), "build the SDK first (pnpm build)").toBe(true);
    // Module specifiers: import/export ... from "x", import "x", import("x").
    const imports = (text: string) =>
      [
        ...text.matchAll(
          /^\s*(?:import|export)\b[^"';]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gm,
        ),
      ]
        .map((m) => m[1] ?? m[2] ?? m[3]!)
        .filter((s) => !s.startsWith("."));
    const js = imports(readFileSync(join(npm, "index.js"), "utf8"));
    expect(js.filter((s) => !s.startsWith("node:"))).toEqual(
      expect.arrayContaining(["zod", "yaml"]),
    );
    expect(
      js.every((s) => s.startsWith("node:") || s === "zod" || s === "yaml"),
      js.join(),
    ).toBe(true);
    for (const f of files(npm).filter((f) => f.endsWith(".d.ts")))
      expect(
        imports(readFileSync(f, "utf8")).filter((s) => s.startsWith("@maycombhq/")),
        f,
      ).toEqual([]);
  });

  it("publishes npm/ only, and its types compile for a plugin author", () => {
    const m = JSON.parse(readFileSync(join(REPO, "packages/sdk/package.json"), "utf8")) as {
      files: string[];
      dependencies: Record<string, string>;
      publishConfig: { main: string; types: string };
    };
    expect(m.files).toEqual(["npm"]);
    expect(Object.keys(m.dependencies).sort()).toEqual(["yaml", "zod"]);
    expect(m.publishConfig).toMatchObject({ main: "./npm/index.js", types: "./npm/index.d.ts" });
    const program = ts.createProgram([join(npm, "index.d.ts")], {
      strict: true,
      noEmit: true,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
      types: ["node"],
      typeRoots: [join(REPO, "node_modules/@types")],
    });
    const errors = ts
      .getPreEmitDiagnostics(program)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    expect(errors).toEqual([]);
  }, 120_000);
});
