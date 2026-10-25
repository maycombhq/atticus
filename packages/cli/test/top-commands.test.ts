import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aliasArgv, TOP_WORDS } from "../src/top-commands.js";
import { main } from "../src/main.js";

/**
 * ADR 0124 addendum D-cli: twelve commands at the top, every other one under `atticus legacy`,
 * and the old names still running exactly as before (scripts, the editors and the tests call them).
 */

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

const TWELVE = [
  "init",
  "map",
  "verify",
  "join",
  "change",
  "critic",
  "stories",
  "task",
  "questions",
  "knowledge",
  "next",
  "ui",
];

let empty: string;
beforeAll(async () => {
  empty = await mkdtemp(join(tmpdir(), "atticus-top-"));
});
afterAll(() => rm(empty, { recursive: true, force: true }));

describe("atticus help: the twelve", () => {
  it("lists the twelve, in order, one line each", async () => {
    expect([...TOP_WORDS]).toEqual(TWELVE);
    const r = await run(["help"]);
    expect(r.code).toBe(0);
    const firsts = r.out
      .split("\n")
      .map((l) => /^ {2}atticus ([a-z][a-z-]*)/.exec(l)?.[1])
      .filter((w): w is string => !!w && TWELVE.includes(w));
    expect(firsts).toEqual(TWELVE);
    // One line each: a command's line holds its words and what it does, nothing under it.
    for (const l of r.out.split("\n").filter((x) => /^ {2}atticus /.test(x)))
      expect(l, l).toMatch(/^ {2}atticus \S.* {2,}\S/);
    expect(r.out.split("\n").filter((l) => /^ {6,}\S/.test(l))).toEqual([]);
  });

  it("says how to reach the rest, and shows none of them", async () => {
    const r = await run(["--help"]);
    expect(r.out).toContain("atticus legacy");
    expect(r.out).toContain("atticus help <command>");
    expect(r.out).toContain("atticus help --all");
    for (const hidden of [
      "atticus scan",
      "atticus plan stories",
      "atticus release plan",
      "atticus bench",
    ])
      expect(r.out, hidden).not.toContain(hidden);
    expect((await run([])).out).toBe(r.out);
  });

  it("still explains any command, the hidden ones too", async () => {
    const r = await run(["help", "release", "plan"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("atticus release plan <change>");
    const s = await run(["help", "stories"]);
    expect(s.out).toContain("atticus stories <change>");
  });
});

describe("atticus legacy", () => {
  it("lists every command outside the twelve, grouped as the help groups them", async () => {
    const r = await run(["legacy"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Set up and keep healthy:");
    expect(r.out).toContain("Release:");
    expect(r.out).toContain("atticus scan [--no-drift]");
    expect(r.out).toContain("atticus plan stories <change>");
    expect(r.out).toContain("atticus estate join");
    // The twelve aren't in it, nor Atticus's own quality commands without --all.
    const firsts = new Set(
      r.out
        .split("\n")
        .map((l) => /^ {2}atticus ([a-z][a-z-]*)/.exec(l)?.[1])
        .filter(Boolean),
    );
    for (const w of [...TWELVE, "legacy"]) expect(firsts.has(w), w).toBe(false);
    expect(r.out).not.toContain("atticus bench run");
    expect(r.out).toContain("atticus legacy --all");
    const all = await run(["legacy", "--all"]);
    expect(all.out).toContain("For Atticus's own quality:");
    expect(all.out).toContain("atticus bench run");
  });

  it("runs an old command unchanged: the same output, errors and exit code", async () => {
    for (const words of [
      ["commands", "--json"],
      ["catalog", "validate"],
      ["estate", "join", "--root", empty],
      ["chnage", "list"],
    ]) {
      const direct = await run(words);
      const legacy = await run(["legacy", ...words]);
      expect(legacy, words.join(" ")).toEqual(direct);
    }
    // Options before the words are kept where they are.
    expect(await run(["--root", empty, "legacy", "estate", "join"])).toEqual(
      await run(["--root", empty, "estate", "join"]),
    );
  });

  it("runs the old names directly with nothing added to what they print", async () => {
    const r = await run(["catalog", "validate"]);
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
    expect(r.err).not.toMatch(/legacy/);
  });
});

describe("the new names are the commands that exist", () => {
  it("rewrites the words, leaving options and their values where they are", () => {
    const at = (argv: string[], positions: number[]) => aliasArgv(argv, positions);
    expect(at(["stories", "c1", "--handoff"], [0, 1])).toEqual([
      "plan",
      "stories",
      "c1",
      "--handoff",
    ]);
    expect(at(["--root", "x", "task", "c1", "t1"], [2, 3, 4])).toEqual([
      "--root",
      "x",
      "task",
      "run",
      "c1",
      "t1",
    ]);
    expect(at(["task", "run", "c1", "t1"], [0, 1, 2, 3])).toEqual(["task", "run", "c1", "t1"]);
    expect(at(["task", "context", "c1", "t1"], [0, 1, 2, 3])).toEqual([
      "task",
      "context",
      "c1",
      "t1",
    ]);
    expect(at(["join", "--json"], [0])).toEqual(["estate", "join", "--json"]);
    expect(at(["--by", "pat", "legacy", "plan", "stories", "c"], [2, 3, 4, 5])).toEqual([
      "--by",
      "pat",
      "plan",
      "stories",
      "c",
    ]);
    // `legacy` alone is the list; a rewritten line rewrites to itself.
    expect(at(["legacy", "--all"], [0])).toEqual(["legacy", "--all"]);
    expect(at(["plan", "stories", "c"], [0, 1, 2])).toEqual(["plan", "stories", "c"]);
    expect(at(["estate", "join"], [0, 1])).toEqual(["estate", "join"]);
    // A legacy name under legacy that is itself an alias is the command it names.
    expect(at(["legacy", "stories", "c"], [0, 1, 2])).toEqual(["plan", "stories", "c"]);
  });

  it("runs join, stories and task as estate join, plan stories and task run", async () => {
    for (const [mine, theirs] of [
      [["join"], ["estate", "join"]],
      [["stories"], ["plan", "stories"]],
      [
        ["task", "c1"],
        ["task", "run", "c1"],
      ],
    ] as const) {
      const a = await run([...mine, "--root", empty]);
      const b = await run([...theirs, "--root", empty]);
      expect(a, mine.join(" ")).toEqual(b);
      expect(a.code).toBe(2);
    }
  });

  it("are in the command catalogue, the twelve marked apart from the legacy ones", async () => {
    const r = await run(["commands", "--json"]);
    const j = JSON.parse(r.out) as {
      commands: { id: string; legacy: boolean; runs: string; area: string }[];
    };
    const byId = new Map(j.commands.map((c) => [c.id, c]));
    for (const id of ["join", "stories", "task", "legacy"]) expect(byId.has(id), id).toBe(true);
    expect(byId.get("stories")).toMatchObject({ runs: "ai", legacy: false });
    expect(byId.get("task")).toMatchObject({ legacy: false, area: "plan" });
    expect(byId.get("join")).toMatchObject({ legacy: false, area: "repos" });
    expect(byId.get("change new")!.legacy).toBe(false);
    expect(byId.get("scan")!.legacy).toBe(true);
    expect(byId.get("plan stories")!.legacy).toBe(true);
    expect(byId.get("legacy")!.legacy).toBe(false);
  });
});
