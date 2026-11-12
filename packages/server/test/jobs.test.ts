import { currentSignal, throwIfCancelled } from "@maycombhq/core";
import { describe, expect, it } from "vitest";
import { JobManager } from "../src/jobs.js";
import { EventHub } from "../src/server.js";

/** Cancel stops the work, through the job's signal (ADR 0119). */
describe("JobManager cancel", () => {
  it("aborts the signal the work runs in, and the job ends cancelled, not failed", async () => {
    const events: { type: string }[] = [];
    const jobs = new JobManager((e) => events.push(e));
    let wrote = false;
    const job = jobs.start("scan", async () => {
      for (let i = 0; i < 100; i++) {
        throwIfCancelled();
        await new Promise((r) => setTimeout(r, 10));
      }
      wrote = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(jobs.cancel(job.id)).toBe(true);
    const end = await jobs.settle(job.id);
    expect(end.state).toBe("cancelled");
    expect(end.errors).toEqual([]);
    expect(wrote).toBe(false);
    expect(events).toContainEqual({ type: "job.done", jobId: job.id, state: "cancelled" });
  });

  it("gives work the signal of its own job only", async () => {
    const jobs = new JobManager(() => undefined);
    const seen: (AbortSignal | undefined)[] = [];
    const a = jobs.start("scan", async () => {
      seen.push(currentSignal());
    });
    const b = jobs.start("sync", async () => {
      seen.push(currentSignal());
    });
    await jobs.settle(a.id);
    await jobs.settle(b.id);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBeDefined();
    expect(seen[0]).not.toBe(seen[1]);
    expect(currentSignal()).toBeUndefined();
  });

  it("says false for a job that already finished", async () => {
    const jobs = new JobManager(() => undefined);
    const job = jobs.start("index", async () => undefined);
    await jobs.settle(job.id);
    expect(jobs.cancel(job.id)).toBe(false);
  });
});

/** Round 41: a second job of a kind never hides the first, still running, from runningOf. */
describe("JobManager runningOf", () => {
  it("names a job still running after a later job of its kind ends", async () => {
    const jobs = new JobManager(() => undefined);
    let release!: () => void;
    const a = jobs.start("step", () => new Promise<void>((r) => (release = r)));
    const b = jobs.start("step", async () => undefined);
    await jobs.settle(b.id);
    expect(jobs.runningOf("step")?.id).toBe(a.id);
    release();
    await jobs.settle(a.id);
    expect(jobs.runningOf("step")).toBeUndefined();
  });

  it("names the later job while it runs, once the first of its kind has ended", async () => {
    const jobs = new JobManager(() => undefined);
    let release!: () => void;
    const a = jobs.start("local", async () => undefined);
    const b = jobs.start("local", () => new Promise<void>((r) => (release = r)));
    await jobs.settle(a.id);
    expect(jobs.runningOf("local")?.id).toBe(b.id);
    expect(jobs.runningOf("step")).toBeUndefined();
    release();
    await jobs.settle(b.id);
    expect(jobs.runningOf("local")).toBeUndefined();
  });
});

/**
 * Beta.27 review: Stop on a sync answered 200 and the sync ran on. Work is given its job's signal
 * (to pass to what it starts, git among them); a job asked to stop says `stopping` and "Stopping…"
 * until it ends, then `cancelled`.
 */
describe("JobManager stop, as the Console shows it", () => {
  it("hands work its job's signal, and says it is stopping until it ends", async () => {
    const events: ({ type: string } & Record<string, unknown>)[] = [];
    const jobs = new JobManager((e) => events.push(e));
    let signal: AbortSignal | undefined;
    let release!: () => void;
    const ended = new Promise<void>((r) => (release = r));
    const job = jobs.start("sync", async (c) => {
      signal = c.signal;
      await new Promise<void>((r) => c.signal.addEventListener("abort", () => r()));
      await ended;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(signal?.aborted).toBe(false);
    expect(jobs.cancel(job.id)).toBe(true);
    expect(signal?.aborted).toBe(true);
    const now = jobs.get(job.id)!;
    expect(now.state).toBe("running");
    expect(now.stopping).toBe(true);
    expect(now.progress.message).toBe("Stopping…");
    expect(jobs.linesOf(job.id)?.lines).toContain("Stopping…");
    expect(events).toContainEqual(
      expect.objectContaining({ type: "job.progress", jobId: job.id, message: "Stopping…" }),
    );
    // A second Stop while it stops is the same stop.
    expect(jobs.cancel(job.id)).toBe(true);
    expect(jobs.linesOf(job.id)?.lines.filter((l) => l === "Stopping…")).toHaveLength(1);
    release();
    const end = await jobs.settle(job.id);
    expect(end.state).toBe("cancelled");
    expect(end.stopping).toBeUndefined();
    expect(jobs.linesOf(job.id)?.lines.at(-1)).toBe("Stopped.");
  });
});

/**
 * Beta.27 review: jobs the app started were in memory only, so a restart of the app lost them
 * from the Console, Runs and Problems. Each is kept in the run log too (ADR 0187), as it runs.
 */
describe("JobManager keeping each job in the run log", () => {
  it("records each job's start, lines and end", async () => {
    const said: string[] = [];
    const jobs = new JobManager(() => undefined, undefined, {
      record: (job) => {
        said.push(`start ${job.id} ${job.kind} ${job.title ?? ""}`);
        return {
          line: (t) => said.push(`line ${t}`),
          end: (state) => said.push(`end ${state}`),
        };
      },
    });
    const a = jobs.start(
      "sync",
      async (c) => {
        c.line("forge-ledger: cloned");
      },
      { title: "Sync the base clones" },
    );
    await jobs.settle(a.id);
    const b = jobs.start("scan", async () => {
      throw new Error("no repos");
    });
    await jobs.settle(b.id);
    expect(said).toEqual([
      `start ${a.id} sync Sync the base clones`,
      "line forge-ledger: cloned",
      "end done",
      `start ${b.id} scan `,
      "line no repos",
      "end failed",
    ]);
  });

  it("a recorder that fails never fails the job", async () => {
    const jobs = new JobManager(() => undefined, undefined, {
      record: () => {
        throw new Error("disk full");
      },
    });
    const j = jobs.start("work", async (c) => c.line("hello"));
    expect((await jobs.settle(j.id)).state).toBe("done");
  });
});

describe("EventHub listeners (ADR 0119)", () => {
  it("tells a listener in this process every event, until it stops listening", () => {
    const hub = new EventHub();
    const heard: string[] = [];
    const stop = hub.listen((e) => heard.push(e.type));
    hub.publish({ type: "file.changed", path: "catalog/generated" });
    stop();
    hub.publish({ type: "index.rebuilt" });
    expect(heard).toEqual(["file.changed"]);
  });
});
