// pnpm --filter @maycombhq/cli test:properties:nightly: the catalog's property tests (ADR 0195
// point 10) with 2,000 sequences instead of `pnpm check`'s 100. ATTICUS_PROPERTIES_RUNS, _SEED
// and _INVARIANTS set beforehand win, so a nightly failure replays with its seed.
import { spawnSync } from "node:child_process";

const env = {
  ...process.env,
  ATTICUS_PROPERTIES_RUNS: process.env.ATTICUS_PROPERTIES_RUNS ?? "2000",
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
