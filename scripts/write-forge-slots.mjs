#!/usr/bin/env node
// Write the Forge golden slots (ADR 0195, fixtures/forge/slots/): the readers slot of each repo of
// fixtures/forge/repos/ and the facts snapshot of a successful verify --write, made by the same
// test that checks them (packages/cli/test/forge-slots.test.ts) with UPDATE_GOLDEN=1. Run after a
// reader's output changed, then review the diff: they are golden files of the readers' output.
//
//   node scripts/write-forge-slots.mjs        (pnpm fixtures:slots; builds the CLI's packages first)
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
    "test/forge-slots.test.ts",
  ],
  { UPDATE_GOLDEN: "1" },
);
console.log("Wrote fixtures/forge/slots/ (readers and facts). Review the diff before committing.");
