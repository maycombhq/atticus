// node scripts/clean-dir.mjs <dir>…  Remove each directory, so a build writes into an empty one.
// Vite's own emptyOutDir doesn't help here: Turborepo restores a cached dist/ without clearing
// what a different build left, so hashed asset names pile up (three copies of index-*.js were
// found on 2026-10-26, which broke the app's size budget and would have shipped in the npm
// package). Written in Node so it runs the same on Windows CI.
import { rmSync } from "node:fs";
import { resolve } from "node:path";

const dirs = process.argv.slice(2);
if (!dirs.length) {
  console.error("Usage: node scripts/clean-dir.mjs <dir>…");
  process.exit(2);
}
for (const d of dirs) rmSync(resolve(d), { recursive: true, force: true, maxRetries: 5 });
