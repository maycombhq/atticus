// The command line's help text, read from its source (so docs checks run before a build).
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const REPO = new URL("..", import.meta.url).pathname;

export function helpText() {
  const src = readFileSync(join(REPO, "packages/cli/src/main.ts"), "utf8");
  const m = /const HELP = `([\s\S]*?)`;/.exec(src);
  if (!m) throw new Error("HELP not found in packages/cli/src/main.ts");
  return m[1].replace(/\$\{VERSION\}/g, "<version>").replace(/\$\{SCHEMA_VERSION\}/g, "2");
}

/** Every command the help lists: group → the sub-commands it names (empty when it takes none). */
export function commands() {
  const out = new Map();
  for (const line of helpText().split("\n")) {
    const m = /^\s{2}atticus\s+(.*)$/.exec(line);
    if (!m) continue;
    const words = m[1].split(/\s+/);
    const group = words[0];
    if (!group || group.startsWith("-")) continue;
    if (!out.has(group)) out.set(group, new Set());
    const sub = words[1];
    if (sub && /^[a-z][a-z-]*$/.test(sub)) out.get(group).add(sub);
    // "critic <change>", "learn [list]": the next word can be anything.
    if (!sub || /^[<["]/.test(sub)) out.get(group).add("*");
    // "learn [list] | learn start" and "list|scan" forms
    for (const w of m[1].matchAll(/\b([a-z][a-z-]*)\|([a-z][a-z-]*)\b/g)) {
      out.get(group).add(w[1]);
      out.get(group).add(w[2]);
    }
    for (const w of m[1].matchAll(/\|\s*[a-z]+\s+([a-z][a-z-]*)/g)) out.get(group).add(w[1]);
  }
  return out;
}
