// pnpm --filter @maycombhq/evals eval:embed -- <model dir> [<runtime dir>]
// Records the vectors a local embedding model (a folder with atticus-model.yaml, ADR 0116) gives
// every node of the retrieval roots and every case's input, into
// fixtures/retrieval/vectors/<model name>.json, which the eval replays in CI where the model
// file isn't. <runtime dir> is a folder whose node_modules holds onnxruntime-node. Run it on a
// machine that has the model; nothing is downloaded. Build first.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OnnxEmbedder } from "@maycombhq/embed";
import { recordRetrievalVectors } from "../dist/index.js";

const [modelDir, runtimeDir] = process.argv.slice(2).filter((a) => a !== "--");
if (!modelDir) {
  console.error("Usage: eval:embed -- <model dir> [<runtime dir>]");
  process.exit(2);
}
const fixtures = fileURLToPath(new URL("../../../fixtures", import.meta.url));
const embedder = await OnnxEmbedder.open(modelDir, runtimeDir ? { runtimeDir } : {});
const t0 = Date.now();
const v = await recordRetrievalVectors(fixtures, embedder);
const dir = join(fixtures, "retrieval/vectors");
mkdirSync(dir, { recursive: true });
const out = join(dir, `${embedder.manifest.name}.json`);
writeFileSync(out, `${JSON.stringify(v, null, 1)}\n`);
console.log(
  `Wrote ${out}: ${Object.keys(v.document).length} node and ${Object.keys(v.query).length} query vectors by ${v.model} (${embedder.backend}, ${((Date.now() - t0) / 1000).toFixed(1)} s).`,
);
