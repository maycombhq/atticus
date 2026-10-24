# @maycombhq/onnxruntime-win32-arm64

onnxruntime-node 1.30.0's CPU build for win32-arm64 (Microsoft, MIT licence in LICENSE), repackaged for Atticus's local embedding model (ADR 0116). The files are onnxruntime-node's own, unchanged, each checked against the sha256 in `pins.json` when the package is packed. Left out: the install script (it can download CUDA binaries) and the DirectML files (their licence isn't on Atticus's allowed list). npm installs this package only on win32-arm64.
