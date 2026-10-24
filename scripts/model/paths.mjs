// Where the pinned-file scripts work (ADR 0116 addendum).
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = fileURLToPath(new URL("../..", import.meta.url));
/** The download cache, by sha256 (gitignored). ATTICUS_PINNED_CACHE moves it (CI caches it). */
export const CACHE = process.env.ATTICUS_PINNED_CACHE ?? join(REPO, ".cache", "pinned");
/** The packages whose files are pinned. */
export const PINNED_PACKAGES = [
  "embed-model",
  "onnxruntime-win32-x64",
  "onnxruntime-win32-arm64",
  "onnxruntime-linux-x64",
  "onnxruntime-linux-arm64",
  "onnxruntime-darwin-arm64",
  "onnxruntime-wasm",
];
