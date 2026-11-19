// pnpm --filter @maycombhq/cli test:properties:nightly: the catalog's property tests (ADR 0195
// point 10) with 2,000 sequences of up to 20 commands instead of `pnpm check`'s 100 of up to 10,
// as the nightly workflow (.github/workflows/properties-nightly.yml) runs them; then the estate-shape
// properties (shape-properties.test.ts) with 200 shaped estates instead of 6.
// ATTICUS_PROPERTIES_RUNS, _MAX_COMMANDS, _SEED and _INVARIANTS set beforehand win, so a nightly
// failure replays with its seed.
import { spawnSync } from "node:child_process";

const env = {
  ...process.env,
  ATTICUS_PROPERTIES_RUNS: process.env.ATTICUS_PROPERTIES_RUNS || "2000",
  ATTICUS_PROPERTIES_MAX_COMMANDS: process.env.ATTICUS_PROPERTIES_MAX_COMMANDS || "20",
};
const r = spawnSync(
  "pnpm",
  [
    "exec",
    "vitest",
    "run",
    "--config",
    "../../vitest.shared.mjs",
    "--fsModuleCachePath=node_modules/.vitest-cache",
    "test/properties/catalog-properties.test.ts",
  ],
  { stdio: "inherit", env, shell: process.platform === "win32" },
);
// Beta.30 (slice 9): the estate-shape properties, 200 shaped estates from a random seed (it is
// printed; ATTICUS_SHAPE_SEED and _RUNS set beforehand win, so a failure replays).
const shapes = spawnSync(
  "pnpm",
  [
    "exec",
    "vitest",
    "run",
    "--config",
    "../../vitest.shared.mjs",
    "--fsModuleCachePath=node_modules/.vitest-cache",
    "test/properties/shape-properties.test.ts",
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      ATTICUS_SHAPE_RUNS: process.env.ATTICUS_SHAPE_RUNS || "200",
      ...(process.env.ATTICUS_SHAPE_SEED ? {} : { ATTICUS_SHAPE_RANDOM: "1" }),
    },
    shell: process.platform === "win32",
  },
);
// A run killed by a signal has no status: that is a failure, never an exit 0.
process.exit((r.status ?? 1) || (shapes.status ?? 1));
