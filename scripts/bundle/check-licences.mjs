// pnpm licences: every package Atticus ships is under a licence it may ship (ALLOWED).
import { deploy, inventory, licenceAllowed } from "./inventory.mjs";

const items = inventory(process.argv[2] ?? deploy());
const third = items.filter((i) => !i.own);
const bad = third.filter((i) => !licenceAllowed(i.licence));
const own = items.filter((i) => i.own && i.licence !== "Apache-2.0");
for (const i of bad)
  console.error(
    `${i.name}@${i.version}: licence ${i.licence ?? "not stated"} isn't on the allowed list`,
  );
for (const i of own)
  console.error(`${i.name}: Atticus's own packages are Apache-2.0, not ${i.licence ?? "unstated"}`);
if (bad.length || own.length) process.exit(1);
const counts = {};
for (const i of third) counts[i.licence] = (counts[i.licence] ?? 0) + 1;
console.log(
  `Licence check passed: ${third.length} third-party packages (${Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${v} ${k}`)
    .join(", ")}).`,
);
