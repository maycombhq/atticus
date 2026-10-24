import { claudeCommandContent } from "./render.js";
import { metarepoCommands } from "./steps.js";

/**
 * The Claude Code plugin (ADR 0104), committed at plugins/atticus and listed in the repository's
 * marketplace (.claude-plugin/marketplace.json). It holds what is the same for every organisation:
 *
 * - the slash commands the metarepo's `.claude/commands` get (the steps and the catalog commands,
 *   for the default layout), byte for byte;
 * - a SessionStart hook that says the next step in a metarepo;
 * - the read-only `atticus mcp` server.
 *
 * The org pack's own agents, skills and commands stay with `atticus assistant-files`: they differ
 * per organisation, and a project's `.claude/commands` win over the plugin's of the same name.
 */

export interface PluginFile {
  path: string;
  content: string;
}

const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";

/** The metarepo above a folder: the one with org-pack/ (or .atticus/org-pack/), else none. */
const findMetarepo = (from: string) => [
  "let root;",
  `for (let d = ${from}; ; d = dirname(d)) {`,
  '  if (existsSync(join(d, "org-pack")) || existsSync(join(d, ".atticus", "org-pack"))) {',
  "    root = d;",
  "    break;",
  "  }",
  "  if (dirname(d) === d) break;",
  "}",
];

/** The hook: finds the metarepo above the project folder and says its next step, or nothing. */
const SESSION_START = [
  "// The Atticus plugin's SessionStart hook (ADR 0104). What it prints is added to the session:",
  "// in an Atticus metarepo, the next step and how to take it; anywhere else, nothing.",
  'import { spawnSync } from "node:child_process";',
  'import { existsSync } from "node:fs";',
  'import { dirname, join } from "node:path";',
  "",
  ...findMetarepo("process.env.CLAUDE_PROJECT_DIR || process.cwd()"),
  "if (!root) process.exit(0);",
  "",
  "// ATTICUS_BIN names the command line's bin.js; else atticus on PATH.",
  'const win = process.platform === "win32";',
  "const atticus = (...words) => {",
  '  const args = [...words, "--json", "--root", root];',
  "  const r = process.env.ATTICUS_BIN",
  '    ? spawnSync(process.execPath, [process.env.ATTICUS_BIN, ...args], { encoding: "utf8", timeout: 20000 })',
  '    : spawnSync(win ? "atticus.cmd" : "atticus", args.map((a) => (win ? `"${a}"` : a)), {',
  '        encoding: "utf8",',
  "        timeout: 20000,",
  "        shell: win,",
  "      });",
  "  try {",
  "    return JSON.parse(r.stdout);",
  "  } catch {",
  "    return undefined;",
  "  }",
  "};",
  'const read = atticus("next");',
  "const next = read?.next;",
  "if (read === undefined) {",
  "  console.log(",
  '    "This is an Atticus metarepo, but the atticus command line didn\'t answer. Install it (npm install -g @maycombhq/cli, or the offline bundle) to take its steps; the /atticus-* commands need it.",',
  "  );",
  "  process.exit(0);",
  "}",
  "// What waits on the person, counted (ADR 0105, 0106); said only when something does.",
  'const counts = atticus("waiting")?.counts;',
  'const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;',
  "const waits = counts",
  "  ? [",
  '      counts.needs && plural(counts.needs, "open need"),',
  '      counts.findings && plural(counts.findings, "open finding"),',
  '      counts.manualSteps && plural(counts.manualSteps, "manual step"),',
  '      counts.questions && plural(counts.questions, "open question"),',
  '      counts.knowledgeToVerify && `${plural(counts.knowledgeToVerify, "knowledge item")} to verify`,',
  "    ].filter(Boolean)",
  "  : [];",
  "const waiting = waits.length",
  '  ? ` Waiting on you: ${waits.join(", ")} (the waiting_on_you tool lists them by change).`',
  '  : "";',
  'const tools = "The atticus MCP tools read its catalog, knowledge, changes, needs and model runs.";',
  "if (!next) console.log(`This is an Atticus metarepo, and no step is next.${waiting} ${tools}`);",
  "else",
  "  console.log(",
  "    `This is an Atticus metarepo. Next step: ${next.why} Run ${next.slash ? `${next.slash} (or ${next.command})` : next.command}.${waiting} ${tools}`,",
  "  );",
  "",
].join("\n");

/**
 * The history hooks (ADR 0110): `history.mjs prompt` on UserPromptSubmit, `history.mjs response`
 * on Stop. In a metarepo each hands the text to `atticus history add` on stdin; it prints
 * nothing, so nothing is added to the conversation, and a failure never stops a prompt.
 */
