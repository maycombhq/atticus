#!/usr/bin/env node
// Write the field-shaped Forge estate (beta.30, slice 9) as the fixture fixtures/forge-field/:
// what packages/cli/test/field-estate.ts makes at the shape of packages/cli/test/forge-field.ts,
// made by the test that checks it (packages/cli/test/forge-field-fixture.test.ts) with
// UPDATE_GOLDEN=1. Deterministic: the same code writes the same bytes. Run it after adding a
// field report's shape to the estate (CONTRIBUTING.md, "Adding a field report's shape"), or when the check says the
// fixture is out of date, then review the diff.
//
//   node scripts/write-field-fixture.mjs        (pnpm fixtures:field; builds the CLI's packages first)
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const win = process.platform === "win32";
const run = (args, env = {}) => {
  const r = spawnSync(win ? "pnpm.cmd" : "pnpm", args, {
    cwd: ROOT,
    stdio: "inherit",
    shell: win,
    env: { ...process.env, ...env },
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
if (!process.argv.includes("--no-build"))
  run(["-s", "turbo", "run", "build", "--filter=@maycombhq/cli..."]);
run(
  [
    "--filter",
    "@maycombhq/cli",
    "exec",
    "vitest",
    "run",
    "--config",
    "../../vitest.shared.mjs",
    "test/forge-field-fixture.test.ts",
  ],
  { UPDATE_GOLDEN: "1" },
);
console.log(
  "Wrote fixtures/forge-field/ (metarepo, repos, estate.json). Review the diff before committing.",
);
