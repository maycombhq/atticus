#!/usr/bin/env node
// Fails if any tracked file contains a denied word or two-word phrase.
// The deny-list stores only SHA-256 hashes, so the protected names never appear in the repo.
//
//   node scripts/check-denylist.mjs            check every tracked file
//   node scripts/check-denylist.mjs <folder>   check every file under a folder, tracked or not
//                                              (a build's output, such as the published site)
//   node scripts/check-denylist.mjs --hash "x" print the hash to add to .denylist

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");

const args = process.argv.slice(2);
if (args[0] === "--hash") {
  console.log(sha((args[1] ?? "").trim().toLowerCase()));
  process.exit(0);
}

const denied = new Set(
  readFileSync(".denylist", "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[0-9a-f]{64}$/.test(l)),
);

/** Every file under a folder, as paths joined to it. */
const under = (dir) =>
  readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? under(p) : [p];
  });

const files = (
  args[0]
    ? under(args[0])
    : execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
        encoding: "utf8",
      }).split("\0")
).filter((f) => f && f !== ".denylist");

const hits = [];
for (const file of files) {
  let text;
  try {
    const buf = readFileSync(file);
    if (buf.includes(0)) continue; // binary
    text = buf.toString("utf8").toLowerCase();
  } catch {
    continue;
  }
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const words = line.match(/[a-z0-9]+/g) ?? [];
    for (let w = 0; w < words.length; w++) {
      if (
        denied.has(sha(words[w])) ||
        (w + 1 < words.length && denied.has(sha(`${words[w]} ${words[w + 1]}`)))
      ) {
        hits.push(`${file}:${i + 1}`);
        break;
      }
    }
  });
}

if (hits.length > 0) {
  console.error(`Denied names found (see .denylist) in ${hits.length} place(s):`);
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.log(`Deny-list check passed (${files.length} files).`);
