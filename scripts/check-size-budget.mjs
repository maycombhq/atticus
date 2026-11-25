#!/usr/bin/env node
// A size rule for non-test source (ADR 0210 part 8): no more lines of non-test source than the
// last release. Since 2.0.0-beta.33 the rule is the baseline itself, BUDGET 0: code added is paid
// for by code taken out (beta.33 alone has the owner's allowance, below). (v31 began it as a budget of 3,500 lines over 2.0.0-beta.30, WP-11.)
// Every run prints the total and the packages that grew most. Only the owner raises the budget,
// by editing the number below in a PR that says why.
//
// Non-test source: every file under packages/<package>/ and the root scripts/ folder with a code
// extension (CODE), leaving out node_modules and build output (SKIP_DIR), every folder named
// test, tests, __tests__ or fixtures, every *.test.* or *.spec.* file, and the folders listed in
// EXCLUDE, each with its reason. A test or fixtures folder inside src/ is left out too: in this
// repo the only ones are packages/intellij/src/test/ (the plugin's Kotlin tests and their
// inputs), and a fixtures folder holds test inputs by this repo's convention. Docs, markdown,
// YAML, JSON and the starter files are not code.
//
// The baseline is recorded below, package by package, as counted at the tag, rather than read
// from git: CI clones shallow with no tags, a Windows checkout may have no git on the path for a
// script, and counting the tag's tree would need its objects. The counts need nothing but the
// working tree, so the check is the same offline, on Linux and on Windows. A new release records
// a new baseline: `git archive <tag> packages scripts` into an empty folder, then
// `node scripts/check-size-budget.mjs --record <that folder>` prints it.
//
//   node scripts/check-size-budget.mjs [--record [folder]]

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

export const BASELINE_TAG = "v2.0.0-beta.32";
/**
 * How many non-test lines may be added over the baseline, in all: none (ADR 0210 part 8), with
 * one allowance the owner set on 2026-11-25. beta.33 builds the AI-first map (items 2 to 11) and
 * could pay for it only by deleting the readers, which ADR 0210 part 6 leaves to a later ADR;
 * every unused line outside them was taken out (docs/plan/v33-notes/item8.md). So against
 * beta.32 alone the allowance is 3,200 lines; it ends by itself when beta.33's baseline is
 * recorded, and from then on code added is paid for by code taken out.
 */
export const BUDGET = BASELINE_TAG === "v2.0.0-beta.32" ? 3200 : 0;
/**
 * Non-test source lines per package at BASELINE_TAG (0598729), counted on `git archive` of the
 * tag's packages/ and scripts/ with `--record`; `scripts` is the root folder.
 */
export const BASELINE = {
  adapters: 2924,
  adopt: 4571,
  ai: 7820,
  "assistant-files": 3945,
  "assistant-kit": 5436,
  changes: 9051,
  ci: 1362,
  cli: 87455,
  conformance: 1615,
  core: 50219,
  diagrams: 2703,
  embed: 797,
  evals: 7972,
  executors: 1181,
  extractors: 23996,
  features: 2517,
  glossary: 1793,
  index: 6335,
  ingestors: 3073,
  initiatives: 2363,
  intake: 5387,
  intellij: 7539,
  knowledge: 10592,
  learn: 2453,
  "model-providers": 2244,
  naysayer: 10276,
  "openspec-adapter": 1408,
  planner: 34385,
  reconcile: 820,
  release: 3420,
  scanner: 17546,
  sdk: 1779,
  server: 2490,
  site: 431,
  speckit: 2752,
  stubs: 1046,
  synth: 1704,
  taskrun: 3499,
  testgen: 3478,
  ui: 85597,
  verify: 11722,
  vscode: 16012,
  workspace: 2079,
  scripts: 5128,
};

const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|kt|css|vue|py|sh|ps1)$/;
const SKIP_DIR = new Set([
  "test",
  "tests",
  "__tests__",
  "fixtures",
  // Installed packages and build output, never in git.
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".turbo",
  ".gradle",
]);

