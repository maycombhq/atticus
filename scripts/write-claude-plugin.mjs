// pnpm claude-plugin: plugins/atticus, the Claude Code plugin (ADR 0104), from the same commands
// `atticus assistant-files` renders. Don't edit plugins/atticus by hand; the assistant-files tests
// fail when it is out of date.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeCodePluginFiles } from "../packages/assistant-files/dist/index.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(REPO, "packages/cli/package.json"), "utf8")).version;
const out = join(REPO, "plugins/atticus");
rmSync(out, { recursive: true, force: true });
const files = claudeCodePluginFiles(version);
for (const f of files) {
  const p = join(out, f.path);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, f.content);
}
// The listing icon: Atticus's glasses with the name below, 512 px (docs/brand/icon-512.png).
copyFileSync(join(REPO, "docs/brand/icon-512.png"), join(out, ".claude-plugin/icon.png"));
console.log(`Wrote plugins/atticus (${files.length} files, version ${version})`);
