// node scripts/model/fetch.mjs [<package folder>...] [--all] [--this-platform] [--check]
// Fills the packages that carry the embedding model and its runtime (ADR 0116 addendum) with
// their pinned files: each from its pinned source (an exact revision, or an entry of a pinned
// npm tarball), checked against the sha256 in the package's pins.json, through a cache by
// sha256 (.cache/pinned, or ATTICUS_PINNED_CACHE) so a second run downloads nothing. Run by each
// package's prepack (publishing), by `pnpm model:fetch` and by `pnpm bundle`; never at run time,
// in a test or in an install. --check only reads: it says which files are missing or wrong.
//   --all            every pinned package
//   --this-platform  the model, this machine's runtime and the WASM fallback
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CACHE, PINNED_PACKAGES, REPO } from "./paths.mjs";

const { materialize, checkMaterialized } = await import(
  pathToFileURL(join(REPO, "packages/embed/dist/index.js")).href
);

const args = process.argv.slice(2);
const check = args.includes("--check");
let dirs = args.filter((a) => !a.startsWith("--")).map((a) => resolve(a));
if (args.includes("--all")) dirs = PINNED_PACKAGES.map((p) => join(REPO, "packages", p));
if (args.includes("--this-platform"))
  dirs = ["embed-model", `onnxruntime-${process.platform}-${process.arch}`, "onnxruntime-wasm"]
    .filter((p) => PINNED_PACKAGES.includes(p))
    .map((p) => join(REPO, "packages", p));
if (!dirs.length) {
  console.error(
    "Usage: node scripts/model/fetch.mjs <package folder>... | --all | --this-platform [--check]",
  );
  process.exit(2);
}
let bad = 0;
for (const dir of dirs) {
  const f = join(dir, "pins.json");
  if (!existsSync(f)) {
    console.error(`${dir} has no pins.json`);
    process.exit(2);
  }
  const pins = JSON.parse(readFileSync(f, "utf8"));
  if (check) {
    const wrong = await checkMaterialized(dir, pins);
    bad += wrong.length;
    console.log(
      wrong.length
        ? `${basename(dir)}: ${wrong.length} missing or not the pinned bytes: ${wrong.join(", ")}`
        : `${basename(dir)}: every pinned file is there and matches`,
    );
    continue;
  }
  const r = await materialize(dir, pins, { cacheDir: CACHE });
  console.log(
    `${basename(dir)}: ${r.written.length} files checked against pins.json${r.downloaded.length ? `; downloaded ${r.downloaded.join(", ")}` : " (all from the cache)"}`,
  );
}
if (bad) process.exit(1);
