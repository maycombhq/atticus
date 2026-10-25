// node scripts/model/fetch.mjs [<package folder>...] [--all] [--this-platform] [--check] [--offline]
// Fills the packages that carry the embedding model and its runtime (ADR 0116 addendum) with
// their pinned files: each from its pinned source (an exact revision, or an entry of a pinned
// npm tarball), checked against the sha256 in the package's pins.json, through a cache by
// sha256 (.cache/pinned, or ATTICUS_PINNED_CACHE) so a second run downloads nothing. Run by
// `pnpm model:fetch` and `pnpm bundle`, and with --offline by each package's prepack (packing
// for npm: ADR 0124 addendum D-npm); never at run time, in a test or in an install. --check only
// reads: it says which files are missing or wrong.
//   --all            every pinned package
//   --this-platform  the model, this machine's runtime and the WASM fallback
//   --offline        never download: fill from the cache only, and refuse (exit 1) when a
//                    source isn't there or a file isn't the pinned bytes
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CACHE, PINNED_PACKAGES, REPO, rerunWithEnvProxy } from "./paths.mjs";

const args = process.argv.slice(2);
const check = args.includes("--check");
const offline = args.includes("--offline");
rerunWithEnvProxy(import.meta.url, args, !check && !offline);

const embedDist = join(REPO, "packages/embed/dist/index.js");
if (!existsSync(embedDist)) {
  console.error("packages/embed isn't built: run pnpm build first.");
  process.exit(2);
}
const { materialize, checkMaterialized } = await import(pathToFileURL(embedDist).href);

let dirs = args.filter((a) => !a.startsWith("--")).map((a) => resolve(a));
if (args.includes("--all")) dirs = PINNED_PACKAGES.map((p) => join(REPO, "packages", p));
if (args.includes("--this-platform"))
  dirs = ["embed-model", `onnxruntime-${process.platform}-${process.arch}`, "onnxruntime-wasm"]
    .filter((p) => PINNED_PACKAGES.includes(p))
    .map((p) => join(REPO, "packages", p));
if (!dirs.length) {
  console.error(
    "Usage: node scripts/model/fetch.mjs <package folder>... | --all | --this-platform [--check] [--offline]",
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
  // Offline (a pack), files already there with their pinned bytes need nothing from the cache.
  if (offline && !(await checkMaterialized(dir, pins)).length) {
    console.log(`${basename(dir)}: every pinned file is there and matches pins.json`);
    continue;
  }
  try {
    const r = await materialize(dir, pins, { cacheDir: CACHE, offline });
    // Read back what was written: a pack ships exactly the pinned bytes, or nothing.
    const wrong = await checkMaterialized(dir, pins);
    if (wrong.length) throw new Error(`not the pinned bytes after writing: ${wrong.join(", ")}`);
    console.log(
      `${basename(dir)}: ${r.written.length} files checked against pins.json${r.downloaded.length ? `; downloaded ${r.downloaded.join(", ")}` : " (all from the cache)"}`,
    );
  } catch (e) {
    console.error(
      `${basename(dir)}: ${e instanceof Error ? e.message : String(e)}${offline ? `\nRefused: the pinned files must be in ${CACHE} first. Run pnpm model:fetch (it downloads each pinned source once and checks its sha256), then pack again.` : ""}`,
    );
    process.exit(1);
  }
}
if (bad) process.exit(1);
