import { describe, expect, it } from "vitest";
import {
  answersFrom,
  argPrompt,
  argTitle,
  listFor,
  normaliseCatalog,
  requiredSwitches,
  type CatalogCommand,
} from "../src/commands";

/** Entries as `atticus commands --json` prints them, with what its help text leaks in. */
const handoff: CatalogCommand = {
  id: "change handoff",
  words: ["change", "handoff"],
  usage: "atticus change handoff <id> --approve",
  summary: "Open the phase's hand-off PR; merging it approves the gate [--repo]",
  args: [{ name: "id", kind: "change", optional: false, many: false }],
  // "Open" is the first word of the help line after --approve, not a value it takes.
  flags: [
    { name: "--approve", value: "Open", required: true },
    { name: "--repo", required: false },
  ],
  area: "changes",
  runs: "shared",
  approve: "--approve",
};
const ret: CatalogCommand = {
  id: "change return",
  words: ["change", "return"],
  usage: 'atticus change return <id> --reason "<why>" --approve',
  summary: "Close the hand-off PR and return the change to the product owner",
  args: [{ name: "id", kind: "change", optional: false, many: false }],
  flags: [
    { name: "--reason", value: '"<why>"', required: true },
    { name: "--approve", value: "Close", required: true },
  ],
  area: "changes",
  runs: "shared",
  approve: "--approve",
};
const resume: CatalogCommand = {
  id: "critic --resume",
  words: ["critic"],
  usage: "atticus critic <change> [--gate g] --resume",
  summary: "Read in the AI lens answers your assistant wrote (hand-off)",
  args: [{ name: "change", kind: "change", optional: false, many: false }],
  flags: [
    { name: "--gate", required: false },
    { name: "--resume", value: "Read", required: true },
  ],
  area: "changes",
  runs: "local",
};
const refresh: CatalogCommand = {
  id: "absorb --refresh",
  words: ["absorb"],
  usage: "atticus absorb --refresh <id>",
  summary: "Fetch an absorbed source again and update its proposal",
  args: [],
  flags: [{ name: "--refresh", value: "id", required: true }],
  area: "knowledge",
  runs: "local",
};
const verify: CatalogCommand = {
  id: "knowledge verify",
  words: ["knowledge", "verify"],
  usage: "atticus knowledge verify <item>",
  summary: "Mark a knowledge item right as read: a green tick wherever it shows [--note <text>]",
  args: [{ name: "item", kind: "text", optional: false, many: false }],
  flags: [{ name: "--note", value: "text", required: false }],
  area: "knowledge",
  runs: "local",
};
const cat = normaliseCatalog({ areas: [], commands: [handoff, ret, resume, refresh, verify] });
const get = (id: string) => cat.commands.find((c) => c.id === id)!;

describe("the catalogue as the extension reads it", () => {
  it("takes a flag the usage shows bare as a switch, whatever word its help line starts with", () => {
    expect(get("change handoff").flags[0]).toEqual({ name: "--approve", required: true });
    expect(get("change return").flags).toEqual([
      { name: "--reason", value: '"<why>"', required: true },
      { name: "--approve", required: true },
    ]);
    expect(get("critic --resume").flags[1]).toEqual({ name: "--resume", required: true });
    expect(get("absorb --refresh").flags[0]).toEqual({
      name: "--refresh",
      value: "id",
      required: true,
    });
  });

  it("never sets the approve flag before the person's yes: the dry run goes first", () => {
    expect(requiredSwitches(get("change handoff"))).toEqual({});
    expect(answersFrom(get("change handoff"), ["add-transfer-limit"]).missing).toEqual([]);
    expect(answersFrom(get("change return"), ["add-transfer-limit"]).missing).toEqual(["--reason"]);
    expect(requiredSwitches(get("critic --resume"))).toEqual({ "--resume": true });
  });
});

describe("asking for a command's arguments", () => {
  it("names what is asked in plain words, with the command beside it", () => {
    expect(argTitle(get("change handoff"), get("change handoff").args[0]!)).toBe(
      "atticus change handoff: which change?",
    );
    expect(argTitle(verify, verify.args[0]!)).toBe("atticus knowledge verify: which item?");
    expect(argTitle(verify, { name: "dir", kind: "path", optional: true, many: false })).toBe(
      "atticus knowledge verify: dir (optional)",
    );
  });

  it("says what the command does, without the options' list, and how to leave an optional one out", () => {
    expect(argPrompt(verify, verify.args[0]!)).toBe(
      "Mark a knowledge item right as read: a green tick wherever it shows. Type the item.",
    );
    expect(argPrompt(verify, { name: "note", kind: "text", optional: true, many: false })).toBe(
      "Mark a knowledge item right as read: a green tick wherever it shows. Type the note, or leave it empty to leave it out.",
    );
  });

  it("offers the metarepo's own for an id a person can't know: items, needs, tasks, sources", () => {
    const arg = (c: string, n: string) => listFor({ id: c }, { name: n });
    expect(arg("knowledge verify", "item")).toBe("knowledge-item");
    expect(arg("knowledge correct", "item")).toBe("knowledge-item");
    expect(arg("knowledge reject", "item")).toBe("knowledge-item");
    expect(arg("needs done", "item")).toBe("need");
    expect(arg("needs skip", "item")).toBe("need");
    expect(arg("needs reopen", "item")).toBe("need");
    expect(arg("task run", "task")).toBe("task");
    expect(arg("spec hand-down", "task")).toBe("task");
    expect(arg("spec hand-up", "task")).toBe("task");
    expect(arg("sources tag", "source")).toBe("source");
    expect(arg("absorb accept", "id")).toBe("absorbed");
    expect(arg("orgpack accept", "platform")).toBe("platform");
    expect(arg("ask", "question")).toBeUndefined();
    expect(listFor(refresh, { name: "--refresh" })).toBe("absorbed");
  });
});
