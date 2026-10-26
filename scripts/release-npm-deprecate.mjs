// pnpm release:npm:deprecate [--yes] [--registry <url>]
// ADR 0124 addendum D-npm2: Atticus 2.0.0-beta.1 went to npm as 47 packages; from 2.0.0-beta.2 it
// is one (@maycombhq/atticus) with the SDK, the model and onnxruntime beside it, and the other
// 39 names are private workspace packages. This marks every one of those names deprecated on
// npm, so an install of an old name says where Atticus went:
//   npm deprecate <name> "Atticus is now one package: npm install -g @maycombhq/atticus"
// A dry run by default: it prints the npm commands and runs nothing. --yes runs them (needs npm
// credentials that may publish to the maycombhq scope); a name npm doesn't have (beta.1's publish
// stopped at 25 of 47) is skipped, and npm's rate limit (429) waits and tries again.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));

/** What every retired name says on npm. */
export const DEPRECATION_MESSAGE = "Atticus is now one package: npm install -g @maycombhq/atticus";

/**
 * The names 2.0.0-beta.1 published that are private from 2.0.0-beta.2 (each the workspace
 * package in packages/<name after the scope>).
 */
export const RETIRED_PACKAGES = [
  "adapters",
  "adopt",
  "ai",
  "assistant-files",
  "assistant-kit",
  "changes",
  "ci",
  "cli",
  "conformance",
  "core",
  "diagrams",
  "embed",
  "evals",
  "executors",
  "extractors",
  "features",
  "glossary",
  "index",
  "ingestors",
  "initiatives",
  "intake",
  "knowledge",
  "learn",
  "model-providers",
  "naysayer",
  "openspec-adapter",
  "planner",
  "reconcile",
  "release",
  "scanner",
  "server",
  "site",
  "speckit",
  "stubs",
  "taskrun",
  "testgen",
  "ui",
  "verify",
  "workspace",
].map((d) => `@maycombhq/${d}`);

/** The npm arguments that deprecate one name. */
export const deprecateArgs = (name, registry) => [
  "deprecate",
  name,
  DEPRECATION_MESSAGE,
  ...(registry ? ["--registry", registry] : []),
];

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const yes = args.includes("--yes");
  const at = args.indexOf("--registry");
  const registry = at >= 0 ? args[at + 1] : undefined;
  // Only names whose workspace package is private now: never a published one.
  const still = RETIRED_PACKAGES.filter((n) => {
    const f = join(REPO, "packages", n.split("/")[1], "package.json");
    return !existsSync(f) || JSON.parse(readFileSync(f, "utf8")).private !== true;
  });
  if (still.length) {
    console.error(`These aren't private in the workspace, so not retired: ${still.join(", ")}`);
    process.exit(1);
  }
  const quote = (a) => (/^[\w@/.:-]+$/.test(a) ? a : `"${a}"`);
  if (!yes) {
    for (const n of RETIRED_PACKAGES)
      console.log(`npm ${deprecateArgs(n, registry).map(quote).join(" ")}`);
    console.log(
      `Dry run: ${RETIRED_PACKAGES.length} names would be deprecated; nothing was run. Run again with --yes to deprecate them on npm.`,
    );
    process.exit(0);
  }
  const sleep = (s) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, s * 1000);
  const done = [];
  const missing = [];
  const failed = [];
  for (const n of RETIRED_PACKAGES) {
    let wait = Number(process.env.ATTICUS_PUBLISH_WAIT_S ?? 60);
    for (let attempt = 1; ; attempt++) {
      const r = spawnSync("npm", deprecateArgs(n, registry), {
        encoding: "utf8",
        shell: process.platform === "win32",
      });
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      if (r.status === 0) {
        done.push(n);
        console.log(`deprecated ${n}`);
      } else if (/E404|404 Not Found|is not in this registry/i.test(out)) {
        missing.push(n);
        console.log(`${n} isn't on npm: skipped`);
      } else if (/E429|Too Many Requests|rate limit/i.test(out) && attempt < 6) {
        console.log(`npm rate-limited the run: waiting ${wait} s, then ${n} again.`);
        sleep(wait);
        wait = Math.min(wait * 2, 900);
        continue;
      } else {
        failed.push(n);
        console.error(`${n}: npm deprecate failed:\n${out.trim()}`);
      }
      break;
    }
  }
  console.log(
    `Deprecated ${done.length}; ${missing.length} not on npm; ${failed.length} failed${failed.length ? ` (${failed.join(", ")})` : ""}.`,
  );
  process.exit(failed.length ? 1 : 0);
}
