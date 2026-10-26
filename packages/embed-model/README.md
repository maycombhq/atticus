# @maycombhq/embed-model

The local embedding model Atticus ships (ADR 0116), for "similar in meaning" in the context engine:
all-MiniLM-L6-v2 (sentence-transformers, Apache-2.0) as an fp32 ONNX export, its WordPiece
tokenizer, the model card, the Apache License 2.0 and `atticus-model.yaml` (how Atticus runs it:
mean pooling, 384 dimensions, 256 tokens, its similarity floor, the model file's sha256).

The model runs on the person's own machine with onnxruntime's CPU build; nothing is sent
anywhere and nothing is downloaded at run time. `@maycombhq/atticus` lists this package as an
optional dependency, so installing it installs this too, and `retrieval.embeddings.model: bundled`
(the default) finds it.

The model files are not in the repository; they are in the npm package (ADR 0124 addendum
D-npm), so installing Atticus from npm, or from a bank's npm mirror, brings them with no install
script and nothing downloaded after. When the package is packed for publishing, `prepack` fills
each file from the pinned cache (`.cache/pinned`, with no network) and checks it against the
sha256 in `pins.json` (published beside them); it refuses to pack when one is missing or wrong.
In a checkout, `pnpm model:fetch` fills the cache from the pinned sources
(Xenova/all-MiniLM-L6-v2 at revision 751bff37182d3f1213fa05d7196b954e230abad9, and the licence
text from apache.org).

Training data, for the organisation's legal review: the model card lists the datasets the model
was fine-tuned on (over a billion sentence pairs, among them MS MARCO, whose terms are
research-only, Reddit, Stack Exchange and S2ORC).