const HISTORY_HOOK = [
  "// The Atticus plugin's history hooks (ADR 0110): each prompt (UserPromptSubmit) and each reply",
  "// (Stop) in an Atticus metarepo goes to `atticus history add`, kept in .atticus/history/ on this",
  "// machine. Prints nothing: what a UserPromptSubmit hook prints is added to the conversation.",
  "// The text is data: it goes to the command on stdin, never as an argument.",
  'import { spawnSync } from "node:child_process";',
  'import { existsSync, readFileSync } from "node:fs";',
  'import { dirname, join } from "node:path";',
  "",
  "const kind = process.argv[2];",
  'if (kind !== "prompt" && kind !== "response") process.exit(0);',
  "let input;",
  "try {",
  '  input = JSON.parse(readFileSync(0, "utf8"));',
  "} catch {",
  "  process.exit(0);",
  "}",
  ...findMetarepo("process.env.CLAUDE_PROJECT_DIR || input?.cwd || process.cwd()"),
  "if (!root) process.exit(0);",
  "",
  "// The reply: the transcript's last assistant message, every text of it, through its tool calls.",
  "function lastReply(file) {",
  "  let lines;",
  "  try {",
  '    lines = readFileSync(file, "utf8").split(/\\r?\\n/);',
  "  } catch {",
  "    return undefined;",
  "  }",
  "  const texts = [];",
  "  for (let i = lines.length - 1; i >= 0; i--) {",
  "    let e;",
  "    try {",
  "      e = JSON.parse(lines[i]);",
  "    } catch {",
  "      continue;",
  "    }",
  "    const content = e?.message?.content;",
  '    if (e?.type === "assistant" && Array.isArray(content)) {',
  "      const t = content",
  '        .filter((b) => b?.type === "text" && typeof b.text === "string")',
  "        .map((b) => b.text)",
  '        .join("\\n\\n");',
  "      if (t.trim()) texts.unshift(t);",
  '    } else if (e?.type === "user") {',
  "      // A tool's result belongs to the reply; anything else the person sent began it.",
  "      const fromTool =",
  "        Array.isArray(content) &&",
  "        content.length > 0 &&",
  '        content.every((b) => b?.type === "tool_result");',
  "      if (!fromTool) break;",
  "    }",
  "  }",
  '  return texts.length ? texts.join("\\n\\n") : undefined;',
  "}",
  "",
  "const text =",
  '  kind === "prompt"',
  '    ? typeof input?.prompt === "string"',
  "      ? input.prompt",
  "      : undefined",
  '    : typeof input?.transcript_path === "string"',
  "      ? lastReply(input.transcript_path)",
  "      : undefined;",
  "if (!text || !text.trim()) process.exit(0);",
  "",
  "// ATTICUS_BIN names the command line's bin.js; else atticus on PATH.",
  'const win = process.platform === "win32";',
  'const session = typeof input.session_id === "string" ? input.session_id : "";',
  "const args = [",
  '  "history",',
  '  "add",',
  '  "--surface",',
  '  "claude-code",',
  '  "--kind",',
  "  kind,",
  '  ...(/^[\\w.-]+$/.test(session) ? ["--session", session] : []),',
  '  "--root",',
  "  root,",
  "];",
  'const o = { input: text, encoding: "utf8", timeout: 15000, stdio: ["pipe", "ignore", "ignore"] };',
  "if (process.env.ATTICUS_BIN) spawnSync(process.execPath, [process.env.ATTICUS_BIN, ...args], o);",
  '// cmd expands %...% and reads " ^ & | < > ! even inside quotes: an argument holding one is',
  "// never handed to the Windows shell (set ATTICUS_BIN to the bin.js to record from there).",
  'else if (win && args.some((a) => /[%"^&|<>!]/.test(a))) process.exit(0);',
  "else",
  '  spawnSync(win ? "atticus.cmd" : "atticus", args.map((a) => (win ? `"${a}"` : a)), {',
  "    ...o,",
  "    shell: win,",
  "  });",
  "process.exit(0);",
  "",
].join("\n");