/** Folders left out by path (from the repo root), each generated, or test code by another name. */
export const EXCLUDE = {
  // Generated: the SDK's npm layout, written by scripts/bundle/npm-sdk.mjs (gitignored).
  "packages/sdk/npm": "generated",
  // Generated: the UI's library build (vite build --mode lib, gitignored).
  "packages/ui/dist-lib": "generated",
  // Test code: the UI's Playwright end-to-end tests.
  "packages/ui/e2e": "test",
  // Test code: the VS Code extension's tests, run in an extension host.
  "packages/vscode/test-vscode": "test",
  // Test code: the end-to-end journeys (Playwright), a package of tests only.
  "packages/journeys": "test",
  // Test code: the M3 exit check's live run, a harness over mocks and recorded replay.
  "packages/m3-exit": "test",
};
const TEST_FILE = /\.(test|spec)\.[^.]+$/;

const linesOf = (text) =>
  text.length === 0
    ? 0
    : text.endsWith("\n")
      ? text.split("\n").length - 1
      : text.split("\n").length;

function countDir(dir, rel) {
  if (rel in EXCLUDE) return 0;
  let lines = 0;
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (!SKIP_DIR.has(name)) lines += countDir(p, `${rel}/${name}`);
    } else if (CODE.test(name) && !TEST_FILE.test(name)) {
      lines += linesOf(readFileSync(p, "utf8"));
    }
  }
  return lines;
}

/** Non-test source lines per package (and `scripts`), packages with none left out. */
export function count(root = ROOT) {
  const out = {};
  const pkgs = join(root, "packages");
  if (existsSync(pkgs))
    for (const name of readdirSync(pkgs).sort()) {
      const dir = join(pkgs, name);
      if (!statSync(dir).isDirectory()) continue;
      const n = countDir(dir, `packages/${name}`);
      if (n) out[name] = n;
    }
  const scripts = join(root, "scripts");
  if (existsSync(scripts)) {
    const n = countDir(scripts, "scripts");
    if (n) out.scripts = n;
  }
  return out;
}

/**
 * The growth over the baseline: in all, against the budget, and per package, the largest first
 * (a package that is new counts whole, one that is gone counts its loss).
 */
export function check(root = ROOT, o = {}) {
  const baseline = o.baseline ?? BASELINE;
  const budget = o.budget ?? BUDGET;
  const now = count(root);
  const names = [...new Set([...Object.keys(baseline), ...Object.keys(now)])].sort();
  const packages = names
    .map((name) => ({
      name,
      was: baseline[name] ?? 0,
      now: now[name] ?? 0,
      grew: (now[name] ?? 0) - (baseline[name] ?? 0),
    }))
    .filter((p) => p.grew !== 0)
    .sort((a, b) => b.grew - a.grew || (a.name < b.name ? -1 : 1));
  const sum = (m) => Object.values(m).reduce((a, b) => a + b, 0);
  const grew = sum(now) - sum(baseline);
  return { total: sum(now), baseline: sum(baseline), grew, budget, over: grew > budget, packages };
}

/** The lines a run prints: the total, then the packages that grew most. */
export function report(r, top = 5) {
  const sign = (n) => (n >= 0 ? `+${n}` : `${n}`);
  const head = `Non-test source: ${r.total} lines, ${sign(r.grew)} over ${BASELINE_TAG} (${r.baseline}); budget +${r.budget}${r.over ? `: over by ${r.grew - r.budget}` : `, ${r.budget - r.grew} left`}.`;
  const most = r.packages.filter((p) => p.grew > 0).slice(0, top);
  return [
    head,
    ...(most.length
      ? [`Grew most: ${most.map((p) => `${p.name} ${sign(p.grew)}`).join(", ")}.`]
      : []),
    ...(r.over
      ? [
          "Take code out, or ask the owner to raise BUDGET in scripts/check-size-budget.mjs in a PR that says why (ADR 0210 part 8).",
        ]
      : []),
  ];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const at = process.argv.indexOf("--record");
  if (at >= 0) {
    console.log(JSON.stringify(count(process.argv[at + 1] ?? ROOT), null, 2));
    process.exit(0);
  }
  const r = check();
  for (const line of report(r)) (r.over ? console.error : console.log)(line);
  process.exit(r.over ? 1 : 0);
}
