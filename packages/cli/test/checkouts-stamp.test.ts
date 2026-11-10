import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { checkoutsStamp } from "../src/ui-api-trust.js";

/**
 * beta.23, Windows: Map › Trust and each change's cockpit are kept until a checkout moves. The
 * stamp read folders' times, which git moves as it reads (index.lock), so on Windows every Home
 * load worked them out again. It moves on a commit or a checkout, not on a read.
 */
const g = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], {
    cwd,
    encoding: "utf8",
  });
let dir = "";
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function adopted() {
  dir = await mkdtemp(join(tmpdir(), "atticus-stamp-"));
  // A repo adopted in place: its own checkout is the one read.
  await mkdir(join(dir, ".atticus", "org-pack"), { recursive: true });
  g(dir, "init", "-q", "-b", "main");
  await writeFile(join(dir, "a.txt"), "1\n");
  g(dir, "add", "-A");
  g(dir, "commit", "-q", "-m", "one");
  return dir;
}

it("stays the same while git only reads, its lock files coming and going", async () => {
  const root = await adopted();
  const before = await checkoutsStamp(root);
  await writeFile(join(root, ".git", "index.lock"), "");
  await rm(join(root, ".git", "index.lock"));
  g(root, "status", "--porcelain");
  g(root, "rev-parse", "HEAD");
  g(root, "log", "-1", "--format=%H");
  expect(await checkoutsStamp(root)).toBe(before);
});

it("moves on a commit", async () => {
  const root = await adopted();
  const before = await checkoutsStamp(root);
  await writeFile(join(root, "a.txt"), "2\n");
  g(root, "commit", "-q", "-am", "two");
  expect(await checkoutsStamp(root)).not.toBe(before);
});

it("moves on a checkout of another branch at the same commit", async () => {
  const root = await adopted();
  const before = await checkoutsStamp(root);
  g(root, "checkout", "-q", "-b", "other");
  expect(await checkoutsStamp(root)).not.toBe(before);
});
