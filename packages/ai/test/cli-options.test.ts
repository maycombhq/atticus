import { describe, expect, it } from "vitest";
import { commandWords, optionsFor, OPTIONS } from "../src/cli-options.js";

/**
 * Review round 47: the command line's options, read the one way by the CLI and by a Copilot
 * session's command check. A flag that takes a value takes the word after it, so that word is
 * never a command word; a switch takes nothing, so the word after it is one.
 */
describe("the command line's options (review round 47)", () => {
  it("holds the flags the questions, decisions and verify handlers read, with their types", () => {
    const type = (f: string) => (OPTIONS as Record<string, { type: string }>)[f]?.type;
    for (const f of [
      "state",
      "option",
      "text",
      "scope",
      "match",
      "add-system",
      "api",
      "apply",
      "size",
      "seed",
      "answers",
      "right",
      "wrong",
      "unsure",
    ])
      expect(type(f), f).toBe("string");
    for (const f of [
      "mine",
      "none",
      "no-similar",
      "similar",
      "preview",
      "accept-proposal",
      "report",
      "verbose",
      "skipped",
      "handoff",
      "write",
    ])
      expect(type(f), f).toBe("boolean");
  });

  it("reads the command words past an option's value", () => {
    expect(commandWords(["questions", "--option", "1", "answer", "q1"])).toEqual([
      "questions",
      "answer",
      "q1",
    ]);
    expect(
      commandWords(["verify", "--write", "audit", "forge-api", "--answers", "a.yaml"]),
    ).toEqual(["verify", "audit", "forge-api"]);
    expect(commandWords(["questions", "--state", "open", "sheet", "--apply", "f.csv"])).toEqual([
      "questions",
      "sheet",
    ]);
    expect(commandWords(["--root", "m", "questions", "--", "--x"])).toEqual(["questions", "--x"]);
  });

  it("reads a flag the way the command it is given to takes it", () => {
    // critic's --resume is a switch; elsewhere it names a run.
    expect(commandWords(["critic", "c1", "--resume", "--gate", "design"])).toEqual([
      "critic",
      "c1",
    ]);
    expect(optionsFor(["critic", "c1", "--resume"]).resume).toEqual({ type: "boolean" });
    expect(optionsFor(["legacy", "critic", "c1"]).resume).toEqual({ type: "boolean" });
    expect(optionsFor(["map", "r1", "--resume", "run-1"]).resume).toEqual({ type: "string" });
    expect(commandWords(["knowledge", "scan", "--resume", "run-1"])).toEqual(["knowledge", "scan"]);
    // ci snippet's --write names a folder; elsewhere (verify, join) it is a switch.
    expect(commandWords(["ci", "snippet", "github", "--write", "ci"])).toEqual([
      "ci",
      "snippet",
      "github",
    ]);
    expect(commandWords(["join", "--write", "--json"])).toEqual(["join"]);
    // bench stories' --draft names the drafted story; elsewhere (rules add) it is a switch.
    expect(commandWords(["bench", "stories", "--draft", "s.yaml"])).toEqual(["bench", "stories"]);
    expect(commandWords(["rules", "add", "--draft", "k1"])).toEqual(["rules", "add", "k1"]);
  });
});
