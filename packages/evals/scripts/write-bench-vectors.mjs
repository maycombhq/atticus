// pnpm --filter @maycombhq/evals eval:bench-vectors -- <model dir> [<runtime dir>]
// Records the vectors a local embedding model (a folder with atticus-model.yaml, ADR 0116) gives
// every node and query text of the task-knowledge bench and the many-wiki bench (planted pages),
// into fixtures/retrieval/vectors/benches/<model name>.json, which their tests replay in CI where
// the model file isn't (ADR 0132 addendum: keeping a task's knowledge by meaning). <runtime dir>
// is a folder whose node_modules holds onnxruntime-node. Run it on a machine that has the model;
// nothing is downloaded. Build first.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { textSha, vectorToText } from "@maycombhq/ai";
import { OnnxEmbedder } from "@maycombhq/embed";
import { runManyWikisBench, runTaskKnowledgeBench } from "../dist/index.js";

const [modelDir, runtimeDir] = process.argv.slice(2).filter((a) => a !== "--");
if (!modelDir) {
  console.error("Usage: eval:bench-vectors -- <model dir> [<runtime dir>]");
  process.exit(2);
}
// Only the benches' own opens embed (with the recording model below), never the stages' default.
process.env.ATTICUS_EMBEDDINGS = "off";
const fixtures = fileURLToPath(new URL("../../../fixtures", import.meta.url));
const model = await OnnxEmbedder.open(modelDir, runtimeDir ? { runtimeDir } : {});
const out = {
  model: model.id,
  dim: model.dim,
  maxTokens: model.maxTokens,
  ...(model.floor !== undefined ? { floor: model.floor } : {}),
  document: {},
  query: {},
};
/** The model, keeping every vector it gives, by kind and text sha. */
const recording = {
  id: model.id,
  dim: model.dim,
  maxTokens: model.maxTokens,
  ...(model.floor !== undefined ? { floor: model.floor } : {}),
  backend: model.backend,
  async embed(texts, kind) {
    const vs = await model.embed(texts, kind);
    texts.forEach((t, i) => (out[kind][textSha(t)] = vectorToText(vs[i])));
    return vs;
  },
};
const t0 = Date.now();
await runTaskKnowledgeBench(fixtures, { embeddings: recording });
await runManyWikisBench(fixtures, { embeddings: recording, embedAll: true });
const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
out.document = sorted(out.document);
out.query = sorted(out.query);
const dir = join(fixtures, "retrieval/vectors/benches");
mkdirSync(dir, { recursive: true });
const file = join(dir, `${model.manifest.name}.json`);
writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`);
console.log(
  `Wrote ${file}: ${Object.keys(out.document).length} node and ${Object.keys(out.query).length} query vectors by ${out.model} (${model.backend}, ${((Date.now() - t0) / 1000).toFixed(1)} s).`,
);
