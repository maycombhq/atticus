# Recorded vectors (ADR 0116)

The int8 vectors a local embedding model gave every node of the retrieval roots and every case's
input, one file per model (`<model name>.json`: the model's id, its similarity floor, then each
vector by kind and text sha256). The eval's +embeddings mode replays them with
`RecordedEmbedder`, so CI scores real-model retrieval without the model file, which is not in the
repo.

Record them again on a machine that has the model (after a change to what a node is embedded as):

    pnpm --filter @maycombhq/evals... build
    pnpm --filter @maycombhq/evals eval:embed -- <model folder> <folder whose node_modules holds onnxruntime-node>

A model folder is laid out by `node packages/embed/scripts/model-folder.mjs <name> <source> <out>`
from a model already on disk. The opt-in check (`ATTICUS_EMBED_MODEL`, `ATTICUS_ORT_DIR`,
`packages/evals/test/embed-model.test.ts`) embeds everything again and compares.
