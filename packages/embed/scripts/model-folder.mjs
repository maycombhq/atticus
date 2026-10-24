// node packages/embed/scripts/model-folder.mjs <name> <source dir> <out dir>
// Lays out a model folder Atticus reads (ADR 0116) from a model someone already has on disk
// (its fp32 ONNX file, tokenizer.json and config.json): copies them into <out dir> and writes
// atticus-model.yaml with the file's sha256. It downloads nothing. The settings of the two models
// the eval measured are below; another model needs its own entry, checked against its card.
//   <source dir> holds onnx/model.onnx (or model.onnx), tokenizer.json and config.json.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const KNOWN = {
  "snowflake-arctic-embed-xs": {
    dim: 384,
    maxTokens: 512,
    pooling: "cls",
    queryPrefix: "Represent this sentence for searching relevant passages: ",
    // Its cosines run high (unrelated texts near 0.7): 0.7 kept every no-answer case empty.
    similarityFloor: 0.7,
    licence: "Apache-2.0",
    source: "https://huggingface.co/Snowflake/snowflake-arctic-embed-xs",
  },
  "all-minilm-l6-v2": {
    dim: 384,
    maxTokens: 256,
    pooling: "mean",
    queryPrefix: "",
    // Calibrated on the retrieval cases (ADR 0116): 0.2 to 0.35 tried; 0.25 kept recall highest.
    similarityFloor: 0.25,
    licence: "Apache-2.0",
    source: "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2",
  },
};

const [name, src, out] = process.argv.slice(2);
const known = KNOWN[name];
if (!known || !src || !out) {
  console.error(
    `Usage: node packages/embed/scripts/model-folder.mjs <${Object.keys(KNOWN).join("|")}> <source dir> <out dir>`,
  );
  process.exit(2);
}
const model = [join(src, "onnx", "model.onnx"), join(src, "model.onnx")].find((f) => existsSync(f));
if (!model) {
  console.error(`No model.onnx (fp32) in ${src} or ${join(src, "onnx")}.`);
  process.exit(1);
}
mkdirSync(out, { recursive: true });
copyFileSync(model, join(out, "model.onnx"));
for (const f of ["tokenizer.json", "config.json"]) copyFileSync(join(src, f), join(out, f));
const sha = createHash("sha256")
  .update(readFileSync(join(out, "model.onnx")))
  .digest("hex");
const q = (s) => JSON.stringify(s);
writeFileSync(
  join(out, "atticus-model.yaml"),
  [
    "# A local embedding model for Atticus (ADR 0116). Written by packages/embed/scripts/model-folder.mjs.",
    "schemaVersion: 1",
    `name: ${name}`,
    "dtype: fp32",
    "model: model.onnx",
    `sha256: ${sha}`,
    "tokenizer: tokenizer.json",
    `dim: ${known.dim}`,
    `maxTokens: ${known.maxTokens}`,
    `pooling: ${known.pooling}`,
    `similarityFloor: ${known.similarityFloor}`,
    `queryPrefix: ${q(known.queryPrefix)}`,
    'documentPrefix: ""',
    `licence: ${known.licence}`,
    `source: ${known.source}`,
    "",
  ].join("\n"),
);
console.log(`Wrote ${out} (model.onnx sha256 ${sha}).`);
