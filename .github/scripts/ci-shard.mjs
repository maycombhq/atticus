// CI's helper for .github/workflows/ci.yml: which tests a shard runs, and what the build cache keeps.
//
//   node .github/scripts/ci-shard.mjs unit <i> <n>       turbo --filter arguments for unit shard i of n
//   node .github/scripts/ci-shard.mjs cli <i> <n>        Vitest arguments for the CLI's shard i of n
//   node .github/scripts/ci-shard.mjs journeys <i> <n>   the journey spec files for shard i of n
//   node .github/scripts/ci-shard.mjs prune <cache dir> <dry-run json>
//                                                        removes every turbo cache entry the build
//                                                        (`turbo run build --dry=json`) doesn't use
//
// Every package with a test script, every CLI test file and every journey file is in exactly one
// shard: the shards are worked out from what is in the repo, so a new package, test file or
// journey is tested without an edit here. The weights are seconds measured on a Windows runner
// (CI run 42935088176); they only balance the shards, and anything not listed weighs the default.
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url));

// Tested by their own jobs in ci.yml, not by the unit shards.
const OWN_JOB = ["@maycombhq/cli", "@maycombhq/journeys", "@maycombhq/m5-exit"];

const UNIT_WEIGHTS = {
  "@maycombhq/planner": 324,
  "@maycombhq/taskrun": 171,
  "@maycombhq/m3-exit": 168,
  "@maycombhq/scanner": 140,
  "@maycombhq/naysayer": 135,
  "@maycombhq/evals": 127,
  "@maycombhq/changes": 97,
  "@maycombhq/speckit": 87,
  "@maycombhq/workspace": 85,
  "@maycombhq/core": 70,
  "@maycombhq/learn": 67,
  "@maycombhq/testgen": 61,
  atticus: 59,
  "@maycombhq/index": 54,
  "@maycombhq/ui": 46,
  "@maycombhq/openspec-adapter": 41,
  "@maycombhq/m4-exit": 39,
  "@maycombhq/verify": 30,
  "@maycombhq/adopt": 30,
  "@maycombhq/assistant-kit": 26,
  "@maycombhq/knowledge": 25,
  "@maycombhq/extractors": 25,
  "@maycombhq/assistant-files": 24,
  "@maycombhq/release": 23,
  "@maycombhq/ci": 20,
  "@maycombhq/ai": 18,
  "@maycombhq/harbor-tests": 18,
  "@maycombhq/server": 17,
  "@maycombhq/intake": 17,
  "@maycombhq/conformance": 14,
  "@maycombhq/synth": 13,
  "@maycombhq/initiatives": 12,
};
const UNIT_DEFAULT = 5;

// The CLI's test files that take 10 s or more.
const CLI_WEIGHTS = {
  "propose.test.ts": 149,
  // ADR 0195's property tests (100 sequences); estimated from Linux, not yet measured on Windows.
  "properties/catalog-properties.test.ts": 120,
  "learn-cli.test.ts": 103,
  "map-all-cli.test.ts": 64,
  "ui-api-task-run.test.ts": 57,
  "run-cli.test.ts": 39,
  "ai-decide.test.ts": 37,
  "archive-rescan-cli.test.ts": 34,
  "ui-api-initiatives.test.ts": 32,
  "scan-cli.test.ts": 23,
  "ui-api-task-pr.test.ts": 21,
  "critic-handoff-cli.test.ts": 21,
  "optional-embeddings.test.ts": 17,
  "map-render-cli.test.ts": 17,
  "map-all-acp-cli.test.ts": 16,
  "setup-cli.test.ts": 15,
  "stage-cli.test.ts": 14,
  "map-rules-topup-cli.test.ts": 14,
  "branch-scan-cli.test.ts": 13,
  "bench-cli.test.ts": 12,
  "spec-seed.test.ts": 12,
  "workspace-cli.test.ts": 12,
  "todo-manual-sync-cli.test.ts": 12,
  "ui-api-task-audit.test.ts": 12,
  "round-50-onboarding-cli.test.ts": 12,
  "run-ready.test.ts": 11,
  "fresh-metarepo.test.ts": 11,
  "openspec-stores-cli.test.ts": 10,
  "initiative-cli.test.ts": 10,
  "change-conform-cli.test.ts": 10,
  "eval-cli.test.ts": 10,
  "skills-import.test.ts": 10,
};
const CLI_DEFAULT = 1.8;

const JOURNEY_WEIGHTS = {
  "14-every-screen.spec.ts": 126,
  "17-light-theme.spec.ts": 116,
  "23-atticus-2-metarepo.spec.ts": 107,
  "15-empty-and-error.spec.ts": 80,
  "28-a-button-for-every-step.spec.ts": 79,
  "08-platform-lead.spec.ts": 74,
  "16-knowledge-review.spec.ts": 60,
  "01-product-owner.spec.ts": 56,
  "19-model-runs.spec.ts": 56,
  "07-delivery-lead.spec.ts": 54,
  "10-process-owner.spec.ts": 51,
  "24-more-pages.spec.ts": 50,
  "09-designer.spec.ts": 36,
  "11-data-architect.spec.ts": 33,
};
const JOURNEY_DEFAULT = 15;
// Each file also starts its own metarepo and server.
const JOURNEY_FILE_COST = 10;

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Longest first, each to the lightest shard; ties by name, so every shard computes the same split. */
function split(items, weight, n) {
  const bins = Array.from({ length: n }, () => ({ total: 0, items: [] }));
  const sorted = [...items].sort((a, b) => weight(b) - weight(a) || byName(a, b));
  for (const item of sorted) {
    const bin = bins.reduce((min, b) => (b.total < min.total ? b : min), bins[0]);
    bin.items.push(item);
    bin.total += weight(item);
  }
  return bins;
}

