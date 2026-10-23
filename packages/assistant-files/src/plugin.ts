import { zeroInstallCommands } from "./commands.js";
import { claudeCommandContent } from "./render.js";
import { stepCommands } from "./steps.js";

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

/** The hook: finds the metarepo above the project folder and says its next step, or nothing. */
const SESSION_START = [
  "// The Atticus plugin's SessionStart hook (ADR 0104). What it prints is added to the session:",
  "// in an Atticus metarepo, the next step and how to take it; anywhere else, nothing.",
  'import { spawnSync } from "node:child_process";',
  'import { existsSync } from "node:fs";',
  'import { dirname, join } from "node:path";',
  "",
  "let root;",
  "for (let d = process.env.CLAUDE_PROJECT_DIR || process.cwd(); ; d = dirname(d)) {",
  '  if (existsSync(join(d, "org-pack")) || existsSync(join(d, ".atticus", "org-pack"))) {',
  "    root = d;",
  "    break;",
  "  }",
  "  if (dirname(d) === d) break;",
  "}",
  "if (!root) process.exit(0);",
  "",
  "// ATTICUS_BIN names the command line's bin.js; else atticus on PATH.",
  'const win = process.platform === "win32";',
  'const args = ["next", "--json", "--root", root];',
  "const r = process.env.ATTICUS_BIN",
  '  ? spawnSync(process.execPath, [process.env.ATTICUS_BIN, ...args], { encoding: "utf8", timeout: 20000 })',
  '  : spawnSync(win ? "atticus.cmd" : "atticus", args.map((a) => (win ? `"${a}"` : a)), {',
  '      encoding: "utf8",',
  "      timeout: 20000,",
  "      shell: win,",
  "    });",
  "let next;",
  "try {",
  "  next = JSON.parse(r.stdout).next;",
  "} catch {",
  "  next = undefined;",
  "}",
  "if (r.status !== 0 && next === undefined) {",
  "  console.log(",
  '    "This is an Atticus metarepo, but the atticus command line didn\'t answer. Install it (npm install -g @maycombhq/cli, or the offline bundle) to take its steps; the /atticus-* commands need it.",',
  "  );",
  "  process.exit(0);",
  "}",
  'const tools = "The atticus MCP tools read its catalog, knowledge, changes and needs.";',
  "if (!next) console.log(`This is an Atticus metarepo, and no step is waiting. ${tools}`);",
  "else",
  "  console.log(",
  "    `This is an Atticus metarepo. Next step: ${next.why} Run ${next.slash ? `${next.slash} (or ${next.command})` : next.command}. ${tools}`,",
  "  );",
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

const README = `# Atticus for Claude Code

The Atticus plugin for Claude Code (ADR 0104). Install it once and it works in every metarepo:

\`\`\`
/plugin marketplace add maycombhq/atticus
/plugin install atticus@maycombhq
\`\`\`

It needs the \`atticus\` command line on your PATH (or \`ATTICUS_BIN\` set to its \`bin.js\`).

- **Slash commands.** Every Atticus step: \`/atticus-next\`, \`/atticus-survey\`, \`/atticus-spec\`, \`/atticus-knowledge\`, \`/atticus-find\`, \`/atticus-feature\`, \`/atticus-architecture\`, \`/atticus-stories\`, \`/atticus-needs\`, \`/atticus-answer\`, and the catalog commands \`/atticus-ask\`, \`/atticus-impact\`, \`/atticus-critic\`, \`/atticus-plan\`, \`/atticus-snow\` and \`/atticus-release\`. Claude does the model work; Atticus checks every answer.
- **The next step.** When a session starts in a metarepo, Claude is told the next step and how to take it.
- **Read-only tools.** The \`atticus\` MCP server: the next step, the catalog, knowledge items, changes and their status, needs and findings, open questions, features, triage and manual steps. They read; to change anything Claude runs the command, and a person approves every write to a shared system.

The org pack's own agents, skills and commands come from \`atticus assistant-files\`, committed in the metarepo. A metarepo's \`.claude/commands\` win over the plugin's of the same name, so an organisation that changed its catalog or OpenSpec folders gets the right paths from its own files.

This folder is generated: \`pnpm claude-plugin\` writes it from the same commands \`atticus assistant-files\` renders.
`;

export function claudeCodePluginFiles(version: string): PluginFile[] {
  const commands = [
    ...zeroInstallCommands({ catalog: "catalog", openspec: "openspec" }),
    ...stepCommands(),
  ].sort((a, b) => a.name.localeCompare(b.name));
  return [
    {
      path: ".claude-plugin/plugin.json",
      content: json({
        name: "atticus",
        version,
        description:
          "Atticus in Claude Code: every step as a slash command, the next step when a session starts, and read-only tools over the catalog, knowledge, changes and needs.",
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
        },
      }),
    },
    { path: "hooks/session-start.mjs", content: SESSION_START },
    { path: "bin/atticus-mcp.mjs", content: MCP_LAUNCHER },
    { path: "README.md", content: README },
    ...commands.map((c) => ({ path: `commands/${c.name}.md`, content: claudeCommandContent(c) })),
  ];
}
