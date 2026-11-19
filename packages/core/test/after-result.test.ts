import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  acquireLock,
  afterResultPending,
  LockHeldError,
  runAfterResult,
  settleAfterResult,
} from "../src/index.js";

/**
 * ADR 0205 step 2: a writer's caches written after its result, still under its lock. The next
 * writer of the same process waits for them in acquireLock and takes the lock once they let it go;
 * another process meets the lock held, as it would during the write itself.
 */
describe("work after a writer's result (ADR 0205 step 2)", () => {
  it("holds the lock until the work is done; the next acquireLock here waits for it", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-after-result-"));
    try {
      const lock = await acquireLock(root, "scan", "atticus verify a --write");
      const order: string[] = [];
      let finish!: () => void;
      const gate = new Promise<void>((r) => (finish = r));
      runAfterResult(async () => {
        try {
          await gate;
          order.push("caches");
        } finally {
          await lock.release();
        }
      });
      expect(afterResultPending()).toBe(1);
      const next = acquireLock(root, "scan", "atticus verify b --write").then((l) => {
        order.push("next");
        return l;
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(order).toEqual([]);
      finish();
      const l2 = await next;
      expect(order).toEqual(["caches", "next"]);
      expect(afterResultPending()).toBe(0);
      await l2.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("a work that fails still ends, and a held lock is still refused to a second taker meanwhile", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-after-result-"));
    try {
      const lock = await acquireLock(root, "scan", "atticus verify a --write");
      runAfterResult(async () => {
        try {
          throw new Error("disk full");
        } finally {
          await lock.release();
        }
      });
      await settleAfterResult();
      expect(afterResultPending()).toBe(0);
      const l = await acquireLock(root, "scan", "x");
      await expect(acquireLock(root, "scan", "y")).rejects.toBeInstanceOf(LockHeldError);
      await l.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
