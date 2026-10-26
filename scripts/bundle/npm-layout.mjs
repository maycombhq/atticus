// The layout of the one npm package Atticus installs from (ADR 0124 addendum D-npm2):
// @maycombhq/atticus, its workspace code and third-party JavaScript bundled by esbuild into
// dist/, and every file that code reads at run time copied into dist/ at the place it had in the
// repository, so each module's `import.meta.url` (and a CommonJS module's `__dirname`) points
// where the module was: dist/packages/<package>/... for Atticus's own, dist/vendor/<package>/...
// for a third party's. A lookup such as new URL("../rules/drift.yaml", import.meta.url) then
// finds the same file installed as it does in a checkout, with no change to the code.
// Pure functions only: scripts/bundle/npm-atticus.mjs builds the package with them, and
// packages/conformance/test/npm-layout.test.ts tests them.
import { builtinModules } from "node:module";
import { relative, sep } from "node:path";

/** The npm packages Atticus publishes; every other workspace package is private. */
export const PUBLIC_PACKAGES = [
  "@maycombhq/atticus",
  "@maycombhq/sdk",
  "@maycombhq/embed-model",
  "@maycombhq/onnxruntime-darwin-arm64",
  "@maycombhq/onnxruntime-linux-arm64",
  "@maycombhq/onnxruntime-linux-x64",
  "@maycombhq/onnxruntime-wasm",
  "@maycombhq/onnxruntime-win32-arm64",
  "@maycombhq/onnxruntime-win32-x64",
];

/**
 * Packages the bundle never takes in: the model and onnxruntime stay separate npm packages
 * (optionalDependencies of @maycombhq/atticus), found at run time with createRequire from where
 * npm put them.
 */
export const EXTERNAL = [
  "@maycombhq/embed-model",
  "@maycombhq/onnxruntime-*",
  "onnxruntime-common",
  "onnxruntime-node",
  "onnxruntime-web",
];

/**
 * Third-party files read at run time, not imported, copied into dist/vendor/<package>/: the
 * tree-sitter runtime's WebAssembly, the grammars Atticus parses with (`{lang}` for each of
 * extractors' SYNTAX_LANGUAGES but Groovy, which extractors vendors itself), and OpenSpec's own
 * package.json (it reads its version from it) and workflow schemas.
 */
export const VENDOR_FILES = {
  "web-tree-sitter": ["tree-sitter.wasm"],
  "tree-sitter-wasms": ["out/tree-sitter-{lang}.wasm"],
  "@fission-ai/openspec": ["package.json", "schemas"],
};

/** Repository folders the CLI reads (the Forge practice fixtures for `atticus sandbox create`). */
export const REPO_FILES = ["fixtures/forge", "fixtures/forge-change"];

const posix = (p) => p.split(sep).join("/").replace(/\\/g, "/");

/** The package a file under node_modules belongs to, and the file's path inside it. */
export function nodeModulesPackage(file) {
  const p = posix(file);
  const at = p.lastIndexOf("/node_modules/");
  if (at < 0) return undefined;
  const parts = p.slice(at + "/node_modules/".length).split("/");
  const n = parts[0].startsWith("@") ? 2 : 1;
  if (parts.length <= n) return undefined;
  return {
    name: parts.slice(0, n).join("/"),
    dir: p.slice(0, at + "/node_modules/".length) + parts.slice(0, n).join("/"),
    inner: parts.slice(n).join("/"),
  };
}

/**
 * Where a source file the bundle takes in sits inside dist/ (posix, relative): an Atticus file
 * at its path in the repository (packages/<dir>/...), a third party's at vendor/<name>/<path>.
 * Undefined for anything else.
 */
export function placeOf(file, repo) {
  const third = nodeModulesPackage(file);
  if (third) return `vendor/${third.name}/${third.inner}`;
  const rel = posix(relative(repo, file));
  return rel.startsWith("packages/") ? rel : undefined;
}

/**
 * What the bundle injects at the top of a module so its `import.meta.url`, `__filename` and
 * `__dirname` are the place it had (esbuild's `define` maps them to these names; the banner
 * defines __atticusUrl and __atticusPath against the bundle's own location). Nothing when the
 * module uses none of them. Kept after a hashbang and a "use strict" directive.
 */
export function injectPlace(text, place) {
  const meta = /\bimport\.meta\b/.test(text);
  const cjs = /\b__(dirname|filename)\b/.test(text);
  if (!meta && !cjs) return text;
  const dir = place.split("/").slice(0, -1).join("/");
  const decl = [
    meta ? `__atticus_import_meta_url = __atticusUrl(${JSON.stringify(place)})` : "",
    cjs ? `__atticus_filename = __atticusPath(${JSON.stringify(place)})` : "",
    cjs ? `__atticus_dirname = __atticusPath(${JSON.stringify(dir)})` : "",
  ].filter(Boolean);
  const head = /^(#![^\n]*\n)?(\s*(["'])use strict\3;?[^\S\n]*\n?)?/.exec(text)[0];
  return `${head}var ${decl.join(", ")};\n${text.slice(head.length)}`;
}

/**
 * A third party's ES module that makes its own `require` with createRequire(import.meta.url)
 * and loads a package with it (OpenSpec loads cross-spawn so): installed bundled, there is no
 * node_modules for that require to search. Each such load of a bare package name becomes a
 * static import the bundler takes in. Built-in modules and relative paths are left alone.
 */
export function inlineCreatedRequires(text) {
  if (!/\bcreateRequire\s*\(/.test(text) || !/^\s*(import|export)\s/m.test(text)) return text;
  const builtins = new Set(builtinModules);
  const imports = [];
  const out = text.replace(/\brequire\((["'])([^"'./][^"']*)\1\)/g, (all, _q, spec) => {
    const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
    if (spec.startsWith("node:") || builtins.has(name)) return all;
    const id = `__atticus_required_${imports.length}`;
    imports.push(`import ${id} from ${JSON.stringify(spec)};`);
    return id;
  });
  return imports.length ? `${imports.join("\n")}\n${out}` : text;
}

/**
 * The banner each output file starts with: `require` for the CommonJS modules inside (Node's,
 * from createRequire), and the bundle's root (`root`, relative to the output file, ending in /)
 * against which the places injectPlace writes resolve.
 */
export function banner(root) {
  return [
    'import { createRequire as __atticusCreateRequire } from "node:module";',
    'import { fileURLToPath as __atticusFileURLToPath } from "node:url";',
    "var require = __atticusCreateRequire(import.meta.url);",
    `var __atticusUrl = (p) => new URL(${JSON.stringify(root)} + p, import.meta.url).href;`,
    "var __atticusPath = (p) => __atticusFileURLToPath(__atticusUrl(p));",
  ].join("\n");
}

/**
 * The entries of a workspace package's `files` that the bundle copies: everything it published
 * but its compiled JavaScript (the folder its `main` is in), which the bundle replaces.
 */
export function assetEntries(manifest) {
  const main = (manifest.main ?? "./dist/index.js").replace(/^\.\//, "").split("/")[0];
  return (manifest.files ?? []).filter((f) => f.replace(/^\.\//, "").split("/")[0] !== main);
}

/** Whether a copied asset is left out: source maps and TypeScript declarations. */
export const skipAsset = (path) => /\.(map|d\.ts)$/.test(path);
