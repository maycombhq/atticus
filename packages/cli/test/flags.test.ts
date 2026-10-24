import { describe, expect, it } from "vitest";
import {
  flagNames,
  nearest,
  nearestCommand,
  unknownFlagMessages,
  unknownFlags,
} from "../src/flags.js";
import { main } from "../src/main.js";

const KNOWN = new Set(["approve", "dry-run", "json", "root", "max-tokens", "force"]);

describe("flags no command knows (ADR 0119)", () => {
  it("reads the --names up to --, without their values", () => {
    expect(
      flagNames(["change", "handoff", "x", "--approve", "--root=a", "--", "--not-a-flag"]),
    ).toEqual(["approve", "root"]);
  });

  it("finds the unknown ones once each, and says the nearest known one", () => {
    const bad = unknownFlags(["--aprove", "--json", "--dryrun", "--aprove", "--zzz"], KNOWN);
    expect(bad).toEqual(["aprove", "dryrun", "zzz"]);
    expect(unknownFlagMessages(bad, KNOWN)).toEqual([
      "Unknown option --aprove. Did you mean --approve?",
      "Unknown option --dryrun. Did you mean --dry-run?",
      "Unknown option --zzz.",
    ]);
  });

  it("only suggests what is near enough to be meant", () => {
    expect(nearest("jsno", ["json", "root"])).toBe("json");
    expect(nearest("maxtokens", ["max-tokens"])).toBe("max-tokens");
    expect(nearest("frce", ["force"])).toBe("force");
    expect(nearest("rot", ["root", "repos"])).toBe("root");
    expect(nearest("everything", ["root", "json"])).toBeUndefined();
  });

  it("suggests the nearest command for misspelled words", () => {
    const ids = ["scan", "scan survey", "change new", "change status", "knowledge scan"];
    expect(nearestCommand(["sacn"], ids)).toBe("scan");
    expect(nearestCommand(["change", "statsu"], ids)).toBe("change status");
    expect(nearestCommand(["chnage", "new"], ids)).toBe("change new");
    expect(nearestCommand(["xyzzy"], ids)).toBeUndefined();
  });
});

describe("atticus with a mistake", () => {
  const run = async (argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(
      argv,
      { out: (l) => out.push(l), err: (l) => err.push(l) },
      { quiet: true },
    );
    return { code, out: out.join("\n"), err: err.join("\n") };
  };

  it("refuses a misspelled flag with exit 2 and the flag it meant, running nothing", async () => {
    const r = await run(["change", "list", "--jsno", "--root", "does-not-exist"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("Unknown option --jsno. Did you mean --json?");
    expect(r.err).toContain("atticus help change list");
  });

  it("says the nearest command for a misspelled one, without the whole help", async () => {
    const r = await run(["chnage", "list"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/^Unknown command: chnage list\./);
    expect(r.err).toContain("Did you mean atticus change list?");
    expect(r.err.split("\n").length).toBeLessThan(5);
  });

  it("explains one command with atticus help <command>", async () => {
    const r = await run(["help", "change", "new"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("atticus change new");
    expect(r.out).toContain("--type");
    expect(r.out.split("\n").length).toBeLessThan(40);
  });

  it("shows the same help for atticus help with no words as for --help", async () => {
    const help = await run(["help"]);
    const dash = await run(["--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toBe(dash.out);
  });

  it("groups the help by area, with Atticus's own quality commands only under --all", async () => {
    const short = await run(["--help"]);
    const all = await run(["help", "--all"]);
    expect(short.out).toContain("Set up and keep healthy:");
    expect(short.out).toContain("Changes, findings and questions:");
    expect(short.out).not.toContain("atticus bench run");
    expect(short.out).toContain("atticus help --all");
    expect(all.out).toContain("For Atticus's own quality:");
    expect(all.out).toContain("atticus bench run");
    // Every command the full help names is in the grouped one, once.
    const lines = (t: string) => t.split("\n").filter((l) => /^ {2}atticus [a-z]/.test(l));
    const { HELP_TEXT } = await import("../src/main.js");
    expect(lines(all.out).sort()).toEqual(lines(HELP_TEXT).sort());
  });

  it("says when help has nothing for the words, with the nearest command", async () => {
    const r = await run(["help", "chnage"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("Did you mean atticus help change");
  });
});
