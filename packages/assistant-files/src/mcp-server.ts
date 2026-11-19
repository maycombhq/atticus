/**
 * The `atticus` MCP server entry for the files editors read: `.vscode/mcp.json` (VS Code, GitHub
 * Copilot) and `.mcp.json` (Claude Code). One committed file has to start `atticus mcp` on
 * Windows, macOS and Linux, and neither file has a per-platform form.
 *
 * On Windows `atticus` is `atticus.cmd` (npm's shim, and the offline bundle's), and a program can
 * start a `.cmd` only through a shell (Node refuses otherwise since CVE-2024-27980's fix).
 * Editors differ in whether they do that: VS Code finds the `.cmd` and uses a shell, Claude Code
 * has needed `cmd /c` written in the file in some versions and not in others. So the entry
 * depends on none of them: it starts `node`, which Atticus needs on PATH anyway and which is
 * `node.exe` where Node was installed by its own installer, with a one-line launcher that starts
 * `atticus` the way the platform needs. Where a version manager puts a `node.cmd` on PATH in its
 * place, the editor has to start that through a shell, as it had to start `atticus.cmd`; the
 * launcher is written so that it comes through one unchanged, and that case is not tested here.
 */

/**
 * The launcher `node -e` runs. On Windows `atticus mcp` goes through the shell as one string, so
 * cmd.exe finds `atticus.cmd` by PATHEXT and Node has no arguments to warn about; elsewhere
 * `atticus` is started itself. The protocol is on stdin and stdout, which the server inherits.
 *
 * On Windows the shell is given `NoDefaultCurrentDirectoryInExePath=1`: cmd.exe looks in the
 * current folder before PATH unless it is set, and the current folder is the workspace, so an
 * `atticus.cmd` committed at a repo's root would be started in place of the installed one.
 *
 * When the launcher is told to end (SIGTERM, SIGINT, SIGHUP) or exits for any reason, it ends the
 * server too. On Windows that is `taskkill /pid <pid> /T /F`: the child is cmd.exe, and ending it
 * alone leaves `atticus.cmd`'s Node running. taskkill is called by its path under `SystemRoot`
 * (written with a forward slash, which Windows takes), since a bare name is looked for in the
 * current folder first; by its name only where `SystemRoot` isn't set. It is given five seconds.
 * A launcher ended with no notice (TerminateProcess, SIGKILL) can do nothing; the server still
 * ends when its stdin closes.
 *
 * Written with single quotes and none of the characters cmd.exe reads (`"`, `%`, `^`, `&`, `|`,
 * `<`, `>`, `!`), so the text is the same after a shell has read it, should an editor start
 * `node` through one.
 */
export const ATTICUS_MCP_LAUNCHER = [
  "var w=process.platform==='win32',p=require('node:child_process'),e=process.env,d=0;",
  "if(w)e=Object.assign({},e,{NoDefaultCurrentDirectoryInExePath:'1'});",
  "var c=p.spawn(w?'atticus mcp':'atticus',w?[]:['mcp'],{stdio:'inherit',shell:w,windowsHide:true,env:e});",
  "function k(){if(d)return;d=1;if(c.pid==null)return;try{if(w)p.spawnSync(e.SystemRoot?e.SystemRoot+'/System32/taskkill.exe':'taskkill',['/pid',String(c.pid),'/T','/F'],{stdio:'ignore',windowsHide:true,timeout:5000});else c.kill()}catch(x){}}",
  "c.on('error',function(x){d=1;console.error('Could not start atticus mcp ('+x.message+'). Install the atticus command line and put it on PATH.');process.exit(1)});",
  "c.on('exit',function(x){d=1;process.exit(x==null?1:x)});",
  "['SIGTERM','SIGINT','SIGHUP'].forEach(function(s){process.on(s,function(){k();process.exit(1)})});",
  "process.on('exit',k)",
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
