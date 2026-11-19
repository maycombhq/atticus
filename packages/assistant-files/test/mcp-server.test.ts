import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { ATTICUS_MCP_LAUNCHER, atticusMcpServer, copilotAgentFiles } from "../src/index.js";

/**
 * Beta.30: the `atticus` MCP server entry written to `.vscode/mcp.json` (VS Code, GitHub Copilot)
 * and `.mcp.json` (Claude Code). One committed file has to start the server on Windows, macOS and
 * Linux, and neither file has a per-platform form. On Windows `atticus` is `atticus.cmd`, which a
 * program can start only through a shell, and editors differ in whether they do that. So the entry
 * starts `node`, a real program on every platform, with a one-line launcher that starts `atticus`
 * the way that platform needs. The launcher is run here with the platform passed in.
 */

type Spawned = { command: string; args: string[]; options: Record<string, unknown> };

/** Run the launcher as `node -e` would, on a platform, with nothing started. */
function launch(platform: NodeJS.Platform) {
  const spawned: Spawned[] = [];
  const handlers = new Map<string, (v: unknown) => void>();
  const exits: number[] = [];
  const errors: string[] = [];
  runInNewContext(ATTICUS_MCP_LAUNCHER, {
    process: { platform, exit: (c: number) => exits.push(c) },
    console: { error: (m: string) => errors.push(m) },
    require: (name: string) => {
      expect(name).toBe("node:child_process");
      return {
        spawn: (command: string, args: string[], options: Record<string, unknown>) => {
          spawned.push({ command, args, options });
          return { on: (e: string, f: (v: unknown) => void) => handlers.set(e, f) };
        },
      };
    },
  });
  return { spawned, handlers, exits, errors };
}

describe("the atticus MCP server entry (beta.30)", () => {
  it("starts node, which every platform can start without a shell, with the launcher", () => {
    expect(atticusMcpServer()).toEqual({
      type: "stdio",
      command: "node",
      args: ["-e", ATTICUS_MCP_LAUNCHER],
    });
    // A new object each time: a caller may add to its own.
    expect(atticusMcpServer()).not.toBe(atticusMcpServer());
  });

  it("is what .vscode/mcp.json registers", () => {
    const file = copilotAgentFiles("1.2.3").find((f) => f.path === ".vscode/mcp.json")!;
    expect(JSON.parse(file.content)).toEqual({ servers: { atticus: atticusMcpServer() } });
  });

  it("on Windows starts atticus through the shell, which finds atticus.cmd, with no window", () => {
    const { spawned } = launch("win32");
    // One string and no arguments: cmd.exe resolves atticus.cmd (or .exe) by PATHEXT, and Node
    // has nothing to warn about (arguments with a shell are deprecated, DEP0190).
    expect(spawned).toEqual([
      {
        command: "atticus mcp",
        args: [],
        options: { stdio: "inherit", shell: true, windowsHide: true },
      },
    ]);
  });

  it.each(["darwin", "linux"] as const)("on %s starts atticus mcp itself, no shell", (platform) => {
    expect(launch(platform).spawned).toEqual([
      {
        command: "atticus",
        args: ["mcp"],
        options: { stdio: "inherit", shell: false, windowsHide: true },
      },
    ]);
  });

  it.each(["win32", "darwin", "linux"] as const)(
    "on %s ends with the server's exit code, and says what to do when atticus isn't found",
    (platform) => {
      const a = launch(platform);
      a.handlers.get("exit")!(3);
      expect(a.exits).toEqual([3]);
      // Ended by a signal: no code, which is not a success.
      const b = launch(platform);
      b.handlers.get("exit")!(null);
      expect(b.exits).toEqual([1]);
      const c = launch(platform);
      c.handlers.get("error")!(new Error("spawn atticus ENOENT"));
      expect(c.errors).toEqual([
        "Could not start atticus mcp (spawn atticus ENOENT). Install the atticus command line and put it on PATH.",
      ]);
      expect(c.exits).toEqual([1]);
    },
  );

  it("has no character a Windows shell would read, should an editor start node through one", () => {
    // VS Code quotes each argument when the command it finds is a .cmd (a node.cmd wrapper, say).
    // Inside quotes cmd.exe still reads % and ", and ^ & | < > ! outside them.
    expect(ATTICUS_MCP_LAUNCHER).not.toMatch(/["%^&|<>!\r\n`$\\]/);
    expect(ATTICUS_MCP_LAUNCHER.length).toBeLessThan(500);
  });
});
