import { describe, expect, it } from "vitest";
import { needsShell, quoteForCmd } from "../src/copilot-acp.js";

/**
 * Review round 25B: npm installs `claude` (and `copilot`) as a .cmd shim on Windows, which
 * runs only through cmd.exe; headless Claude Code spawns it so, as the Copilot ACP server is.
 */
describe("a command on Windows", () => {
  it("runs a .cmd shim or a bare name through cmd.exe, an .exe directly, and nothing so elsewhere", () => {
    expect(needsShell("claude", "win32")).toBe(true);
    expect(needsShell("C:\\\\npm\\\\claude.cmd", "win32")).toBe(true);
    expect(needsShell("C:\\\\tools\\\\claude.exe", "win32")).toBe(false);
    expect(needsShell("claude", "linux")).toBe(false);
    expect(needsShell("claude", "darwin")).toBe(false);
  });

  it("quotes an argument with a space or a quote for cmd.exe", () => {
    expect(quoteForCmd("--output-format")).toBe("--output-format");
    expect(quoteForCmd("C:\\\\Program Files\\\\x")).toBe('"C:\\\\Program Files\\\\x"');
    expect(quoteForCmd('say "hi"')).toBe('"say ""hi"""');
  });
});
