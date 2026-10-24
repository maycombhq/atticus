// The Atticus plugin's history hooks (ADR 0110): each prompt (UserPromptSubmit) and each reply
// (Stop) in an Atticus metarepo goes to `atticus history add`, kept in .atticus/history/ on this
// machine. Prints nothing: what a UserPromptSubmit hook prints is added to the conversation.
// The text is data: it goes to the command on stdin, never as an argument.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const kind = process.argv[2];
if (kind !== "prompt" && kind !== "response") process.exit(0);
let input;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}
let root;
for (let d = process.env.CLAUDE_PROJECT_DIR || input?.cwd || process.cwd(); ; d = dirname(d)) {
  if (existsSync(join(d, "org-pack")) || existsSync(join(d, ".atticus", "org-pack"))) {
    root = d;
    break;
  }
  if (dirname(d) === d) break;
}
if (!root) process.exit(0);

// The reply: the transcript's last assistant message, every text of it, through its tool calls.
function lastReply(file) {
  let lines;
  try {
    lines = readFileSync(file, "utf8").split(/\r?\n/);
  } catch {
    return undefined;
  }
  const texts = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    let e;
    try {
      e = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const content = e?.message?.content;
    if (e?.type === "assistant" && Array.isArray(content)) {
      const t = content
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("\n\n");
      if (t.trim()) texts.unshift(t);
    } else if (e?.type === "user") {
      // A tool's result belongs to the reply; anything else the person sent began it.
      const fromTool =
        Array.isArray(content) &&
        content.length > 0 &&
        content.every((b) => b?.type === "tool_result");
      if (!fromTool) break;
    }
  }
  return texts.length ? texts.join("\n\n") : undefined;
}

const text =
  kind === "prompt"
    ? typeof input?.prompt === "string"
      ? input.prompt
      : undefined
    : typeof input?.transcript_path === "string"
      ? lastReply(input.transcript_path)
      : undefined;
if (!text || !text.trim()) process.exit(0);

// ATTICUS_BIN names the command line's bin.js; else atticus on PATH.
const win = process.platform === "win32";
const session = typeof input.session_id === "string" ? input.session_id : "";
const args = [
  "history",
  "add",
  "--surface",
  "claude-code",
  "--kind",
  kind,
  ...(/^[\w.-]+$/.test(session) ? ["--session", session] : []),
  "--root",
  root,
];
const o = { input: text, encoding: "utf8", timeout: 15000, stdio: ["pipe", "ignore", "ignore"] };
if (process.env.ATTICUS_BIN) spawnSync(process.execPath, [process.env.ATTICUS_BIN, ...args], o);
// cmd expands %...% and reads " ^ & | < > ! even inside quotes: an argument holding one is
// never handed to the Windows shell (set ATTICUS_BIN to the bin.js to record from there).
else if (win && args.some((a) => /[%"^&|<>!]/.test(a))) process.exit(0);
else
  spawnSync(win ? "atticus.cmd" : "atticus", args.map((a) => (win ? `"${a}"` : a)), {
    ...o,
    shell: win,
  });
process.exit(0);
