// pnpm --filter @maycombhq/cli test:properties:nightly: the catalog's property tests (ADR 0195
// point 10) with 2,000 sequences of up to 20 commands instead of `pnpm check`'s 100 of up to 10,
// as the nightly workflow (.github/workflows/properties-nightly.yml) runs them.
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
process.exit(r.status ?? 1);
