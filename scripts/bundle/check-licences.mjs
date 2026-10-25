// pnpm licences [<folder>]: every package Atticus ships is under a licence it may ship
// (ALLOWED), and a package that carries a third party's files (the model, onnxruntime's builds)
// carries their licence text too (ADR 0124 addendum D-npm). With no folder it checks a fresh
// `pnpm deploy` of the CLI; given one (an installed Atticus: a bundle's folder, or
// <prefix>/lib/node_modules/@maycombhq/cli after `npm install -g`), that.
import {
  deploy,
  forbiddenFiles,
  inventory,
  licenceAllowed,
  removeDeploy,
  unlicensedThirdParty,
} from "./inventory.mjs";

const dir = process.argv[2] ?? deploy();
const items = inventory(dir);
const forbidden = forbiddenFiles(dir);
for (const f of forbidden) console.error(`${f.file}: ${f.why}`);
if (!process.argv[2]) removeDeploy(dir);
const third = items.filter((i) => !i.own);
const bad = third.filter((i) => !licenceAllowed(i.licence));
const own = items.filter((i) => i.own && i.licence !== "Apache-2.0");
for (const i of bad)
  console.error(
    `${i.name}@${i.version}: licence ${i.licence ?? "not stated"} isn't on the allowed list`,
  );
for (const i of own)
  console.error(`${i.name}: Atticus's own packages are Apache-2.0, not ${i.licence ?? "unstated"}`);
const unlicensed = unlicensedThirdParty(items);
for (const u of unlicensed) console.error(u);
if (bad.length || own.length || forbidden.length || unlicensed.length) process.exit(1);
const counts = {};
for (const i of third) counts[i.licence] = (counts[i.licence] ?? 0) + 1;
console.log(
  `Licence check passed: ${third.length} third-party packages (${Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${v} ${k}`)
    .join(", ")}).`,
);
