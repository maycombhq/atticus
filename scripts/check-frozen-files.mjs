#!/usr/bin/env node
// Files that may not grow (docs/plan/v31.md). The estate join's three files grew by 285 lines
// over beta.28.5 and beta.30 (5,139 to 5,424), each fix one more matching rule in Atticus's code. The owner's
// direction is the opposite: an arrow the join reads wrongly is fixed where the estate lives, by
// a reading rule, a pairing or a person's correction in the metarepo. This check holds the join's
// files together at their size: every file in the folder whose name starts so is counted, so
// moving code into a new `facts-join-*.ts` doesn't get past it, and a frozen set with no file at
// all fails, so a rename has to update this list on purpose. Only the owner raises a ceiling, by
// editing the number below in a PR that says why. docs/plan/v31.md, "Kept for v31".
//
//   node scripts/check-frozen-files.mjs

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

export const FROZEN = [
  {
    file: "packages/core/src/facts-join.ts",
    // Every file in that folder whose name starts `facts-join`, counted together.
    family: /^facts-join[\w.-]*\.ts$/,
    // The set's length at 2.0.0-beta.30 (b6cf4c3): facts-join.ts 3,882, facts-join-prototype.ts
    // and facts-join-vendor.ts the rest.
    ceiling: 5424,
    why: "An arrow the join reads wrongly is fixed by a reading rule, a pairing or a correction in the metarepo, not by more matching code.",
  },
];

const linesOf = (text) =>
  text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;

/**
 * Each frozen set over its ceiling, with its lines and its files, or with `missing` when the
 * named file is gone (a rename updates this list on purpose).
 */
export function check(root = ROOT) {
  const problems = [];
  for (const f of FROZEN) {
    const dir = dirname(f.file);
    if (!existsSync(join(root, f.file))) {
      problems.push({ file: f.file, lines: 0, ceiling: f.ceiling, missing: true });
      continue;
    }
    const names = readdirSync(join(root, dir))
      .filter((n) => f.family.test(n))
      .sort();
    let lines = 0;
    for (const n of names) lines += linesOf(readFileSync(join(root, dir, n), "utf8"));
    if (lines > f.ceiling)
      problems.push({
        file: f.file,
        lines,
        ceiling: f.ceiling,
        files: names.map((n) => `${dir}/${n}`),
      });
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const problems = check();
  for (const p of problems) {
    const why = FROZEN.find((f) => f.file === p.file).why;
    console.error(
      p.missing
        ? `${p.file} is frozen and is gone. If it was renamed, update scripts/check-frozen-files.mjs in the same change.`
        : `${p.files.join(" + ")} are frozen at ${p.ceiling} lines together and have ${p.lines}. ${why} See docs/plan/v31.md, "Kept for v31".`,
    );
  }
  process.exit(problems.length ? 1 : 0);
}
