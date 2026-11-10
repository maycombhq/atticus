import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { watchMetarepo } from "../src/watch.js";

/**
 * ADR 0187: a command's run files under .atticus/logs/ nudge the Console's routes, apart from
 * the metarepo's files: they never go out as file.changed. A logs folder made later is followed.
 */

const until = async (ok: () => boolean, ms = 4000) => {
  const t = Date.now();
  while (!ok()) {
    if (Date.now() - t > ms) throw new Error("never happened");
    await new Promise((r) => setTimeout(r, 20));
  }
};

let root: string;
afterAll(() => rm(root, { recursive: true, force: true }));

describe("following a command's run files", () => {
  it("nudges on a run's record and log, and never sends file.changed for them", async () => {
    root = await mkdtemp(join(tmpdir(), "atticus-watch-logs-"));
    await mkdir(join(root, "org-pack"), { recursive: true });
    await mkdir(join(root, ".atticus"), { recursive: true });
    const events: { type: string; path?: unknown }[] = [];
    let nudged = 0;
    const w = watchMetarepo({
      root,
      publish: (e) => events.push(e),
      delayMs: 30,
      onRunLog: () => nudged++,
    });
    try {
      // Made after the watch started, as the first long command makes it.
      await mkdir(join(root, ".atticus", "logs", "running"), { recursive: true });
      await mkdir(join(root, ".atticus", "logs", "runs"), { recursive: true });
      await new Promise((r) => setTimeout(r, 300));
      await writeFile(
        join(root, ".atticus", "logs", "running", "20261109-101530-1-abcd.json"),
        "{}",
      );
      await until(() => nudged > 0);
      const before = nudged;
      await appendFile(join(root, ".atticus", "logs", "runs", "20261109-101530-1-abcd.log"), "x\n");
      await until(() => nudged > before);
      await new Promise((r) => setTimeout(r, 200));
      expect(events.filter((e) => String(e.path).includes("logs"))).toEqual([]);
      expect(w.following.some((f) => f.includes("logs"))).toBe(false);
    } finally {
      w.close();
    }
  });

  it("nudges at most once a while for a burst of writes, and once after the last", async () => {
    const r = await mkdtemp(join(tmpdir(), "atticus-watch-burst-"));
    await mkdir(join(r, "org-pack"), { recursive: true });
    await mkdir(join(r, ".atticus", "logs", "running"), { recursive: true });
    await mkdir(join(r, ".atticus", "logs", "runs"), { recursive: true });
    const at: number[] = [];
    const w = watchMetarepo({
      root: r,
      publish: () => undefined,
      onRunLog: () => at.push(Date.now()),
      runLogDelayMs: 100,
    });
    try {
      await new Promise((x) => setTimeout(x, 100));
      const log = join(r, ".atticus", "logs", "runs", "20261109-101530-1-abcd.log");
      const started = Date.now();
      for (let i = 0; i < 300; i++) {
        await appendFile(log, `line ${i}\n`);
        if (i % 30 === 0) await new Promise((x) => setTimeout(x, 5));
      }
      const last = Date.now();
      await until(() => at.some((t) => t >= last));
      await new Promise((x) => setTimeout(x, 250));
      // Hundreds of events: a nudge per 100 ms of them at most, and one after the last write.
      expect(at.length).toBeLessThanOrEqual(Math.ceil((last - started) / 100) + 2);
      for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(90);
    } finally {
      w.close();
      await rm(r, { recursive: true, force: true });
    }
  });
});
