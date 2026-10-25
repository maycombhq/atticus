import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { captureLine, changeLearn } from "../src/change-commands.js";
import { main } from "../src/main.js";

/**
 * atticus change learn (H3): the report of how much people changed Atticus's drafts, read from
 * the kept pairs, in words and as JSON; and the line `change sync` prints when it keeps one (H1).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const FIX = join(HERE, "../../../fixtures/stages/corrections");

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

async function root(): Promise<string> {
  const r = await mkdtemp(join(tmpdir(), "atticus-cli-learn-"));
  await cp(join(FORGE, "metarepo/org-pack"), join(r, "org-pack"), { recursive: true });
  await cp(join(FIX, "changes"), join(r, "openspec/changes"), { recursive: true });
  return r;
}

describe("atticus change learn", () => {
  it("prints the report in words, as the golden", async () => {
    const c = capture();
    expect(await changeLearn(await root(), {}, c.io, { now: "2026-10-24T09:00:00Z" })).toBe(0);
    expect(c.out.join("\n") + "\n").toBe(await readFile(join(FIX, "expected/learn.txt"), "utf8"));
  });

  it("prints it as JSON with --json", async () => {
    const c = capture();
    expect(
      await changeLearn(await root(), { json: true }, c.io, { now: "2026-10-24T09:00:00Z" }),
    ).toBe(0);
    expect(JSON.parse(c.out.join("\n"))).toEqual(
      JSON.parse(await readFile(join(FIX, "expected/learn.json"), "utf8")),
    );
  });

  it("is a change command in the help, so the top level stays at twelve", async () => {
    const out: string[] = [];
    await main(["help", "--all"], { out: (l) => out.push(l), err: () => undefined });
    expect(out.join("\n")).toContain("  atticus change learn [--json]");
  });
});

describe("what change sync says it kept", () => {
  const base = {
    schemaVersion: 1 as const,
    change: "add-transfer-limit",
    stage: "feature",
    phase: "define",
    pr: { number: 1, url: "https://git.example.com/forge/forge-metarepo/pull/1" },
    branch: "handoff/add-transfer-limit/define",
    base: "main",
    mergedAt: "2026-10-19T12:00:00Z",
    capturedAt: "2026-10-19T12:00:00Z",
    drafted: { from: "git" as const, commit: "a".repeat(40) },
  };
  it("names the two folders and how many files people changed", () => {
    expect(
      captureLine({
        ...base,
        state: "captured",
        merged: { commit: "b".repeat(40), at: "2026-10-19T11:00:00Z", how: "message" },
        files: [
          { path: "feature.md", status: "same" },
          { path: "feature.yaml", status: "edited" },
        ],
      }),
    ).toBe(
      "Kept what Atticus drafted beside what merged: stage/feature.drafted/ and stage/feature.merged/ (1 of 2 files changed by people). atticus change learn measures it.",
    );
  });
  it("says to pull when the merge isn't in the clone yet", () => {
    expect(
      captureLine({
        ...base,
        state: "waiting-for-merge",
        files: [],
        note: "The merge of PR #1 isn't in this clone yet: pull main, then run atticus change learn.",
      }),
    ).toContain("pull main, then run atticus change learn");
  });
});
