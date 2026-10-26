// pnpm copilot-agents: plugins/copilot, the files GitHub Copilot reads for custom agents and
// skills in agent mode (ADR 0121 addendum of 2026-10-26), from the same commands
// `atticus assistant-files` renders and the Claude Code plugin comes from. Don't edit
// plugins/copilot by hand; the assistant-files tests fail when it is out of date.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { copilotAgentFiles } from "../packages/assistant-files/dist/index.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(REPO, "packages/cli/package.json"), "utf8")).version;
const out = join(REPO, "plugins/copilot");
rmSync(out, { recursive: true, force: true });
const files = copilotAgentFiles(version);
for (const f of files) {
  const p = join(out, f.path);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, f.content);
}
console.log(`Wrote plugins/copilot (${files.length} files, version ${version})`);