function shardArgs(args) {
  const i = Number(args[0]);
  const n = Number(args[1]);
  if (!Number.isInteger(i) || !Number.isInteger(n) || i < 1 || i > n) {
    throw new Error(`a shard is <i> <n> with 1 <= i <= n, not "${args.join(" ")}"`);
  }
  return { i, n };
}

/** Test files under a folder, with forward slashes, sorted. */
function testFiles(dir, prefix) {
  return readdirSync(dir, { recursive: true })
    .map((f) => prefix + String(f).replace(/\\/g, "/"))
    .filter((f) => /\.(spec|test)\.[cm]?[jt]sx?$/.test(f))
    .sort();
}

/** Playwright and Vitest read each file argument as a pattern a path contains: one must pick one file. */
function distinct(files, what) {
  for (const f of files) {
    const also = files.filter((g) => g !== f && g.includes(f));
    if (also.length > 0) throw new Error(`${what} ${f} would also pick ${also.join(", ")}`);
  }
}

function testedPackages() {
  const names = [];
  for (const dir of readdirSync(join(REPO, "packages"))) {
    const file = join(REPO, "packages", dir, "package.json");
    if (!existsSync(file)) continue;
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    if (manifest.scripts?.test) names.push(manifest.name);
  }
  for (const name of OWN_JOB) {
    if (!names.includes(name)) {
      throw new Error(`${name} has its own CI job but no package of that name has a test script`);
    }
  }
  return names.sort();
}

/**
 * Shards 1 to n-1 each name their files, the heaviest first, up to an n-th of the time; shard n
 * runs every other file, the named ones excluded, so a new file is always run. Vitest's own
 * --shard splits by a hash of the path, which put the two slowest files on Windows in one shard
 * (868 s against 365 s).
 */
function cliShard(i, n) {
  const dir = join(REPO, "packages/cli");
  const script = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).scripts.test;
  const excluded = [...script.matchAll(/--exclude\s+(\S+)/g)].map((m) => m[1]);
  const files = testFiles(join(dir, "test"), "test/").filter((f) => !excluded.includes(f));
  distinct(files, "CLI test");
  const weight = (f) => CLI_WEIGHTS[f.slice("test/".length)] ?? CLI_DEFAULT;
  const target = files.reduce((s, f) => s + weight(f), 0) / n;
  const named = Array.from({ length: n - 1 }, () => ({ total: 0, items: [] }));
  const sorted = [...files].sort((a, b) => weight(b) - weight(a) || byName(a, b));
  for (const f of sorted) {
    const bin = named.find((b) => b.total + weight(f) <= target);
    if (!bin) continue;
    bin.items.push(f);
    bin.total += weight(f);
  }
  if (i < n) return named[i - 1].items.join(" ");
  return named.flatMap((b) => b.items.map((f) => `--exclude ${f}`)).join(" ");
}

function prune(cacheDir, dryRunFile) {
  const dry = JSON.parse(readFileSync(dryRunFile, "utf8"));
  const keep = new Set(dry.tasks.map((t) => t.hash));
  if (!existsSync(cacheDir)) return;
  let removed = 0;
  for (const entry of readdirSync(cacheDir)) {
    const hash = entry.replace(/(-meta\.json|\.tar\.zst|\.tar)$/, "");
    if (keep.has(hash)) continue;
    rmSync(join(cacheDir, entry), { recursive: true, force: true });
    removed += 1;
  }
  console.log(`kept ${keep.size} build entries, removed ${removed} files`);
}

const [command, ...args] = process.argv.slice(2);
if (command === "unit") {
  const { i, n } = shardArgs(args);
  const units = testedPackages().filter((p) => !OWN_JOB.includes(p));
  const bins = split(units, (p) => UNIT_WEIGHTS[p] ?? UNIT_DEFAULT, n);
  console.log(bins[i - 1].items.map((p) => `--filter=${p}`).join(" "));
} else if (command === "cli") {
  const { i, n } = shardArgs(args);
  console.log(cliShard(i, n));
} else if (command === "journeys") {
  const { i, n } = shardArgs(args);
  const files = testFiles(join(REPO, "packages/journeys/tests"), "");
  distinct(files, "journey");
  const weight = (f) => (JOURNEY_WEIGHTS[f] ?? JOURNEY_DEFAULT) + JOURNEY_FILE_COST;
  console.log(split(files, weight, n)[i - 1].items.join(" "));
} else if (command === "prune") {
  prune(args[0], args[1]);
} else {
  console.error("usage: ci-shard.mjs unit|cli|journeys <i> <n> | prune <cache dir> <dry json>");
  process.exit(2);
}
