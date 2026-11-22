import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  acquireLock,
  afterResultHooks,
  afterResultPending,
  LockHeldError,
  readLock,
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
      runAfterResult(
        async () => {
          try {
            await gate;
            order.push("caches");
          } finally {
            await lock.release();
          }
        },
        { root, name: "scan" },
      );
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
      runAfterResult(
        async () => {
          try {
            throw new Error("disk full");
          } finally {
            await lock.release();
          }
        },
        { root, name: "scan" },
      );
      await settleAfterResult();
      expect(afterResultPending()).toBe(0);
      const l = await acquireLock(root, "scan", "x");
      await expect(acquireLock(root, "scan", "y")).rejects.toBeInstanceOf(LockHeldError);
      await l.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("a taker of another lock doesn't wait for a writer's caches (the review of ADR 0205)", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-after-result-"));
    try {
      const lock = await acquireLock(root, "scan", "atticus verify a --write");
      let finish!: () => void;
      const gate = new Promise<void>((r) => (finish = r));
      runAfterResult(
        async () => {
          try {
            await gate;
          } finally {
            await lock.release();
          }
        },
        { root, name: "scan" },
      );
      // Another lock name of the same metarepo, and the same name of another metarepo: no wait.
      const other = await acquireLock(root, "questions", "atticus questions answer");
      await other.release();
      const elsewhere = await mkdtemp(join(tmpdir(), "atticus-after-result-"));
      try {
        const there = await acquireLock(elsewhere, "scan", "atticus scan");
        await there.release();
      } finally {
        await rm(elsewhere, { recursive: true, force: true });
      }
      expect(afterResultPending()).toBe(1);
      finish();
      await settleAfterResult();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks the lock while the caches are written: a writer that dies then left the catalog whole", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-after-result-"));
    try {
      const lock = await acquireLock(root, "scan", "atticus verify a --write");
      expect((await readLock(root, "scan"))?.phase).toBeUndefined();
      await lock.caching();
      const held = await readLock(root, "scan");
      expect(held?.phase).toBe("caches");
      expect(held?.stale).toBe(false);
      // The process dies after its result, before its caches (the property tests' fault): the
      // work never runs and the lock is left as a dead process leaves it.
      afterResultHooks.die = true;
      let ran = false;
      runAfterResult(
        async () => {
          ran = true;
          await lock.release();
        },
        { root, name: "scan" },
      );
      expect(afterResultHooks.die).toBeUndefined();
      await settleAfterResult();
      expect(ran).toBe(false);
      expect((await readLock(root, "scan"))?.stale).toBe(true);
      const next = await acquireLock(root, "scan", "atticus scan");
      expect(next.interrupted?.phase).toBe("caches");
      expect(next.interrupted?.what).toBe("atticus verify a --write");
      await next.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