/** The MCP server's launcher: atticus mcp, found the way a person's terminal finds it. */
const MCP_LAUNCHER = [
  "// Starts `atticus mcp` for Claude Code (ADR 0104), on every platform: atticus on PATH (atticus.cmd",
  "// on Windows), or the bin.js ATTICUS_BIN names. The protocol is on stdin and stdout.",
  'import { spawn } from "node:child_process";',
  "",
  'const win = process.platform === "win32";',
  "const child = process.env.ATTICUS_BIN",
  '  ? spawn(process.execPath, [process.env.ATTICUS_BIN, "mcp"], { stdio: "inherit" })',
  '  : spawn(win ? "atticus.cmd" : "atticus", ["mcp"], { stdio: "inherit", shell: win });',
  'child.on("error", (e) => {',
  "  process.stderr.write(",
  "    `Couldn't start atticus mcp (${e.message}). Install the atticus command line, or set ATTICUS_BIN to its bin.js.\\n`,",
  "  );",
  "  process.exit(1);",
  "});",
  'child.on("exit", (code) => process.exit(code ?? 0));',
  "",
].join("\n");

/** The README, with the slash commands listed from the one list (ADR 0119), so none is left out. */
const readme = (commands: string[]) => `# Atticus for Claude Code

The Atticus plugin for Claude Code (ADR 0104). Install it once and it works in every metarepo:

\`\`\`
/plugin marketplace add maycombhq/atticus
/plugin install atticus@maycombhq
\`\`\`

It needs the \`atticus\` command line on your PATH (or \`ATTICUS_BIN\` set to its \`bin.js\`).

- **Slash commands.** Every Atticus step and catalog command: ${commands.map((c) => `\`/${c}\``).join(", ")}. Claude does the model work; Atticus checks every answer. \`/atticus-next\` says which comes next.
- **The next step.** When a session starts in a metarepo, Claude is told the next step and how to take it, and how much waits on you.
- **Prompt history.** In a metarepo, each prompt you send and each reply Claude gives is kept in \`.atticus/history/\` on your machine (never committed), with its session and the change it is about; the app's Prompt history screen and \`atticus history\` show them. \`atticus history off\` stops it on your machine, and \`history: { record: false }\` in the org pack's \`runtime.yaml\` for everyone (ADR 0110).
- **Read-only tools.** The \`atticus\` MCP server: the next step; what waits on you across every change, grouped by change, with a filter; the open needs; the model runs, each with its prompt, answer and the problems handed back; the prompt history; the catalog, knowledge items, changes and their status, a change's picture (marked + new, ◇ changed, ✕ retired, as Mermaid) its estimate and whether the code does what its target flows say, a task's context (its story, criteria, step, today's code and the files to change), findings, open questions, features, triage and manual steps; and the code itself, searched by what Claude chooses (grep, files and a file's outline, ADR 0118). They read; to change anything Claude runs the command, and a person approves every write to a shared system.

The org pack's own agents, skills and commands come from \`atticus assistant-files\`, committed in the metarepo. A metarepo's \`.claude/commands\` win over the plugin's of the same name, so an organisation that changed its catalog or OpenSpec folders gets the right paths from its own files.

This folder is generated: \`pnpm claude-plugin\` writes it from the same commands \`atticus assistant-files\` renders.
`;

export function claudeCodePluginFiles(version: string): PluginFile[] {
  const commands = metarepoCommands();
  return [
    {
      path: ".claude-plugin/plugin.json",
      content: json({
        name: "atticus",
        version,
        description:
          "Atticus in Claude Code: every step as a slash command, the next step when a session starts, read-only tools over the catalog, knowledge, changes and needs, and a history of the prompts and replies in a metarepo, kept on your machine.",
        author: { name: "Maycomb" },
        homepage: "https://github.com/maycombhq/atticus",
        repository: "https://github.com/maycombhq/atticus",
        license: "Apache-2.0",
        icon: ".claude-plugin/icon.png",
        keywords: ["architecture", "catalog", "openspec", "knowledge", "metarepo"],
      }),
    },
    {
      path: ".mcp.json",
      content: json({
        mcpServers: {
          atticus: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/bin/atticus-mcp.mjs"] },
        },
      }),
    },
    {
      path: "hooks/hooks.json",
      content: json({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs"',
                  timeout: 30,
                },
              ],
            },
          ],
          // ADR 0110: each prompt and each reply in a metarepo, kept in .atticus/history/.
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: "command",
                  command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/history.mjs" prompt',
                  timeout: 20,
                },
              ],
            },
          ],
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/history.mjs" response',
                  timeout: 20,
                },
              ],
            },
          ],
        },
      }),
    },
    { path: "hooks/session-start.mjs", content: SESSION_START },
    { path: "hooks/history.mjs", content: HISTORY_HOOK },
    { path: "bin/atticus-mcp.mjs", content: MCP_LAUNCHER },
    { path: "README.md", content: readme(commands.map((c) => c.name)) },
    ...commands.map((c) => ({ path: `commands/${c.name}.md`, content: claudeCommandContent(c) })),
  ];
}
