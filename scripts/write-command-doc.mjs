// pnpm docs:commands: docs/guide/commands.md from the command line's own help text.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { helpText, REPO } from "./help-text.mjs";

export function commandDoc() {
  const body = helpText()
    .split("\n")
    .filter((l) => !/^More commands arrive/.test(l))
    .join("\n")
    .trim();
  return [
    "# Command reference",
    "",
    "Generated from `atticus --help` by `pnpm docs:commands`; don't edit it by hand. Every command takes `--root <dir>` (the metarepo; default the current folder). `atticus explain <command>` says what one does in plain words.",
    "",
    "```text",
    body,
    "```",
    "",
  ].join("\n");
}

if (process.argv[1] && process.argv[1].endsWith("write-command-doc.mjs")) {
  writeFileSync(join(REPO, "docs/guide/commands.md"), commandDoc());
  console.log("Wrote docs/guide/commands.md");
}
