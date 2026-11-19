/**
 * The `atticus` MCP server entry for the files editors read: `.vscode/mcp.json` (VS Code, GitHub
 * Copilot) and `.mcp.json` (Claude Code). One committed file has to start `atticus mcp` on
 * Windows, macOS and Linux, and neither file has a per-platform form.
 *
 * On Windows `atticus` is `atticus.cmd` (npm's shim, and the offline bundle's), and a program can
 * start a `.cmd` only through a shell (Node refuses otherwise since CVE-2024-27980's fix).
 * Editors differ in whether they do that: VS Code finds the `.cmd` and uses a shell, Claude Code
 * has needed `cmd /c` written in the file in some versions and not in others. So the entry
 * depends on none of them: it starts `node`, a real program wherever Atticus runs (Atticus needs
 * it on PATH), with a one-line launcher that starts `atticus` the way the platform needs.
 */

/**
 * The launcher `node -e` runs. On Windows `atticus mcp` goes through the shell as one string, so
 * cmd.exe finds `atticus.cmd` by PATHEXT and Node has no arguments to warn about; elsewhere
 * `atticus` is started itself. The protocol is on stdin and stdout, which the server inherits.
 *
 * Written with single quotes and none of the characters cmd.exe reads (`"`, `%`, `^`, `&`, `|`,
 * `<`, `>`, `!`), so it survives an editor that starts `node` itself through a shell.
 */
export const ATTICUS_MCP_LAUNCHER = [
  "var w=process.platform==='win32';",
  "var c=require('node:child_process').spawn(w?'atticus mcp':'atticus',w?[]:['mcp'],{stdio:'inherit',shell:w,windowsHide:true});",
  "c.on('error',function(e){console.error('Could not start atticus mcp ('+e.message+'). Install the atticus command line and put it on PATH.');process.exit(1)});",
  "c.on('exit',function(x){process.exit(x==null?1:x)})",
].join("");

/** One stdio server as `.vscode/mcp.json` and `.mcp.json` both take it. */
export interface AtticusMcpServer {
  type: "stdio";
  command: string;
  args: string[];
}

/** The read-only map tools as an MCP server entry: `atticus mcp` over stdio, on every platform. */
export function atticusMcpServer(): AtticusMcpServer {
  return { type: "stdio", command: "node", args: ["-e", ATTICUS_MCP_LAUNCHER] };
}
