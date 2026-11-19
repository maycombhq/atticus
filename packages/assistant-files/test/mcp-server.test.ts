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

/** The environment the launcher is started in, in these tests. */
const ENV = { PATH: "/usr/bin", FORGE: "1" };
/** The server's process id, in these tests. */
const PID = 4321;

/** Run the launcher as `node -e` would, on a platform, with nothing started. */
function launch(platform: NodeJS.Platform, o: { pid?: number | undefined } = { pid: PID }) {
  const spawned: Spawned[] = [];
  const sync: Spawned[] = [];
  const handlers = new Map<string, (v: unknown) => void>();
  const own = new Map<string, () => void>();
  const exits: number[] = [];
  const errors: string[] = [];
  let kills = 0;
  const env = { ...ENV };
  runInNewContext(ATTICUS_MCP_LAUNCHER, {
    process: {
      platform,
      env,
      exit: (c: number) => exits.push(c),
      on: (e: string, f: () => void) => own.set(e, f),
    },
    console: { error: (m: string) => errors.push(m) },
    require: (name: string) => {
      expect(name).toBe("node:child_process");
      return {
        spawn: (command: string, args: string[], options: Record<string, unknown>) => {
          spawned.push({ command, args, options });
          return {
            pid: o.pid,
            kill: () => kills++,
            on: (e: string, f: (v: unknown) => void) => handlers.set(e, f),
          };
        },
        spawnSync: (command: string, args: string[], options: Record<string, unknown>) => {
          sync.push({ command, args, options });
          return { status: 0 };
        },
      };
    },
  });
  return { spawned, sync, handlers, own, exits, errors, env, kills: () => kills };
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
        options: {
          stdio: "inherit",
          shell: true,
          windowsHide: true,
          // cmd.exe looks in the current folder before PATH unless this is set: an atticus.cmd
          // at the workspace's root must never win over the one that is installed.
          env: { ...ENV, NoDefaultCurrentDirectoryInExePath: "1" },
        },
      },
    ]);
  });

  it("on Windows leaves its own environment as it was", () => {
    expect(launch("win32").env).toEqual(ENV);
  });

  it.each(["darwin", "linux"] as const)("on %s starts atticus mcp itself, no shell", (platform) => {
    expect(launch(platform).spawned).toEqual([
      {
        command: "atticus",
        args: ["mcp"],
        options: { stdio: "inherit", shell: false, windowsHide: true, env: ENV },
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

  const TASKKILL = {
    command: "taskkill",
    args: ["/pid", String(PID), "/T", "/F"],
    options: { stdio: "ignore", windowsHide: true },
  };

  it.each(["SIGTERM", "SIGINT", "SIGHUP"])(
    "told to end (%s), it ends the server too: the shell's whole tree on Windows",
    (signal) => {
      // cmd.exe, atticus.cmd and the node it starts: ending the shell alone leaves the server.
      const w = launch("win32");
      w.own.get(signal)!();
      expect(w.sync).toEqual([TASKKILL]);
      expect(w.kills()).toBe(0);
      expect(w.exits).toEqual([1]);
      // The exit that follows doesn't end it twice.
      w.own.get("exit")!();
      expect(w.sync).toHaveLength(1);

      const l = launch("linux");
      l.own.get(signal)!();
      expect(l.kills()).toBe(1);
      expect(l.sync).toEqual([]);
      expect(l.exits).toEqual([1]);
      l.own.get("exit")!();
      expect(l.kills()).toBe(1);
    },
  );

  it("ends the server when it exits for any other reason, and never one that has ended", () => {
    const w = launch("win32");
    w.own.get("exit")!();
    expect(w.sync).toEqual([TASKKILL]);
    const l = launch("darwin");
    l.own.get("exit")!();
    expect(l.kills()).toBe(1);

    // The server ended on its own: nothing is left to end, and no other process has its id.
    for (const platform of ["win32", "linux"] as const) {
      const a = launch(platform);
      a.handlers.get("exit")!(0);
      a.own.get("exit")!();
      a.own.get("SIGTERM")!();
      expect(a.sync).toEqual([]);
      expect(a.kills()).toBe(0);
      // It never started: there is no process to end.
      const b = launch(platform, { pid: undefined });
      b.own.get("exit")!();
      expect(b.sync).toEqual([]);
      expect(b.kills()).toBe(0);
      const c = launch(platform);
      c.handlers.get("error")!(new Error("spawn atticus ENOENT"));
      c.own.get("exit")!();
      expect(c.sync).toEqual([]);
      expect(c.kills()).toBe(0);
    }
  });

  it("has no character a Windows shell would read, should an editor start node through one", () => {
    // VS Code quotes each argument when the command it finds is a .cmd (a node.cmd wrapper, say).
    // Inside quotes cmd.exe still reads % and ", and ^ & | < > ! outside them.
    expect(ATTICUS_MCP_LAUNCHER).not.toMatch(/["%^&|<>!\r\n`$\\]/);
    expect(ATTICUS_MCP_LAUNCHER.length).toBeLessThan(1000);
  });
});
