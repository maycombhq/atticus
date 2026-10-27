// A bundled npm package's manifest as it is published (ADR 0124 addendum D-npm2): its
// devDependencies name the workspace packages it is built from (@maycombhq/cli,
// @maycombhq/extractors, @maycombhq/core), which are private and not on npm, so they are left out
// of the packed package.json. Run from the package's folder by its prepack (`strip`) and postpack
// (`restore`) scripts; `strip` keeps the manifest as it was in package.json.packing, and a
// `strip` that finds one left by a pack that stopped half way restores it first.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.cwd();
const manifest = join(dir, "package.json");
const kept = join(dir, "package.json.packing");
const what = process.argv[2];

if (what === "strip") {
  if (existsSync(kept)) renameSync(kept, manifest);
  const text = readFileSync(manifest, "utf8");
  const m = JSON.parse(text);
  writeFileSync(kept, text);
  delete m.devDependencies;
  writeFileSync(manifest, `${JSON.stringify(m, null, 2)}\n`);
} else if (what === "restore") {
  if (existsSync(kept)) renameSync(kept, manifest);
} else {
  console.error("Usage: node pack-manifest.mjs strip|restore (from a package's folder)");
  process.exit(2);
}
