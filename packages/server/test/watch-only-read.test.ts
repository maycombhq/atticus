import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { onlyRead } from "../src/watch.js";

/**
 * beta.23, Windows: a file only read reports a "change" (its last-access time), and Home reading
 * thousands of files threw away every answer it kept. A change event counts only when the file
 * was written (or its attributes changed) just now.
 */
let dir = "";
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

it("a file written just now is a change", async () => {
  dir = await mkdtemp(join(tmpdir(), "atticus-only-read-"));
  const f = join(dir, "q1.yaml");
  await writeFile(f, "answer: 1\n");
  expect(onlyRead(f)).toBe(false);
});

it("a file last written long ago, reported as changed, was only read", async () => {
  dir = await mkdtemp(join(tmpdir(), "atticus-only-read-"));
  const f = join(dir, "q1.yaml");
  await writeFile(f, "answer: 1\n");
  const old = new Date(Date.now() - 3600_000);
  await utimes(f, old, old);
  // ctime moves with utimes itself: seen an hour on, the file's times are all old.
  expect(onlyRead(f, Date.now() + 3600_000)).toBe(true);
});

it("a file that is gone is a change", () => {
  expect(onlyRead(join(tmpdir(), "atticus-no-such-file-here.yaml"))).toBe(false);
});
