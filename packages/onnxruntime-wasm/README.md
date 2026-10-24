# @maycombhq/onnxruntime-wasm

onnxruntime-web 1.30.0's WebAssembly build (Microsoft, MIT licence in LICENSE): `ort.wasm.min.mjs` and the threaded SIMD module, unchanged, each checked against the sha256 in `pins.json` when the package is packed. Atticus's local embedding model (ADR 0116) runs on it where onnxruntime's native build won't load. 14 MB, against 141 MB for the whole onnxruntime-web package.
