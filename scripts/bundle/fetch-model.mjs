// node fetch-model.mjs [--list] [--check] [--from <folder>] [--offline] [--atticus <folder>]
//
// The step a person runs after installing Atticus's embedding plugin zip (ADR 0124 addendum
// D-bundle). The zip carries the plugin's packages without their third-party files; this fills
// them, each from its pinned source and checked against the sha256 in the package's pins.json:
// the model (@maycombhq/embed-model), this machine's onnxruntime
// (@maycombhq/onnxruntime-<platform>-<arch>) and its WebAssembly fallback
// (@maycombhq/onnxruntime-wasm). Atticus never runs it: a command, a test or an install never
// downloads anything.
//   --list            the files it needs (sha256, then where they come from), for your mirror
//   --check           only read: which files are missing or not the pinned bytes
//   --from <folder>   take the files from a folder (any names: each is matched by its sha256)
//   --offline         never download: a file --from doesn't hold fails
//   --atticus <dir>   the Atticus folder (default: the one this script is installed in)
// Shipped in the plugin zip by scripts/bundle/embeddings-plugin.mjs; it needs nothing but Node
// and the Atticus it is installed in.
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const atticus = resolve(value("--atticus") ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const from = value("--from");
const scoped = join(atticus, "node_modules", "@maycombhq");
if (!existsSync(join(scoped, "embed", "dist", "index.js"))) {
  console.error(
    `The embedding plugin isn't installed in ${atticus}: run the plugin zip's install script first (sh install.sh, or install.ps1 on Windows), then this from the Atticus folder's embeddings-plugin folder.`,
  );
  process.exit(2);
}

// The model, this machine's runtime and the WebAssembly fallback. A platform with no native
// build here (macOS on Intel, for one) uses the fallback.
const here = `onnxruntime-${process.platform}-${process.arch}`;
const packages = ["embed-model", here, "onnxruntime-wasm"]
  .map((p) => ({ name: `@maycombhq/${p}`, dir: join(scoped, p) }))
  .filter((p) => existsSync(join(p.dir, "pins.json")))
  .map((p) => ({ ...p, pins: JSON.parse(readFileSync(join(p.dir, "pins.json"), "utf8")) }));
if (!packages.some((p) => p.name === "@maycombhq/embed-model")) {
  console.error(`${join(scoped, "embed-model")} has no pins.json: install the plugin zip again.`);
  process.exit(2);
}
if (!packages.some((p) => p.name === `@maycombhq/${here}`))
  console.log(
    `There is no native onnxruntime build for ${process.platform}-${process.arch}: the WebAssembly one is used.`,
  );

if (args.includes("--list")) {
  const seen = new Set();
  for (const p of packages)
    for (const s of Object.values(p.pins.sources))
      if (!seen.has(s.sha256)) {
        seen.add(s.sha256);
        console.log(`${s.sha256}  ${s.url}${s.what ? `  (${s.what})` : ""}`);
      }
  process.exit(0);
}

const { materialize, checkMaterialized, sha256Of } = await import(
  pathToFileURL(join(scoped, "embed", "dist", "index.js")).href
);

if (args.includes("--check")) {
  let bad = 0;
  for (const p of packages) {
    const wrong = await checkMaterialized(p.dir, p.pins);
    bad += wrong.length;
    console.log(
      wrong.length
        ? `${p.name}: ${wrong.length} missing or not the pinned bytes: ${wrong.join(", ")}`
        : `${p.name}: every pinned file is there and matches`,
    );
  }
  process.exit(bad ? 1 : 0);
}

// The sources, by sha256, in a cache of this run's own; --from fills it first.
const cache = mkdtempSync(join(tmpdir(), "atticus-fetch-model-"));
const wanted = new Set(packages.flatMap((p) => Object.values(p.pins.sources).map((s) => s.sha256)));
let found = 0;
if (from) {
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile()) {
        const sha = sha256Of(readFileSync(f));
        if (wanted.has(sha) && !existsSync(join(cache, sha))) {
          copyFileSync(f, join(cache, sha));
          found++;
        }
      }
    }
  };
  if (!existsSync(from)) {
    console.error(`--from ${from}: there is no such folder.`);
    process.exit(2);
  }
  walk(resolve(from));
  console.log(`${from}: ${found} of the ${wanted.size} pinned files are there.`);
}
const offline = args.includes("--offline");
try {
  for (const p of packages) {
    const r = await materialize(p.dir, p.pins, { cacheDir: cache, offline });
    console.log(
      `${p.name}: ${r.written.length} files checked against pins.json${r.downloaded.length ? `; downloaded ${r.downloaded.join(", ")}` : ""}`,
    );
  }
} catch (e) {
  console.error(
    `${e instanceof Error ? e.message : String(e)}\nnode ${basename(fileURLToPath(import.meta.url))} --list names every file it needs; fetch them through your mirror, then add --from <folder>.`,
  );
  process.exitCode = 1;
} finally {
  rmSync(cache, { recursive: true, force: true, maxRetries: 5 });
}
if (!process.exitCode)
  console.log(
    "Search by meaning is ready. In your metarepo: atticus doctor, then atticus index embed.",
  );
