// Shared by every package's `vitest run --config ../../vitest.shared.mjs`: Vitest's defaults,
// plus one temporary folder per package run (scripts/vitest-temp.mjs), removed at the end.
export default { test: { globalSetup: ["../../scripts/vitest-temp.mjs"] } };
