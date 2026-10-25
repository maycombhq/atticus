// pnpm docs:commands: docs/guide/commands.md from the command line's own help text: the twelve
// commands atticus help shows first, then every command of theirs in full, then the legacy ones
// (ADR 0124 addendum D-cli).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { helpText, REPO, topHelpText, topWords } from "./help-text.mjs";

/** The full help split in two: the blocks of the twelve's commands, and everything else. */
export function splitHelp(help, top) {
  const twelve = [];
  const rest = [];
  let into = rest;
  const lines = help.split("\n");
  // The version and "Usage:" lines above the first command aren't part of either.
  for (const l of lines.slice(lines.findIndex((x) => /^ {2}atticus /.test(x)))) {
    const m = /^ {2}atticus ([a-z][a-z-]*)/.exec(l);
    if (m) into = top.has(m[1]) ? twelve : rest;
    else if (!/^ {6,}\S/.test(l)) into = rest;
    into.push(l);
  }
  return { twelve: twelve.join("\n"), rest: rest.join("\n") };
}

export function commandDoc() {
  const help = helpText()
    .split("\n")
    .filter((l) => !/^More commands arrive/.test(l))
    .join("\n")
    .trim();
  const { twelve, rest } = splitHelp(help, new Set(topWords()));
  return [
    "# Command reference",
    "",
    "Generated from `atticus --help` by `pnpm docs:commands`; don't edit it by hand. Every command takes `--root <dir>` (the metarepo; default the current folder). `atticus explain <command>` says what one does in plain words.",
    "",
    "## The twelve",
    "",
    "What `atticus help` shows. Install and first steps: [installing Atticus](install.md).",
    "",
    "```text",
    topHelpText(),
    "```",
    "",
    "## The twelve in full",
    "",
    "Every command under the twelve, with its options.",
    "",
    "```text",
    twelve.replace(/^\n+|\s+$/g, ""),
    "```",
    "",
    "## Legacy commands",
    "",
    "Every other command. `atticus legacy` lists them by area; each runs by its own name, as before, or as `atticus legacy <command>`.",
    "",
    "```text",
    rest.replace(/^\n+|\s+$/g, ""),
    "```",
    "",
  ].join("\n");
}

if (process.argv[1] && process.argv[1].endsWith("write-command-doc.mjs")) {
  writeFileSync(join(REPO, "docs/guide/commands.md"), commandDoc());
  console.log("Wrote docs/guide/commands.md");
}
