// The Atticus plugin's SessionStart hook (ADR 0104). What it prints is added to the session:
// in an Atticus metarepo, the next step and how to take it; anywhere else, nothing.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

let root;
for (let d = process.env.CLAUDE_PROJECT_DIR || process.cwd(); ; d = dirname(d)) {
  if (existsSync(join(d, "org-pack")) || existsSync(join(d, ".atticus", "org-pack"))) {
    root = d;
    break;
  }
  if (dirname(d) === d) break;
}
if (!root) process.exit(0);

// ATTICUS_BIN names the command line's bin.js; else atticus on PATH.
const win = process.platform === "win32";
const args = ["next", "--json", "--root", root];
const r = process.env.ATTICUS_BIN
  ? spawnSync(process.execPath, [process.env.ATTICUS_BIN, ...args], { encoding: "utf8", timeout: 20000 })
  : spawnSync(win ? "atticus.cmd" : "atticus", args.map((a) => (win ? `"${a}"` : a)), {
      encoding: "utf8",
      timeout: 20000,
      shell: win,
    });
let next;
try {
  next = JSON.parse(r.stdout).next;
} catch {
  next = undefined;
}
if (r.status !== 0 && next === undefined) {
  console.log(
    "This is an Atticus metarepo, but the atticus command line didn't answer. Install it (npm install -g @maycombhq/cli, or the offline bundle) to take its steps; the /atticus-* commands need it.",
  );
  process.exit(0);
}
const tools = "The atticus MCP tools read its catalog, knowledge, changes and needs.";
if (!next) console.log(`This is an Atticus metarepo, and no step is waiting. ${tools}`);
else
  console.log(
    `This is an Atticus metarepo. Next step: ${next.why} Run ${next.slash ? `${next.slash} (or ${next.command})` : next.command}. ${tools}`,
  );
