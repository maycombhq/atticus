// Where the pinned-file scripts work (ADR 0116 addendum).
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Behind a proxy: Node's fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY is set (Node 22.21
 * and later honour it, NO_PROXY included), so a download goes straight to the host and fails.
 * When a proxy is named and the script may download, run it again with it set, and exit with
 * its status. (scripts/bundle/fetch-model.mjs does the same: it ships alone, without this file.)
 */
export function rerunWithEnvProxy(scriptUrl, args, downloads) {
  const proxy = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"].some(
    (n) => process.env[n],
  );
  if (!proxy || !downloads || process.env.NODE_USE_ENV_PROXY) return;
  const again = spawnSync(process.execPath, [fileURLToPath(scriptUrl), ...args], {
    stdio: "inherit",
    env: { ...process.env, NODE_USE_ENV_PROXY: "1" },
  });
  process.exit(again.status ?? 1);
}

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
