// The docs say only true things about the product: every relative link resolves, every
// `atticus …` command they mention exists, every ADR they cite exists, and the command
// reference matches the help text.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { commands, REPO } from "./help-text.mjs";
import { commandDoc } from "./write-command-doc.mjs";

const files = ["README.md", "CONTRIBUTING.md"].filter((f) => existsSync(join(REPO, f)));
const walk = (d) => {
  for (const e of readdirSync(join(REPO, d))) {
    const p = join(d, e);
    if (statSync(join(REPO, p)).isDirectory()) walk(p);
    else if (p.endsWith(".md")) files.push(p);
  }
};
walk("docs");
const cmds = commands();
const adrs = new Set(readdirSync(join(REPO, "docs/adr")).map((f) => f.slice(0, 4)));
const problems = [];
const guide = (f) =>
  f.startsWith("docs/guide/") || f === "README.md" || f.startsWith("docs/security/");
for (const f of files) {
  const text = readFileSync(join(REPO, f), "utf8");
  // links
  for (const m of text.matchAll(/\]\(([^)\s#]+)(#[^)]*)?\)/g)) {
    const target = m[1];
    if (/^[a-z]+:/.test(target)) continue;
    const abs = join(REPO, dirname(f), target);
    if (!existsSync(abs)) problems.push(`${f}: link to ${target}, which doesn't exist`);
  }
  // ADRs cited
  for (const m of text.matchAll(/\bADR (\d{4})\b/g))
    if (!adrs.has(m[1])) problems.push(`${f}: cites ADR ${m[1]}, which doesn't exist`);
  // commands, in the guides and README (ADRs and exit reports keep history)
  if (!guide(f)) continue;
  for (const m of text.matchAll(
    /`atticus ([a-z][a-z-]*)(?: ([a-z][a-z-]*))?[^`]*`|^\s*atticus ([a-z][a-z-]*)(?: ([a-z][a-z-]*))?/gm,
  )) {
    const group = m[1] ?? m[3];
    const sub = m[2] ?? m[4];
    if (!cmds.has(group)) {
      problems.push(`${f}: \`atticus ${group}\` isn't a command`);
      continue;
    }
    const subs = cmds.get(group);
    if (
      sub &&
      subs.size &&
      !subs.has("*") &&
      !subs.has(sub) &&
      !/^(the|a|an|and|or|to|in|on|with|for|from)$/.test(sub)
    )
      problems.push(
        `${f}: \`atticus ${group} ${sub}\` isn't a command (${group} takes ${[...subs].filter((x) => x !== "*").join(", ")})`,
      );
  }
}
const ref = join(REPO, "docs/guide/commands.md");
if (!existsSync(ref) || readFileSync(ref, "utf8") !== commandDoc())
  problems.push("docs/guide/commands.md is out of date: run pnpm docs:commands");
if (problems.length) {
  for (const p of problems) console.error(p);
  process.exit(1);
}
console.log(`Docs check passed (${files.length} files, ${relative(REPO, REPO) || "."}).`);
