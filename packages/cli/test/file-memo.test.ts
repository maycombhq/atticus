import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { filesIn, memoByFiles, recheckNow } from "../src/file-memo.js";

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

  it("inside the recheck window answers without looking, until told a file changed", async () => {
    const f = join(dir, "forge-portal.yaml");
    writeFileSync(f, "a\n");
    let runs = 0;
    let looked = 0;
    const paths = async () => (looked++, [f]);
    const work = async () => ++runs;
    const o = { recheckAfterMs: 60_000 };
    expect(await memoByFiles("w", paths, work, o)).toBe(1);
    writeFileSync(f, "a\nb\n");
    expect(await memoByFiles("w", paths, work, o)).toBe(1);
    expect(looked).toBe(1);
    recheckNow("w");
    expect(await memoByFiles("w", paths, work, o)).toBe(2);
    expect(looked).toBe(2);
  });
});
