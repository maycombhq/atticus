import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { changeExportCommand } from "../src/export-commands.js";
import { TOP_WORDS } from "../src/top-commands.js";

/**
 * `atticus change export` (ADR 0124 addendum B-short): the command's own words. The rows it writes
 * are tested on the fraud check in the planner (openspec-specs.test.ts, expected/ado.csv).
 */

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};

describe("atticus change export", () => {
  it("stays under change: the twelve top commands are as ADR 0124's D-cli set them", () => {
    expect(TOP_WORDS).toHaveLength(12);
    expect(TOP_WORDS).not.toContain("export");
  });

  it("needs a change id and a format it writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-export-"));
    let r = io();
    expect(await changeExportCommand(root, undefined, {}, r.io)).toBe(2);
    expect(r.err[0]).toContain("change export needs a change id");
    r = io();
    expect(await changeExportCommand(root, "add-fraud-check", { format: "trello" }, r.io)).toBe(2);
    expect(r.err[0]).toBe("change export writes ado or jira, not trello. Nothing was written.");
  });

  it("says when there is no such change", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-export-"));
    const r = io();
    expect(await changeExportCommand(root, "no-such-change", {}, r.io)).toBe(3);
    expect(r.err.join("\n")).toContain("no-such-change");
  });
});
