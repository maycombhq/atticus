import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  migrateCorrections,
  parseFacts,
  QUICK_WRITE_LOCK,
  repoReadOf,
  sharedLockFileOf,
  withSharedFileLock,
} from "../src/index.js";

/**
 * Review round 46 (storage): a file two processes append to and rewrite (a repo's corrections:
 * the app server appends, a CLI command rewrites) is written one process at a time, through a
 * lock file beside it; and a facts file cut short is a refused file, not a crash.
 */

const temp = () => mkdtemp(join(tmpdir(), "atticus-r46-"));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A lock file as another process on this machine would leave it. */
const holdAs = (file: string, pid: number, startedAt = new Date().toISOString()) =>
  writeFile(
    sharedLockFileOf(file),
    JSON.stringify({ pid, host: hostname(), startedAt, what: "a test", token: "other" }),
    { flag: "wx" },
  );

describe("withSharedFileLock: one process at a time", () => {
  it("waits while another live process holds the file, then writes and lets go", async () => {
    const dir = await temp();
    const file = join(dir, "forge-payments.corrections.jsonl");
    // The parent process of this test runner is alive and is not this process.
    await holdAs(file, process.ppid);
    let ran = false;
    const done = withSharedFileLock(file, async () => {
      ran = true;
      await appendFile(file, "a\n");
      return 7;
    });
    await wait(200);
    expect(ran).toBe(false);
    await rm(sharedLockFileOf(file));
    expect(await done).toBe(7);
    expect(await readFile(file, "utf8")).toBe("a\n");
    expect(existsSync(sharedLockFileOf(file))).toBe(false);
  });

  it("takes over a lock whose process is gone, and one older than the stale time", async () => {
    const dir = await temp();
    const file = join(dir, "x.corrections.jsonl");
    // A PID no process has (the kernel's are far smaller).
    await holdAs(file, 2 ** 30);
    expect(await withSharedFileLock(file, async () => "gone")).toBe("gone");
    expect(existsSync(sharedLockFileOf(file))).toBe(false);

    // Another machine's lock (a shared drive): its PID can't be asked, so it goes by its age.
    await writeFile(
      sharedLockFileOf(file),
      JSON.stringify({
        pid: process.ppid,
        host: `not-${hostname()}`,
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        what: "a test",
        token: "other",
      }),
    );
    expect(await withSharedFileLock(file, async () => "old", { staleMs: 10_000 })).toBe("old");
    expect(existsSync(sharedLockFileOf(file))).toBe(false);
  });

  // Review round 50: a clone of a big repo outlasts any stale time; while its process on this
  // machine is alive, its lock is never taken over by age (two gits in one folder).
  it("never takes over by age a lock whose process on this machine is alive", async () => {
    const dir = await temp();
    const file = join(dir, "w.corrections.jsonl");
    await holdAs(file, process.ppid, new Date(Date.now() - 60 * 60_000).toISOString());
    await expect(
      withSharedFileLock(file, async () => "taken", { staleMs: 1_000, waitMs: 300 }),
    ).rejects.toThrow(new RegExp(`process ${process.ppid}`));
    expect(existsSync(sharedLockFileOf(file))).toBe(true);
    await rm(sharedLockFileOf(file));
  });

  it("takes over a quick write's lock past its most age, though its process id is alive (review of beta.23)", async () => {
    const dir = await temp();
    const file = join(dir, "stage/feature.yaml");
    await mkdir(join(dir, "stage"), { recursive: true });
    // Left by a crash whose process id Windows gave another program: alive, and an hour old.
    await holdAs(file, process.ppid, new Date(Date.now() - 60 * 60_000).toISOString());
    expect(
      await withSharedFileLock(file, async () => "taken", { ...QUICK_WRITE_LOCK, waitMs: 2_000 }),
    ).toBe("taken");
    // Held a moment ago by that live process: still waited for.
    await holdAs(file, process.ppid);
    await expect(
      withSharedFileLock(file, async () => "taken", { ...QUICK_WRITE_LOCK, waitMs: 300 }),
    ).rejects.toThrow(new RegExp(`process ${process.ppid}`));
    await rm(sharedLockFileOf(file));
  });

  it("gives up after the wait, naming the holder, and lets go when the work throws", async () => {
    const dir = await temp();
    const file = join(dir, "y.corrections.jsonl");
    await holdAs(file, process.ppid);
    await expect(withSharedFileLock(file, async () => 1, { waitMs: 150 })).rejects.toThrow(
      new RegExp(`process ${process.ppid}`),
    );
    await rm(sharedLockFileOf(file));
    await expect(
      withSharedFileLock(file, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(sharedLockFileOf(file))).toBe(false);
  });

  it("keeps the writers of one process in order too", async () => {
    const dir = await temp();
    const file = join(dir, "z.corrections.jsonl");
    await writeFile(file, "");
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        withSharedFileLock(file, async () => {
          const now = await readFile(file, "utf8");
          await writeFile(file, `${now}${i}\n`);
        }),
      ),
    );
    expect((await readFile(file, "utf8")).split("\n").filter(Boolean)).toHaveLength(40);
  });
});

describe("migrateCorrections takes the corrections lock", () => {
  it("doesn't rewrite a corrections file while another process holds it", async () => {
    const root = await temp();
    await mkdir(join(root, "facts"), { recursive: true });
    const file = join(root, "facts", "forge-payments.corrections.jsonl");
    const v1 =
      '{"schemaVersion":1,"fact":"call:a","action":"link","by":"pat","at":"2026-11-01T00:00:00Z","batch":"b-1"}\n';
    await writeFile(file, v1);
    await holdAs(file, process.ppid);
    const done = migrateCorrections(root);
    await wait(200);
    expect(await readFile(file, "utf8")).toBe(v1);
    await rm(sharedLockFileOf(file));
    expect(await done).toEqual(["facts/forge-payments.corrections.jsonl"]);
    expect(await readFile(file, "utf8")).toContain('"schemaVersion":2');
  });
});

describe("a facts file cut short", () => {
  it("is refused as not JSON, never thrown", async () => {
    const r = parseFacts('[{"schemaVersion":1,"id":"entry:forge-payments:get-/x"');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues).toHaveLength(1);
      expect(r.issues[0]!.code).toBe("not-json");
      expect(r.issues[0]!.message).toMatch(/JSON/);
    }
  });

  it("leaves repoReadOf saying what it read, without throwing", async () => {
    const root = await temp();
    await mkdir(join(root, "facts"), { recursive: true });
    await writeFile(join(root, "facts", "forge-payments.jsonl"), '[{"schemaVersion":1,"id":"x"');
    const r = await repoReadOf(root, "forge-payments");
    expect(r.state).toBe("incomplete");
    expect(r.why).toContain("its facts file doesn't read as facts");
  });
});
