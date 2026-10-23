// Starts `atticus mcp` for Claude Code (ADR 0104), on every platform: atticus on PATH (atticus.cmd
// on Windows), or the bin.js ATTICUS_BIN names. The protocol is on stdin and stdout.
import { spawn } from "node:child_process";

const win = process.platform === "win32";
const child = process.env.ATTICUS_BIN
  ? spawn(process.execPath, [process.env.ATTICUS_BIN, "mcp"], { stdio: "inherit" })
  : spawn(win ? "atticus.cmd" : "atticus", ["mcp"], { stdio: "inherit", shell: win });
child.on("error", (e) => {
  process.stderr.write(
    `Couldn't start atticus mcp (${e.message}). Install the atticus command line, or set ATTICUS_BIN to its bin.js.\n`,
  );
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 0));
