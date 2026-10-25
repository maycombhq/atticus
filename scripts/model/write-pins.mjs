/* global fetch */
// node scripts/model/write-pins.mjs
// For a maintainer moving the model or onnxruntime to a new pinned version (ADR 0116 addendum):
// downloads each source once (into .cache/pinned), and writes every package's pins.json with
// the sha256 of each source and of each file the package publishes. Review the diff, then commit
// it. This and `pnpm model:fetch` are the only scripts that reach the network; nothing at run
// time, in a test or in an install does. Build first (it uses @maycombhq/core and @maycombhq/embed).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CACHE, PINNED_PACKAGES, REPO, rerunWithEnvProxy } from "./paths.mjs";

rerunWithEnvProxy(import.meta.url, process.argv.slice(2), true);

const { fetchSource, sha256Of } = await import(
  pathToFileURL(join(REPO, "packages/embed/dist/index.js")).href
);
const { readTarGz } = await import(pathToFileURL(join(REPO, "packages/core/dist/index.js")).href);

// ---- the pinned sources (exact revisions)
const MODEL_REV = "751bff37182d3f1213fa05d7196b954e230abad9"; // Xenova/all-MiniLM-L6-v2 on Hugging Face
const ORT = "1.30.0";
const SOURCES = {
  model: {
    url: `https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/${MODEL_REV}/onnx/model.onnx`,
    what: "all-MiniLM-L6-v2, fp32 ONNX export (Xenova), the weights of sentence-transformers/all-MiniLM-L6-v2",
  },
  tokenizer: {
    url: `https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/${MODEL_REV}/tokenizer.json`,
    what: "its WordPiece tokenizer",
  },
  card: {
    url: `https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/${MODEL_REV}/README.md`,
    what: "its model card",
  },
  apache: {
    url: "https://www.apache.org/licenses/LICENSE-2.0.txt",
    what: "the Apache License 2.0 the model card names (the model's repository has no LICENSE file)",
  },
  "onnxruntime-node": {
    url: `https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-${ORT}.tgz`,
    what: `onnxruntime-node ${ORT} from the npm registry`,
  },
  "onnxruntime-web": {
    url: `https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-${ORT}.tgz`,
    what: `onnxruntime-web ${ORT} from the npm registry`,
  },
  "ort-licence": {
    url: `https://raw.githubusercontent.com/microsoft/onnxruntime/v${ORT}/LICENSE`,
    what: `onnxruntime's MIT licence at v${ORT} (its npm packages carry none)`,
  },
};

// The sha256 each URL had in the committed pins: its bytes may already be in the cache.
const known = new Map();
for (const p of PINNED_PACKAGES) {
  const f = join(REPO, "packages", p, "pins.json");
  if (existsSync(f))
    for (const s of Object.values(JSON.parse(readFileSync(f, "utf8")).sources))
      known.set(s.url, s.sha256);
}
const bytesOf = new Map();
for (const [name, s] of Object.entries(SOURCES)) {
  const cached = known.has(s.url) ? join(CACHE, known.get(s.url)) : undefined;
  let b;
  if (cached && existsSync(cached)) b = new Uint8Array(readFileSync(cached));
  else {
    // Not cached: download straight (no sha256 is known yet; these bytes become the pin).
    const r = await fetch(s.url, { redirect: "follow" });
    if (!r.ok) throw new Error(`${s.url}: HTTP ${r.status}`);
    b = new Uint8Array(await r.arrayBuffer());
  }
  s.sha256 = sha256Of(b);
  bytesOf.set(name, b);
  await fetchSource(s, { cacheDir: CACHE, get: async () => b });
  console.log(`${name}: ${s.sha256} (${b.length} bytes)`);
}
const tar = (name) =>
  readTarGz(bytesOf.get(name), {
    maxEntries: 20_000,
    maxEntryBytes: 256 * 1024 * 1024,
    maxTotalBytes: 1024 * 1024 * 1024,
  });
const src = (...names) => Object.fromEntries(names.map((n) => [n, SOURCES[n]]));
const write = (dir, pins) => {
  writeFileSync(join(REPO, "packages", dir, "pins.json"), `${JSON.stringify(pins, null, 2)}\n`);
  console.log(`Wrote packages/${dir}/pins.json (${pins.files.length} files)`);
};
const whole = (path, source) => ({ path, source, sha256: SOURCES[source].sha256 });
const entryOf = (a, source, entry, path = entry) => {
  const b = a.read(entry);
  if (!b) throw new Error(`${source} has no ${entry}`);
  return { path, source, entry, sha256: sha256Of(b) };
};

write("embed-model", {
  sources: src("model", "tokenizer", "card", "apache"),
  files: [
    whole("model.onnx", "model"),
    whole("tokenizer.json", "tokenizer"),
    whole("MODEL-CARD.md", "card"),
    whole("LICENSE", "apache"),
  ],
});

const node = tar("onnxruntime-node");
const DIST = ["index", "backend", "binding", "version"].flatMap((n) => [
  `dist/${n}.js`,
  `dist/${n}.js.map`,
]);
for (const [platform, arch] of [
  ["win32", "x64"],
  ["win32", "arm64"],
  ["linux", "x64"],
  ["linux", "arm64"],
  ["darwin", "arm64"],
]) {
  const bin = node.names.filter(
    (n) =>
      n.startsWith(`bin/napi-v6/${platform}/${arch}/`) &&
      // DirectML and its shader compiler: their licence isn't on the allowed list.
      !/\/(DirectML|dxcompiler|dxil)\.dll$/i.test(n),
  );
  write(`onnxruntime-${platform}-${arch}`, {
    sources: src("onnxruntime-node", "ort-licence"),
    files: [
      ...DIST.map((e) => entryOf(node, "onnxruntime-node", e)),
      ...bin.map((e) => entryOf(node, "onnxruntime-node", e)),
      whole("LICENSE", "ort-licence"),
    ],
  });
}
const web = tar("onnxruntime-web");
write("onnxruntime-wasm", {
  sources: src("onnxruntime-web", "ort-licence"),
  files: [
    ...[
      "dist/ort.wasm.min.mjs",
      "dist/ort.wasm.min.mjs.map",
      "dist/ort-wasm-simd-threaded.mjs",
      "dist/ort-wasm-simd-threaded.wasm",
    ].map((e) => entryOf(web, "onnxruntime-web", e)),
    whole("LICENSE", "ort-licence"),
  ],
});
