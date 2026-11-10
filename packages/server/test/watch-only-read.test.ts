import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { onlyRead } from "../src/watch.js";

/**
 * beta.23, Windows: a file only read reports a "change" (its last-access time), and Home reading
 * thousands of files threw away every answer it kept. A change event counts only when the file's
 * size or times moved since the watcher last saw it, or, the first time, since it started.
 */
let dir = "";
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const tick = () => new Promise((r) => setTimeout(r, 20));

it("a file written before the watcher started, then only read, is no change: even a moment before (review of beta.23)", async () => {
  dir = await mkdtemp(join(tmpdir(), "atticus-only-read-"));
  const f = join(dir, "q1.yaml");
  // A metarepo written just before `atticus ui` started (a pull, a test's estate).
  await writeFile(f, "answer: 1\n");
  await tick();
  const since = Date.now();
  const seen = new Map<string, string>();
  expect(onlyRead(f, seen, since)).toBe(true);
  // Read again and again: still no change.
  expect(onlyRead(f, seen, since)).toBe(true);
});

it("a file written after the watcher started, or since it was last seen, is a change", async () => {
  dir = await mkdtemp(join(tmpdir(), "atticus-only-read-"));
  const f = join(dir, "q1.yaml");
  const since = Date.now() - 1000;
  const seen = new Map<string, string>();
  await writeFile(f, "answer: 1\n");
  expect(onlyRead(f, seen, since)).toBe(false);
  // As it was when last seen: a read.
  expect(onlyRead(f, seen, since)).toBe(true);
  await tick();
  await appendFile(f, "# edited\n");
  expect(onlyRead(f, seen, since)).toBe(false);
});

it("a file that is gone is a change", () => {
  const seen = new Map<string, string>();
  expect(onlyRead(join(tmpdir(), "atticus-no-such-file-here.yaml"), seen, Date.now())).toBe(false);
});
