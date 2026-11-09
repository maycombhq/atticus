import { describe, expect, it } from "vitest";
import { terminalLine, type Command } from "../src/cli";

/**
 * Review round 46: a command typed into a terminal starts with the atticus the setting
 * atticus.path names (as resolveCommand resolved it), not a bare `atticus` that may not be there.
 */
const bare: Command = { file: "atticus", prefix: [], shell: false };
const js: Command = {
  file: "node",
  prefix: ["C:\\Users\\dev\\tools\\atticus\\dist\\bin.js"],
  shell: false,
};
const spaced: Command = {
  file: "node",
  prefix: ["C:\\Program Files\\atticus\\dist\\bin.js"],
  shell: false,
};
const cmdShim: Command = {
  file: "C:\\Program Files\\nodejs\\atticus.cmd",
  prefix: [],
  shell: true,
};
const unix: Command = { file: "/opt/atticus tools/bin/atticus", prefix: [], shell: false };

describe("the line typed into a terminal", () => {
  it("is plain atticus when the setting is", () => {
    expect(terminalLine(bare, ["map", "forge-ledger"])).toBe("atticus map forge-ledger");
  });

  it("runs a .js atticus with node, the path quoted only when it must be", () => {
    expect(terminalLine(js, ["next"])).toBe(
      "node C:\\Users\\dev\\tools\\atticus\\dist\\bin.js next",
    );
    expect(terminalLine(spaced, ["next"])).toBe(
      'node "C:\\Program Files\\atticus\\dist\\bin.js" next',
    );
  });

  it("calls a quoted program with & in PowerShell, as it must, and bare elsewhere", () => {
    expect(
      terminalLine(
        cmdShim,
        ["verify", "forge-ledger"],
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      ),
    ).toBe('& "C:\\Program Files\\nodejs\\atticus.cmd" verify forge-ledger');
    expect(terminalLine(cmdShim, ["verify"], "C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe(
      '& "C:\\Program Files\\nodejs\\atticus.cmd" verify',
    );
    expect(terminalLine(cmdShim, ["verify"], "C:\\Windows\\System32\\cmd.exe")).toBe(
      '"C:\\Program Files\\nodejs\\atticus.cmd" verify',
    );
    expect(terminalLine(unix, ["next"], "/bin/bash")).toBe('"/opt/atticus tools/bin/atticus" next');
  });

  it("quotes the arguments as the log does", () => {
    expect(terminalLine(bare, ["questions", "answer", "q1", "--text", "two words"])).toBe(
      'atticus questions answer q1 --text "two words"',
    );
  });
});
