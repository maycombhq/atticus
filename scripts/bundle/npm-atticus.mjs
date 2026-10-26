// node ../../scripts/bundle/npm-atticus.mjs   (packages/atticus's build; needs the CLI built)
// Builds @maycombhq/atticus, the one npm package Atticus installs from (ADR 0124 addendum D-npm2):
//   dist/bin.js (and its chunks)   the command line: every workspace package it needs and their
//                                  third-party JavaScript, bundled by esbuild
//   dist/vendor/@fission-ai/openspec/bin/openspec.js   OpenSpec, bundled the same way: Atticus
//                                  runs it as its own process
//   dist/packages/<dir>/...        what Atticus's packages read at run time (their `files` but
//                                  the compiled code: rules, the constitution, the org-pack and
//                                  JSON schemas, the assistant kits, lessons, the app's web files)
//   dist/vendor/<package>/...      what third-party code reads (tree-sitter's WebAssembly and the
//                                  grammars, OpenSpec's package.json and schemas)
//   dist/fixtures/forge*           the Forge practice fixtures (`atticus sandbox create`)
//   dist/third-party.json, THIRD-PARTY-LICENSES.txt   every third party inside, its licence
//   dist/files.json                every file the package carries, with its sha256 (the pack
//                                  check holds the tarball to it)
// The model and onnxruntime stay separate packages (optionalDependencies), found at run time.
// Each bundled module keeps its place (scripts/bundle/npm-layout.mjs), so the code is unchanged.
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { FONT_ALLOWED, licenceAllowed, licenceOf, licenceText } from "./inventory.mjs";
import {
  assetEntries,
  banner,
  EXTERNAL,
  inlineCreatedRequires,
  injectPlace,
  nodeModulesPackage,
  placeOf,
  REPO_FILES,
  skipAsset,
  VENDOR_FILES,
} from "./npm-layout.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const PKG = join(REPO, "packages", "atticus");
const DIST = join(PKG, "dist");
const read = (f) => JSON.parse(readFileSync(f, "utf8"));

/** A package's folder as the workspace package `from` (a folder) resolves it. */
function packageDirFrom(name, from) {
  const req = createRequire(join(from, "package.json"));
  try {
    return dirname(req.resolve(`${name}/package.json`));
  } catch {
    // Its exports leave out package.json: find the folder through its entry.
    return nodeModulesPackage(req.resolve(name)).dir;
  }
}

const cliBin = join(REPO, "packages/cli/dist/bin.js");
if (!existsSync(cliBin)) {
  console.error("packages/cli isn't built: run pnpm build (turbo builds it before this).");
  process.exit(1);
}
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

/** esbuild plugin: each module keeps its place (import.meta.url, __dirname). */
const keepPlaces = {
  name: "atticus-places",
  setup(b) {
    b.onLoad({ filter: /\.[cm]?js$/ }, (args) => {
      const place = placeOf(args.path, REPO);
      let text = readFileSync(args.path, "utf8");
      if (!place) return { contents: text, loader: "js" };
      if (place.startsWith("vendor/")) text = inlineCreatedRequires(text);
      return { contents: injectPlace(text, place), loader: "js", resolveDir: dirname(args.path) };
    });
  },
};

const common = {
  absWorkingDir: REPO, // the metafile's paths are relative to it
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: EXTERNAL,
  define: {
    "import.meta.url": "__atticus_import_meta_url",
    __dirname: "__atticus_dirname",
    __filename: "__atticus_filename",
  },
  plugins: [keepPlaces],
  metafile: true,
  legalComments: "none",
  logLevel: "warning",
  logOverride: { "empty-import-meta": "silent" },
};

// ---- the command line
const main = await build({
  ...common,
  entryPoints: { bin: cliBin },
  outdir: DIST,
  splitting: true,
  // Beside bin.js: every output file's banner resolves places against dist/.
  chunkNames: "chunk-[hash]",
  banner: { js: banner("./") },
});

// ---- OpenSpec, a program of its own
const openspecPkg = packageDirFrom("@fission-ai/openspec", join(REPO, "packages/openspec-adapter"));
const openspecOut = join(DIST, "vendor/@fission-ai/openspec/bin");
const openspec = await build({
  ...common,
  entryPoints: { openspec: join(openspecPkg, "bin", "openspec.js") },
  outdir: openspecOut,
  banner: { js: banner("../../../../") },
});

