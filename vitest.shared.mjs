// Shared by every package's `vitest run --config ../../vitest.shared.mjs`: Vitest's defaults,
// plus one temporary folder per package run (scripts/vitest-temp.mjs), removed at the end.
// Workers are capped at half the cores: turbo runs several packages' tests at once, and each
// worker loads the WebAssembly grammars (ADR 0060), so uncapped runs can exhaust memory on a
// laptop or a small CI runner.
export default {
  // ADR 0116: no test loads the installed embedding model unless it passes one itself.
  test: {
    globalSetup: ["../../scripts/vitest-temp.mjs"],
    maxWorkers: "50%",
    env: { ATTICUS_EMBEDDINGS: "off" },
  },
};
