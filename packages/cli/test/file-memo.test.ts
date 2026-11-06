import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { filesIn, memoByFiles } from "../src/file-memo.js";

/** beta.21: a page's answer kept until a file it reads changes, so asking again reads nothing new. */

const dir = mkdtempSync(join(tmpdir(), "atticus-memo-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("memoByFiles", () => {
  it("works it out once per version of its files, and again after one changes", async () => {
    const f = join(dir, "forge-ledger.jsonl");
    writeFileSync(f, "a\n");
    let runs = 0;
    const work = async () => ++runs;
    expect(await memoByFiles("k", [f], work)).toBe(1);
    expect(await memoByFiles("k", [f], work)).toBe(1);
    writeFileSync(f, "a\nb\n");
    expect(await memoByFiles("k", [f], work)).toBe(2);
    // A file that appears counts as a change too.
    const q = join(dir, "q");
    expect(await memoByFiles("k", [f, ...(await filesIn(q))], work)).toBe(3);
  });

  it("doesn't keep a failure", async () => {
    let n = 0;
    const work = async () => {
      n++;
      if (n === 1) throw new Error("once");
      return n;
    };
    await expect(memoByFiles("f", [], work)).rejects.toThrow("once");
    expect(await memoByFiles("f", [], work)).toBe(2);
  });
});
