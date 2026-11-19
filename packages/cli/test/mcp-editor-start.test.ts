import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { atticusMcpServer } from "@maycombhq/assistant-files";
import { MCP_TOOLS } from "../src/mcp.js";
import { VERSION } from "../src/version.js";

/**
 * Beta.30: an editor can start the Atticus map tools from the files Atticus writes, on Windows
 * too. Each entry (the one `.vscode/mcp.json` and `.mcp.json` get, the committed
 * `plugins/copilot/.vscode/mcp.json`, and the Claude Code plugin's `.mcp.json`) is started here
 * exactly as it is written: its command with its arguments, no shell, which is the least an editor
 * does. `atticus` is installed the way npm installs it: a folder first on PATH with `atticus.cmd`
 * on Windows (a shell script elsewhere) that runs the built command line. Then the MCP handshake
 * and `tools/list` go over stdin and stdout, and the tools come back.
 *
 * Runs on every platform, skipped nowhere. The last test holds the reason for the launcher: on
 * Windows a bare `atticus` can't be started without a shell at all.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../../..");
const BIN = join(HERE, "../dist/bin.js");
const WIN = process.platform === "win32";

type Entry = { command: string; args: readonly string[] };
type Reply = { id?: number; result?: Record<string, unknown>; error?: unknown };

/**
 * Each start is three processes one after another (node with the launcher, the shell or the
 * shim, then the command line's own Node), which a loaded machine takes its time over.
 */
const START = 30_000;

let env: NodeJS.ProcessEnv;
let cwd: string;

beforeAll(async () => {
  const shims = await mkdtemp(join(tmpdir(), "atticus-mcp-shim-"));
  cwd = await mkdtemp(join(tmpdir(), "atticus-mcp-cwd-"));
  if (WIN)
    // What npm and the offline bundle's install.ps1 leave on PATH: a .cmd, no .exe.
    await writeFile(
      join(shims, "atticus.cmd"),
      `@ECHO off\r\n"${process.execPath}" "${BIN}" %*\r\n`,
    );
  else {
    await writeFile(
      join(shims, "atticus"),
      `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`,
    );
    await chmod(join(shims, "atticus"), 0o755);
  }
  // Windows names it Path; one PATH, with the shim first and this Node as `node`.
  const rest = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k.toUpperCase() !== "PATH"),
  );
  const path = process.env.PATH ?? process.env.Path ?? "";
  env = {
    ...rest,
    PATH: [shims, dirname(process.execPath), path].join(delimiter),
  };
});

/** Start an entry as written, shake hands, list the tools, close stdin; what came back. */
async function listTools(entry: Entry): Promise<{
  server: Record<string, unknown>;
  tools: string[];
  code: number | null;
  stderr: string;
}> {
  const child = spawn(entry.command, [...entry.args], {
    shell: false,
    env,
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  // A command that can't be started has no stdin to take the first request.
  child.stdin.on("error", () => undefined);
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  const waiting = new Map<number, (r: Reply) => void>();
  let buffer = "";
  child.stdout.on("data", (d: Buffer) => {
    buffer += d.toString();
    for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      const r = JSON.parse(line) as Reply;
      if (r.id !== undefined) waiting.get(r.id)?.(r);
    }
  });
  const ended = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  });
  const ask = (id: number, method: string, params?: unknown) =>
    Promise.race([
      new Promise<Reply>((resolve) => {
        waiting.set(id, resolve);
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      }),
      ended.then((code) => {
        throw new Error(`the server ended (${code}) before answering ${method}: ${stderr}`);
      }),
    ]);
  try {
    const init = await ask(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "an-editor", version: "1" },
    });
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
    );
    const list = await ask(2, "tools/list");
    // An editor closes stdin to stop the server; it ends on its own, launcher and all.
    child.stdin.end();
    const code = await ended;
    return {
      server: init.result?.serverInfo as Record<string, unknown>,
      tools: (list.result?.tools as { name: string }[]).map((t) => t.name),
      code,
      stderr,
    };
  } finally {
    child.kill();
  }
}

/** The error starting a command without a shell gives, thrown or sent; undefined when it starts. */
async function spawnError(command: string): Promise<string | undefined> {
  try {
    const child = spawn(command, ["mcp"], { shell: false, env, cwd, stdio: "ignore" });
    return await new Promise((resolve) => {
      child.on("error", (e: NodeJS.ErrnoException) => resolve(e.code));
      child.on("spawn", () => {
        child.kill();
        resolve(undefined);
      });
    });
  } catch (e) {
    return (e as NodeJS.ErrnoException).code;
  }
}

