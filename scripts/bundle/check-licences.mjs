// pnpm licences [<folder>]: every package Atticus ships is under a licence it may ship
// (ALLOWED; OFL-1.1 for a font), and a package that carries a third party's files (the model,
// onnxruntime's builds) carries their licence text too (ADR 0124 addendum D-npm). With no folder
// it checks a fresh `pnpm deploy` of the CLI (what the offline bundle ships) and, when it is
// built, @maycombhq/atticus (packages/atticus: every third party bundled inside, from its
// dist/third-party.json, each with its licence in THIRD-PARTY-LICENSES.txt; ADR 0124 addendum
// D-npm2); given one (an installed Atticus: a bundle's folder, or
// <prefix>/lib/node_modules/@maycombhq/atticus after `npm install -g`), that.
//
// With no folder it also checks the direct dev dependencies of every workspace package (the
// tools that build and test Atticus, fast-check among them; ADR 0195 point 10), as installed:
// they are never shipped, but they are under the same allowed list, with fonts under OFL-1.1
// and the named exceptions in DEV_ONLY below.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  deploy,
  FONT_ALLOWED,
  forbiddenFiles,
  inventory,
  itemAllowed,
  licenceAllowed,
  licenceOf,
  removeDeploy,
  REPO,
  unlicensedThirdParty,
} from "./inventory.mjs";

/** The problems of one installed or built Atticus, as sentences, and its third parties. */
function check(dir, o) {
  const items = inventory(dir, o);
  const problems = forbiddenFiles(dir).map((f) => `${f.file}: ${f.why}`);
  const third = items.filter((i) => !i.own);
  for (const i of third.filter((i) => !itemAllowed(i)))
    problems.push(
      `${i.name}@${i.version}: licence ${i.licence ?? "not stated"} isn't on the allowed list`,
    );
  for (const i of items.filter((i) => i.own && i.licence !== "Apache-2.0"))
    problems.push(
      `${i.name}: Atticus's own packages are Apache-2.0, not ${i.licence ?? "unstated"}`,
    );
  problems.push(...unlicensedThirdParty(items));
  return { problems, third };
}

const counts = (third) => {
  const c = {};
  for (const i of third) c[i.licence] = (c[i.licence] ?? 0) + 1;
  return Object.entries(c)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${v} ${k}`)
    .join(", ");
};

const targets = [];
if (process.argv[2]) targets.push({ label: process.argv[2], dir: process.argv[2] });
else {
  const d = deploy();
  targets.push({ label: "the CLI's deploy (the offline bundle)", dir: d, deployed: true });
  const atticus = join(REPO, "packages", "atticus");
  if (existsSync(join(atticus, "dist", "third-party.json")))
    targets.push({ label: "@maycombhq/atticus (npm)", dir: atticus, built: true });
}
let failed = false;
for (const t of targets) {
  const r = check(t.dir, t.built ? { modules: false } : {});
  if (t.deployed) removeDeploy(t.dir);
  for (const p of r.problems) console.error(p);
  if (r.problems.length) failed = true;
  else
    console.log(
      `Licence check passed for ${t.label}: ${r.third.length} third-party packages (${counts(r.third)}).`,
    );
}
/**
 * Dev dependencies allowed under a licence Atticus may not ship, each by name with why: a test
 * tool that never reaches a bundle.
 */
const DEV_ONLY = new Map([
  [
    "@axe-core/playwright",
    "MPL-2.0: the journeys' WCAG 2.1 AA checks run it in tests; it is never bundled",
  ],
]);

/** The direct dev dependencies of the root and each package, with their installed licence. */
function devDependencyProblems() {
  const dirs = [
    REPO,
    ...readdirSync(join(REPO, "packages")).map((d) => join(REPO, "packages", d)),
  ].filter((d) => existsSync(join(d, "package.json")));
  const problems = [];
  const seen = new Set();
  for (const d of dirs) {
    const pkg = JSON.parse(readFileSync(join(d, "package.json"), "utf8"));
    for (const name of Object.keys(pkg.devDependencies ?? {})) {
      if (name.startsWith("@maycombhq/") || DEV_ONLY.has(name)) continue;
      const dir = [join(d, "node_modules", name), join(REPO, "node_modules", name)].find((x) =>
        existsSync(join(x, "package.json")),
      );
      if (!dir) {
        problems.push(
          `${name} (a dev dependency of ${pkg.name}) isn't installed: run pnpm install`,
        );
        continue;
      }
      const m = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      const licence = licenceOf(m);
      if (seen.has(`${name}@${m.version}`)) continue;
      seen.add(`${name}@${m.version}`);
      const font = name.startsWith("@fontsource/") && FONT_ALLOWED.has(licence);
      if (!licenceAllowed(licence) && !font)
        problems.push(
          `${name}@${m.version} (a dev dependency of ${pkg.name}): licence ${licence ?? "not stated"} isn't on the allowed list`,
        );
    }
  }
  return { problems, count: seen.size };
}

if (!process.argv[2]) {
  const dev = devDependencyProblems();
  for (const p of dev.problems) console.error(p);
  if (dev.problems.length) failed = true;
  else
    console.log(
      `Licence check passed for the dev dependencies: ${dev.count} packages (${DEV_ONLY.size} named exception).`,
    );
}
if (failed) process.exit(1);
