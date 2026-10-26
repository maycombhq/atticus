// pnpm licences [<folder>]: every package Atticus ships is under a licence it may ship
// (ALLOWED; OFL-1.1 for a font), and a package that carries a third party's files (the model,
// onnxruntime's builds) carries their licence text too (ADR 0124 addendum D-npm). With no folder
// it checks a fresh `pnpm deploy` of the CLI (what the offline bundle ships) and, when it is
// built, @maycombhq/atticus (packages/atticus: every third party bundled inside, from its
// dist/third-party.json, each with its licence in THIRD-PARTY-LICENSES.txt; ADR 0124 addendum
// D-npm2); given one (an installed Atticus: a bundle's folder, or
// <prefix>/lib/node_modules/@maycombhq/atticus after `npm install -g`), that.
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  deploy,
  forbiddenFiles,
  inventory,
  itemAllowed,
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
if (failed) process.exit(1);