const expectTools = async (entry: Entry) => {
  const r = await listTools(entry);
  expect(r.server).toEqual({ name: "atticus", version: VERSION });
  expect(r.tools).toEqual(MCP_TOOLS.map((t) => t.name));
  expect(r.code).toBe(0);
  // Nothing on stderr: no deprecation warning from Node, no shell complaint.
  expect(r.stderr).toBe("");
};

describe("an editor starts atticus mcp from the files Atticus writes (beta.30)", () => {
  it(
    "the entry .vscode/mcp.json and .mcp.json get: started as written, it lists the tools",
    async () => {
      await expectTools(atticusMcpServer());
    },
    START,
  );

  it(
    "the committed plugins/copilot/.vscode/mcp.json: started as written, it lists the tools",
    async () => {
      const file = JSON.parse(
        await readFile(join(REPO, "plugins/copilot/.vscode/mcp.json"), "utf8"),
      ) as { servers: { atticus: Entry & { type: string } } };
      expect(file.servers.atticus.type).toBe("stdio");
      await expectTools(file.servers.atticus);
    },
    START,
  );

  it(
    "the Claude Code plugin's .mcp.json: started as written, it lists the tools",
    async () => {
      const plugin = join(REPO, "plugins/atticus");
      const file = JSON.parse(await readFile(join(plugin, ".mcp.json"), "utf8")) as {
        mcpServers: { atticus: Entry };
      };
      // Claude Code puts the plugin's folder where the file says ${CLAUDE_PLUGIN_ROOT}.
      const { command, args } = file.mcpServers.atticus;
      const r = await listTools({
        command,
        args: args.map((a) => a.replace("${CLAUDE_PLUGIN_ROOT}", plugin)),
      });
      expect(r.tools).toEqual(MCP_TOOLS.map((t) => t.name));
      expect(r.code).toBe(0);
    },
    START,
  );

  // On Windows an editor ends a process with TerminateProcess, which no program is told of, so
  // there is nothing to test there; what the launcher does when it is told is unit-tested with
  // the platform passed in (assistant-files/test/mcp-server.test.ts).
  it.skipIf(WIN)(
    "told to end, the launcher ends the server too, though the server's stdin is still open",
    async () => {
      // A shim that says which process the server is before it becomes it.
      const shims = await mkdtemp(join(tmpdir(), "atticus-mcp-shim-"));
      const pidFile = join(shims, "server.pid");
      await writeFile(
        join(shims, "atticus"),
        `#!/bin/sh\necho $$ > "${pidFile}"\nexec "${process.execPath}" "${BIN}" "$@"\n`,
      );
      await chmod(join(shims, "atticus"), 0o755);
      const entry = atticusMcpServer();
      const child = spawn(entry.command, entry.args, {
        shell: false,
        env: { ...env, PATH: [shims, env.PATH].join(delimiter) },
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });
      try {
        // The server answers, so it is up; its stdin stays open, as an editor that only ends the
        // process leaves it.
        await new Promise<void>((resolve, reject) => {
          child.on("error", reject);
          child.stdout.once("data", () => resolve());
          child.stdin.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "an-editor", version: "1" },
              },
            }) + "\n",
          );
        });
        const server = Number((await readFile(pidFile, "utf8")).trim());
        expect(server).toBeGreaterThan(0);
        expect(server).not.toBe(child.pid);
        const alive = () => {
          try {
            process.kill(server, 0);
            return true;
          } catch {
            return false;
          }
        };
        expect(alive()).toBe(true);
        const ended = new Promise<number | null>((resolve) => child.on("exit", resolve));
        child.kill("SIGTERM");
        expect(await ended).toBe(1);
        for (let i = 0; i < 100 && alive(); i++) await new Promise((r) => setTimeout(r, 50));
        expect(alive()).toBe(false);
      } finally {
        child.kill("SIGKILL");
      }
    },
    START,
  );

  it(
    "why not a bare atticus: without a shell Windows can't start it, the others can",
    async () => {
      const bare = { command: "atticus", args: ["mcp"] };
      if (!WIN) {
        await expectTools(bare);
        return;
      }
      // Windows looks for atticus.com and atticus.exe, never atticus.cmd: nothing to start.
      expect(await spawnError(bare.command)).toBe("ENOENT");
      // And named in full, Node refuses a .cmd without a shell (CVE-2024-27980's fix).
      expect(await spawnError("atticus.cmd")).toBe("EINVAL");
    },
    START,
  );
});
