#!/usr/bin/env node
// The verifier on the bench's facts, this build against a base commit's (third review of ADR 0196).
//
//   node bench/verify-compare.mjs --base <git ref> [--repo <id>] [--cache <dir>] [--lost]
//
// For each bench repo with an assistant's facts in <cache>/facts/<id>.jsonl and a clone at
// <cache>/<id> (`atticus bench fetch`), it verifies the facts against the clone with this
// checkout's built verifier (packages/verify/dist: build first) and with the base commit's
// (packages/core and packages/verify of that commit, built into a temporary folder that is deleted
// after), and prints, per repo, the facts, how many each kept, and the facts one kept and the other
// didn't. --lost prints each fact the base kept and this build doesn't, with its reason and cite.
// It reads the cache only, writes nothing in it, and calls no network. The temporary folder goes
// on Ctrl-C (SIGINT) and SIGTERM too; an unknown --repo is refused with the ids it knows.
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const base = arg("--base");
const only = arg("--repo");
const lost = process.argv.includes("--lost");
const cache =
  arg("--cache") ??
  (process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "atticus", "bench")
    : join(homedir(), ".cache", "atticus", "bench"));
if (!base) {
  console.error(
    "Usage: node bench/verify-compare.mjs --base <git ref> [--repo <id>] [--cache <dir>] [--lost]",
  );
  process.exit(2);
}
if (!existsSync(join(cache, "facts"))) {
  console.log(`No bench facts at ${join(cache, "facts")}: nothing to compare.`);
  process.exit(0);
}
if (!existsSync(join(root, "packages", "verify", "dist", "index.js"))) {
  console.error("Build this checkout first (pnpm build): packages/verify/dist is missing.");
  process.exit(2);
}

// the bench repos with facts: an unknown --repo is refused before anything is built
const files = (await readdir(join(cache, "facts")))
  .filter((n) => /^[a-z0-9][a-z0-9-]*\.jsonl$/.test(n) && !/questions|rejected|reviewed/.test(n))
  .sort();
const known = files.map((n) => n.replace(/\.jsonl$/, ""));
if (only && !known.includes(only)) {
  console.error(
    `No bench facts for ${only} in ${join(cache, "facts")}. The repos with facts: ${known.join(", ") || "none"}.`,
  );
  process.exit(2);
}

/** Link a package's node_modules entry by entry, `@maycombhq/core` to the base's own core. */
async function linkModules(pkg, to, core) {
  const from = join(root, "packages", pkg, "node_modules");
  await mkdir(to, { recursive: true });
  for (const e of await readdir(from)) {
    if (e.startsWith("@")) {
      await mkdir(join(to, e), { recursive: true });
      for (const s of await readdir(join(from, e))) {
        const target = e === "@maycombhq" && s === "core" ? core : await realpath(join(from, e, s));
        await symlink(target, join(to, e, s), "junction");
      }
    } else await symlink(await realpath(join(from, e)), join(to, e), "junction");
  }
}

const tmp = await mkdtemp(join(tmpdir(), "verify-compare-"));
// interrupted: the temporary folder goes too (the `finally` below doesn't run on a signal)
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
])
  process.once(signal, () => {
    rmSync(tmp, { recursive: true, force: true });
    process.exit(code);
  });
try {
  const sha = execFileSync("git", ["rev-parse", "--short=8", base], { cwd: root })
    .toString()
    .trim();
  // the base's core and verify, built with this checkout's TypeScript and modules; tar is run in
  // the temporary folder on a relative name, as Git for Windows's tar reads `C:` as a host
  const tar = join(tmp, "base.tar");
  execFileSync(
    "git",
    ["archive", "-o", tar, sha, "tsconfig.base.json", "packages/core", "packages/verify"],
    {
      cwd: root,
    },
  );
  execFileSync("tar", ["-xf", "base.tar"], { cwd: tmp });
  await rm(tar);
  const core = join(tmp, "packages", "core");
  // the workspace's own modules (TypeScript's `@types/node`), as in the checkout
  await symlink(await realpath(join(root, "node_modules")), join(tmp, "node_modules"), "junction");
  await linkModules("core", join(core, "node_modules"), core);
  await linkModules("verify", join(tmp, "packages", "verify", "node_modules"), core);
  const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
  for (const pkg of ["core", "verify"])
    execFileSync(process.execPath, [tsc, "-p", join(tmp, "packages", pkg, "tsconfig.build.json")], {
      stdio: "inherit",
    });
  const OLD = await import(pathToFileURL(join(tmp, "packages", "verify", "dist", "index.js")).href);
  const NEW = await import(
    pathToFileURL(join(root, "packages", "verify", "dist", "index.js")).href
  );
  const { parseFactsLines } = await import(
    pathToFileURL(join(root, "packages", "core", "dist", "index.js")).href
  );

  const tot = { repos: 0, facts: 0, base: 0, now: 0 };
  const notes = [];
  console.log(
    `${"REPO".padEnd(32)} ${"FACTS".padStart(6)} ${`KEPT@${sha}`.padStart(14)} ${"KEPT NOW".padStart(9)}  LOST  GAINED`,
  );
  for (const f of files) {
    const repo = f.replace(/\.jsonl$/, "");
    if (only && repo !== only) continue;
    const dir = join(cache, repo);
    if (!existsSync(dir)) {
      notes.push(`${repo}: no clone at ${dir} (atticus bench fetch)`);
      continue;
    }
    const facts = parseFactsLines(await readFile(join(cache, "facts", f), "utf8")).facts;
    if (!facts.length) continue;
    const o = await OLD.verifyFacts({ facts, source: OLD.dirSource(dir) });
    const n = await NEW.verifyFacts({ facts, source: NEW.dirSource(dir) });
    const ok = new Set(o.accepted.map((x) => x.id));
    const nk = new Set(n.accepted.map((x) => x.id));
    const gone = [...ok].filter((id) => !nk.has(id));
    const won = [...nk].filter((id) => !ok.has(id));
    tot.repos++;
    tot.facts += facts.length;
    tot.base += ok.size;
    tot.now += nk.size;
    console.log(
      `${repo.padEnd(32)} ${String(facts.length).padStart(6)} ${String(ok.size).padStart(14)} ${String(nk.size).padStart(9)}  ${String(gone.length ? `-${gone.length}` : "").padStart(4)}  ${won.length ? `+${won.length}` : ""}`,
    );
    if (lost)
      for (const id of gone) {
        const r = n.rejected.find((x) => x.fact.id === id);
        const fx = facts.find((x) => x.id === id);
        notes.push(
          `LOST ${repo} ${id}: ${r?.code} ${r?.message}\n    cite=${JSON.stringify(fx.cite)}`,
        );
      }
    for (const id of won) notes.push(`GAINED ${repo} ${id}`);
  }
  console.log(
    `${"all".padEnd(32)} ${String(tot.facts).padStart(6)} ${String(tot.base).padStart(14)} ${String(tot.now).padStart(9)}`,
  );
  for (const l of notes) console.log(l);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
