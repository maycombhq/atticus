// pnpm release:npm [--dry-run] [--tag <tag>] [--pack-only]
// Publishes Atticus's public npm packages (ADR 0124 addendum D-npm2): @maycombhq/atticus (the
// command line and its app, bundled), @maycombhq/sdk (the plugin SDK, C4), @maycombhq/embed-model
// and the six @maycombhq/onnxruntime-* packages. Every other workspace package is private and is
// never published. First the pack check (scripts/bundle/npm-packages.mjs): every package packs,
// the model's and onnxruntime's packages carry every pinned file with its pinned sha256 and its
// licence (filled by prepack from .cache/pinned, offline: run `pnpm model:fetch` first), the
// bundled ones every file their dist/files.json lists and every bundled third party's licence,
// none has an install script, every one is public. Then `pnpm publish` of each, with
// --filter, which publishes each package whose version npm doesn't have yet, dependencies first;
// on npm's rate limit (429) it waits and runs again.
//   --dry-run    pack and check, then let pnpm say what it would publish; nothing is uploaded
//   --tag <tag>  the dist-tag (default: the prerelease word of @maycombhq/atticus's version,
//                e.g. beta, else latest)
//   --pack-only  stop after the pack check
// Needs `pnpm build` first, and npm credentials for a real publish (`npm login`, or
// NODE_AUTH_TOKEN with an .npmrc that reads it, as the publish workflow does).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PUBLIC_PACKAGES } from "./bundle/npm-layout.mjs";
import { packAndCheck, REPO } from "./bundle/npm-packages.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const tagAt = args.indexOf("--tag");
const version = JSON.parse(
  readFileSync(join(REPO, "packages/atticus/package.json"), "utf8"),
).version;
const tag = tagAt >= 0 ? args[tagAt + 1] : (/-([a-z]+)/i.exec(version)?.[1] ?? "latest");
if (!tag || tag.startsWith("--")) {
  console.error("Usage: pnpm release:npm [--dry-run] [--tag <tag>] [--pack-only]");
  process.exit(2);
}

const dest = mkdtempSync(join(tmpdir(), "atticus-npm-pack-"));
try {
  packAndCheck(dest);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
} finally {
  rmSync(dest, { recursive: true, force: true, maxRetries: 5 });
}
if (args.includes("--pack-only")) process.exit(0);

// Only the public packages, named: a private one is never published, whatever its manifest says.
// npm rate-limits a new account publishing many packages at once: a 429 waits and runs again;
// pnpm skips every version npm already has, so a run picks up where the last stopped.
// ATTICUS_PUBLISH_WAIT_S sets the first wait (default 120 s, doubling).
const publish = [
  "-r",
  ...PUBLIC_PACKAGES.flatMap((p) => ["--filter", p]),
  "publish",
  "--access",
  "public",
  "--tag",
  tag,
  "--no-git-checks",
];
if (dryRun) publish.push("--dry-run");
const exec = process.env.npm_execpath;
const run = () =>
  exec && /pnpm/.test(exec) && /\.[cm]?js$/.test(exec)
    ? spawnSync(process.execPath, [exec, ...publish], { cwd: REPO, encoding: "utf8" })
    : spawnSync("pnpm", publish, {
        cwd: REPO,
        encoding: "utf8",
        shell: process.platform === "win32",
      });
const sleep = (s) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, s * 1000);
let wait = Number(process.env.ATTICUS_PUBLISH_WAIT_S ?? 120);
for (let attempt = 1; ; attempt++) {
  console.log(`pnpm ${publish.join(" ")}${attempt > 1 ? ` (attempt ${attempt})` : ""}`);
  const r = run();
  process.stdout.write(r.stdout ?? "");
  process.stderr.write(r.stderr ?? "");
  if (r.status === 0) process.exit(0);
  const limited = /E429|Too Many Requests|rate limit/i.test(`${r.stdout}${r.stderr}`);
  if (!limited || attempt >= 8) process.exit(r.status ?? 1);
  console.log(
    `npm rate-limited the publish: waiting ${wait} s, then publishing what is still missing.`,
  );
  sleep(wait);
  wait = Math.min(wait * 2, 1800);
}
