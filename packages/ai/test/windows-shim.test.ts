import { describe, expect, it } from "vitest";
import { needsShell, quoteForCmd } from "../src/copilot-acp.js";
import { collectChild, quoteForCmdAlways, resolveWindowsCommand } from "../src/factory.js";
import { EventEmitter } from "node:events";

/**
 * Review rounds 25B and 27: npm installs `claude` as a .cmd shim on Windows, which runs only
 * through cmd.exe; the native installer's claude.exe runs directly. A shim's words are quoted,
 * and its timeout ends its whole tree.
 */
describe("a command on Windows", () => {
  it("runs a .cmd shim or a bare name through cmd.exe, an .exe directly, and nothing so elsewhere", () => {
    expect(needsShell("claude", "win32")).toBe(true);
    expect(needsShell("C:\\npm\\claude.cmd", "win32")).toBe(true);
    expect(needsShell("C:\\tools\\claude.exe", "win32")).toBe(false);
    expect(needsShell("claude", "linux")).toBe(false);
  });

  it("quotes an argument with a space or a quote for cmd.exe", () => {
    expect(quoteForCmd("--output-format")).toBe("--output-format");
    expect(quoteForCmd("C:\\Program Files\\x")).toBe('"C:\\Program Files\\x"');
    expect(quoteForCmd('say "hi"')).toBe('"say ""hi"""');
  });

  it("finds claude on PATH as Windows does: the .exe first, else npm's .cmd", () => {
    const env = {
      Path: "C:\\tools;C:\\Users\\dev\\AppData\\Roaming\\npm",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    };
    const on = (files: string[]) => (p: string) => files.includes(p);
    expect(resolveWindowsCommand("claude", env, "win32", on(["C:\\tools\\claude.exe"]))).toBe(
      "C:\\tools\\claude.exe",
    );
    expect(
      resolveWindowsCommand(
        "claude",
        env,
        "win32",
        on(["C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd"]),
      ),
    ).toBe("C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd");
    // A quoted PATH entry, as Windows keeps some.
    expect(
      resolveWindowsCommand(
        "claude",
        { Path: 'C:\\Windows;"C:\\Users\\tom\\AppData\\Roaming\\npm"' },
        "win32",
        on(["C:\\Users\\tom\\AppData\\Roaming\\npm\\claude.cmd"]),
      ),
    ).toBe("C:\\Users\\tom\\AppData\\Roaming\\npm\\claude.cmd");
    // Not there: the bare name, so starting it says it isn't installed (ENOENT).
    expect(resolveWindowsCommand("claude", env, "win32", on([]))).toBe("claude");
    expect(resolveWindowsCommand("claude", env, "linux", on([]))).toBe("claude");
  });

  it("quotes every word for a shim, so & ^ | in a metarepo path stay part of it", () => {
    expect(quoteForCmdAlways("C:\\work\\R&D\\forge-meta")).toBe('"C:\\work\\R&D\\forge-meta"');
    expect(quoteForCmdAlways("--add-dir")).toBe('"--add-dir"');
    expect(quoteForCmdAlways('a"b')).toBe('"a""b"');
  });

  it("ends a child the way it is told when the time runs out", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: Object.assign(new EventEmitter(), { end: () => undefined }),
      stdout: Object.assign(new EventEmitter(), { setEncoding: () => child.stdout }),
      stderr: Object.assign(new EventEmitter(), { setEncoding: () => child.stderr }),
      kill: () => undefined,
    });
    let stopped = 0;
    const p = collectChild(
      () => child as never,
      "",
      20,
      undefined,
      "win32",
      () => {
        stopped++;
        child.emit("close", null);
      },
    );
    await p;
    expect(stopped).toBe(1);
  });
});
