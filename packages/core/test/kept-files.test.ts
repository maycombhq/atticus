import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  forgetKeptFiles,
  keptFilesMayHaveChanged,
  keptParse,
  trustKeptFiles,
  writeFileAtomic,
} from "../src/index.js";

/**
 * beta.23: a small file's parse kept until the file changes, so the app's pages don't read and
 * parse every question, org-pack file and repo's facts again on each request.
 */
afterEach(() => {
  trustKeptFiles(undefined);
  forgetKeptFiles();
});

const counted = () => {
  let n = 0;
  const parse = (t: string) => {
    n++;
    return { text: t };
  };
  return { parse, reads: () => n };
};

describe("keptParse", () => {
  it("parses a file once while it is unchanged, again once it changes, and gives copies on asking", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kept-"));
    const f = join(dir, "a.yaml");
    await writeFile(f, "one\n");
    const c = counted();
    const a = await keptParse(f, "t", c.parse, { copy: true });
    const b = await keptParse(f, "t", c.parse, { copy: true });
    expect(a).toEqual({ text: "one\n" });
    expect(b).toEqual(a);
    expect(b).not.toBe(a);
    expect(c.reads()).toBe(1);
    await writeFile(f, "two, longer\n");
    expect(await keptParse(f, "t", c.parse)).toEqual({ text: "two, longer\n" });
    expect(c.reads()).toBe(2);
    // Another question asked of the same file is kept apart.
    await keptParse(f, "other", c.parse);
    expect(c.reads()).toBe(3);
    await rm(f);
    expect(await keptParse(f, "t", c.parse)).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });

  it("reads asks of one file at the same time once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kept-"));
    const f = join(dir, "a.yaml");
    await writeFile(f, "one\n");
    const c = counted();
    await Promise.all(Array.from({ length: 10 }, () => keptParse(f, "t", c.parse)));
    expect(c.reads()).toBe(1);
    await rm(dir, { recursive: true, force: true });
  });

  it("while quiet, trusts what it checked until a change is said, for that path only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kept-"));
    const a = join(dir, "a.yaml");
    const b = join(dir, "sub", "b.yaml");
    await writeFile(a, "one\n");
    await writeFileAtomic(b, "one\n");
    let quiet = true;
    trustKeptFiles(() => quiet);
    const c = counted();
    await keptParse(a, "t", c.parse);
    await keptParse(b, "t", c.parse);
    // Written behind the server's back, same size: not checked while it trusts them.
    await writeFile(a, "two\n");
    await writeFile(b, "two\n");
    expect(await keptParse(a, "t", c.parse)).toEqual({ text: "one\n" });
    // The watcher says b's folder changed: b is checked again, a still trusted.
    keptFilesMayHaveChanged(join(dir, "sub"));
    expect(await keptParse(b, "t", c.parse)).toEqual({ text: "two\n" });
    expect(await keptParse(a, "t", c.parse)).toEqual({ text: "one\n" });
    // Something is writing (a call that isn't a GET, a job): every file is checked.
    quiet = false;
    expect(await keptParse(a, "t", c.parse)).toEqual({ text: "two\n" });
    quiet = true;
    // A write through writeFileAtomic says so itself.
    await writeFileAtomic(a, "six\n");
    expect(await keptParse(a, "t", c.parse)).toEqual({ text: "six\n" });
    // And a change said with no path: everything.
    await writeFile(b, "ten\n");
    keptFilesMayHaveChanged();
    expect(await keptParse(b, "t", c.parse)).toEqual({ text: "ten\n" });
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps nothing for a parse that throws", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kept-"));
    const f = join(dir, "a.yaml");
    await writeFile(f, "x\n");
    let n = 0;
    const bad = () => {
      n++;
      throw new Error("not YAML");
    };
    await expect(keptParse(f, "t", bad)).rejects.toThrow("not YAML");
    await expect(keptParse(f, "t", bad)).rejects.toThrow("not YAML");
    expect(n).toBe(2);
    await rm(dir, { recursive: true, force: true });
  });
});
