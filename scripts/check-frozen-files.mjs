#!/usr/bin/env node
// Files that may not grow (v31 plan, section 0). The estate join's heuristics grew by 285 lines
// over beta.28.5 and beta.30, each fix one more matching rule in Atticus's code. The owner's
// direction is the opposite: an arrow the join reads wrongly is fixed where the estate lives, by
// a reading rule, a pairing or a person's correction in the metarepo. This check holds the file
// at its size: a change may move or shorten code in it, never add to it. Only the owner raises a
// ceiling, by editing the number below in a PR that says why.
//
//   node scripts/check-frozen-files.mjs

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

export const FROZEN = [
  {
    file: "packages/core/src/facts-join.ts",
    // Its length at 2.0.0-beta.30 (b6cf4c3).
    ceiling: 3882,
    why: "An arrow the join reads wrongly is fixed by a reading rule, a pairing or a correction in the metarepo, not by more matching code.",
  },
];

/** Each frozen file over its ceiling, with its length. A file that is gone is not a problem. */
export function check(root = ROOT) {
  const problems = [];
  for (const f of FROZEN) {
    const path = join(root, f.file);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    const lines = text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
    if (lines > f.ceiling) problems.push({ file: f.file, lines, ceiling: f.ceiling });
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const problems = check();
  for (const p of problems) {
    const why = FROZEN.find((f) => f.file === p.file).why;
    console.error(
      `${p.file} is frozen at ${p.ceiling} lines and has ${p.lines}. ${why} See docs/plan/v31.md, section 0.`,
    );
  }
  process.exit(problems.length ? 1 : 0);
}