// ---- what the code reads at run time
const inputs = [...Object.keys(main.metafile.inputs), ...Object.keys(openspec.metafile.inputs)].map(
  (i) => join(REPO, i),
);
const workspaceDirs = new Set();
const third = new Map(); // name@version -> { name, version, dir }
for (const i of inputs) {
  const t = nodeModulesPackage(i);
  if (t) {
    const m = read(join(t.dir, "package.json"));
    third.set(`${m.name}@${m.version}`, { name: m.name, version: m.version, dir: t.dir });
  } else {
    const rel = relative(REPO, i).split(/[\\/]/);
    if (rel[0] === "packages") workspaceDirs.add(rel[1]);
  }
}
// The app's web files are read, not imported: @maycombhq/ui's lib (bundled) serves them.
workspaceDirs.add("ui");
const copied = [];
for (const d of [...workspaceDirs].sort()) {
  const m = read(join(REPO, "packages", d, "package.json"));
  for (const f of assetEntries(m)) {
    const from = join(REPO, "packages", d, f);
    if (!existsSync(from)) continue;
    cpSync(from, join(DIST, "packages", d, f), {
      recursive: true,
      filter: (src) => !skipAsset(src),
    });
    copied.push(`packages/${d}/${f}`);
  }
}
const { SYNTAX_LANGUAGES } = await import(
  pathToFileURL(join(REPO, "packages/extractors/dist/lang/syntax.js")).href
);
const vendorFrom = {
  "web-tree-sitter": join(REPO, "packages/extractors"),
  "tree-sitter-wasms": join(REPO, "packages/extractors"),
  "@fission-ai/openspec": join(REPO, "packages/openspec-adapter"),
};
for (const [name, files] of Object.entries(VENDOR_FILES)) {
  const dir = packageDirFrom(name, vendorFrom[name]);
  const m = read(join(dir, "package.json"));
  third.set(`${m.name}@${m.version}`, { name: m.name, version: m.version, dir });
  const each = files.flatMap((f) =>
    f.includes("{lang}")
      ? SYNTAX_LANGUAGES.filter((l) => l !== "groovy").map((l) => f.replace("{lang}", l))
      : [f],
  );
  for (const f of each) {
    const from = join(dir, f);
    if (!existsSync(from)) throw new Error(`${name} has no ${f}`);
    cpSync(from, join(DIST, "vendor", name, f), { recursive: true });
  }
  copied.push(`vendor/${name} (${each.length} ${each.length === 1 ? "entry" : "entries"})`);
}
for (const f of REPO_FILES) {
  cpSync(join(REPO, f), join(DIST, f), { recursive: true });
  copied.push(f);
}

// ---- licences: every third party inside
// The app (packages/ui/dist) was bundled by Vite: its source maps name the packages inside, and
// its fonts are @fontsource's.
const uiAssets = join(REPO, "packages/ui/dist/assets");
const uiManifest = read(join(REPO, "packages/ui/package.json"));
const uiDir = join(REPO, "packages/ui");
for (const f of readdirSync(uiAssets).filter((f) => f.endsWith(".map"))) {
  for (const s of read(join(uiAssets, f)).sources ?? []) {
    const t = nodeModulesPackage(join(uiAssets, s));
    if (!t || !existsSync(join(t.dir, "package.json"))) continue;
    const m = read(join(t.dir, "package.json"));
    third.set(`${m.name}@${m.version}`, { name: m.name, version: m.version, dir: t.dir });
  }
}
const assets = readdirSync(uiAssets);
for (const name of Object.keys(uiManifest.devDependencies ?? {}).filter((n) =>
  n.startsWith("@fontsource/"),
)) {
  const family = name.split("/")[1];
  if (!assets.some((a) => a.startsWith(`${family}-`) && /\.woff2?$/.test(a))) continue;
  const dir = packageDirFrom(name, uiDir);
  const m = read(join(dir, "package.json"));
  third.set(`${m.name}@${m.version}`, { name: m.name, version: m.version, dir, font: true });
}
const items = [...third.values()]
  .filter((t) => !t.name.startsWith("@maycombhq/"))
  .map((t) => {
    const m = read(join(t.dir, "package.json"));
    return { ...t, licence: licenceOf(m), text: licenceText(t.dir) };
  });
// Files extractors vendors (the Groovy grammar), each with its own licence.
for (const v of read(join(REPO, "packages/extractors/grammars/vendored.json")))
  items.push({
    name: v.name,
    version: v.version,
    licence: v.licence,
    text: readFileSync(join(REPO, "packages/extractors/grammars", v.licenceFile), "utf8"),
  });
items.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
const bad = items.filter(
  (i) => !(licenceAllowed(i.licence) || (i.font && FONT_ALLOWED.has(i.licence))),
);
if (bad.length) {
  for (const i of bad)
    console.error(`${i.name}@${i.version}: licence ${i.licence ?? "not stated"} isn't allowed`);
  process.exit(1);
}
writeFileSync(
  join(DIST, "third-party.json"),
  `${JSON.stringify(
    items.map((i) => ({
      name: i.name,
      version: i.version,
      licence: i.licence,
      licenceText: Boolean(i.text),
      ...(i.font ? { font: true } : {}),
    })),
    null,
    2,
  )}\n`,
);
writeFileSync(
  join(PKG, "THIRD-PARTY-LICENSES.txt"),
  `Atticus (@maycombhq/atticus) is Apache-2.0 (LICENSE). It carries these third parties' code and\nfiles, bundled; each keeps its own licence, below.\n\n${items
    .map(
      (i) =>
        `${"=".repeat(72)}\n${i.name}@${i.version} (${i.licence})\n${"=".repeat(72)}\n${i.text ?? `Licensed under ${i.licence}; no licence file in the package.`}\n`,
    )
    .join("\n")}`,
);
cpSync(join(REPO, "LICENSE"), join(PKG, "LICENSE"));

// ---- every file it carries, with its sha256: the pack check finds each one in the tarball
const listed = [];
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const f = join(d, e.name);
    if (e.isDirectory()) walk(f);
    else listed.push(f);
  }
};
walk(DIST);
listed.push(join(PKG, "THIRD-PARTY-LICENSES.txt"));
let bytes = 0;
const files = listed.map((f) => {
  const b = readFileSync(f);
  bytes += b.length;
  return {
    path: relative(PKG, f).split("\\").join("/"),
    sha256: createHash("sha256").update(b).digest("hex"),
  };
});
writeFileSync(join(DIST, "files.json"), `${JSON.stringify({ files }, null, 1)}\n`);
console.log(
  `Built @maycombhq/atticus: ${files.length} files, ${(bytes / 1024 / 1024).toFixed(1)} MB; ${workspaceDirs.size} workspace packages and ${items.length} third parties inside; ${copied.length} folders of run-time files.`,
);
