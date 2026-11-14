import { currentSignal, throwIfCancelled } from "@maycombhq/core";
import { describe, expect, it } from "vitest";
import { CLOSED, JobManager, TOO_LATE } from "../src/jobs.js";
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

/** Beta.28.1: the commit point (the review and the re-review). */
describe("JobManager commit", () => {
  it("a Stop past the commit is too late: said, the work goes on, and the job ends done", async () => {
    const jobs = new JobManager(() => undefined);
    let go!: () => void;
    const held = new Promise<void>((r) => (go = r));
    let aborted = false;
    const job = jobs.start("work", async (c) => {
      c.commit();
      await held;
      aborted = c.signal.aborted;
      return {};
    });
    expect(jobs.cancel(job.id)).toBe(true);
    go();
    const done = await jobs.settle(job.id);
    expect(done.state).toBe("done");
    expect(aborted).toBe(false);
    expect(jobs.linesOf(job.id)?.lines).toContain(TOO_LATE);
  });

  it("a Stop before the commit that the work didn't hear is said too late at the commit", async () => {
    const jobs = new JobManager(() => undefined);
    let go!: () => void;
    const held = new Promise<void>((r) => (go = r));
    const job = jobs.start("work", async (c) => {
      await held;
      c.commit();
      return {};
    });
    jobs.cancel(job.id);
    go();
    expect((await jobs.settle(job.id)).state).toBe("done");
    expect(jobs.linesOf(job.id)?.lines).toContain(TOO_LATE);
  });

  it("a Stop taken back at the commit restores the message, and says so to listeners (S3)", async () => {
    const events: { type: string; message?: string }[] = [];
    const jobs = new JobManager((e) => events.push(e as { type: string; message?: string }));
    const states: { stopping?: boolean; message: string }[] = [];
    jobs.subscribe((c) => {
      if (c.type === "state")
        states.push({
          ...(c.job.stopping ? { stopping: true } : {}),
          message: c.job.progress.message,
        });
    });
    let go!: () => void;
    const held = new Promise<void>((r) => (go = r));
    let after!: () => void;
    const reached = new Promise<void>((r) => (after = r));
    const job = jobs.start("work", async (c) => {
      c.progress(1, 3, "Writing the catalog");
      await held;
      c.commit();
      after();
      await new Promise((r) => setTimeout(r, 20));
      return {};
    });
    jobs.cancel(job.id);
    expect(jobs.get(job.id)!.progress.message).toBe("Stopping…");
    go();
    await reached;
    const now = jobs.get(job.id)!;
    expect(now.stopping).toBeUndefined();
    expect(now.progress.message).toBe("Writing the catalog");
    expect(events.at(-1)).toMatchObject({ type: "job.progress", message: "Writing the catalog" });
    expect(states.at(-1)).toEqual({ message: "Writing the catalog" });
    await jobs.settle(job.id);
  });

  it("a stopped job ends saying Stopped, not Stopping…; a done one is done of all its steps", async () => {
    const jobs = new JobManager(() => undefined);
    const stopped = jobs.start("work", async (c) => {
      c.progress(0, 2, "Reading the estate's facts");
      for (let i = 0; i < 100; i++) {
        throwIfCancelled();
        await new Promise((r) => setTimeout(r, 10));
      }
    });
    await new Promise((r) => setTimeout(r, 20));
    jobs.cancel(stopped.id);
    const end = await jobs.settle(stopped.id);
    expect(end.state).toBe("cancelled");
    expect(end.progress.message).toBe("Stopped.");
    const done = jobs.start("work", async (c) => {
      c.progress(0, 1, "Joining the estate's calls and APIs");
      return {};
    });
    const ok = await jobs.settle(done.id);
    expect(ok.progress).toMatchObject({ done: 1, total: 1 });
  });

  it("a progress line is the job's progress message; a plain line isn't", async () => {
    const jobs = new JobManager(() => undefined);
    let go!: () => void;
    const held = new Promise<void>((r) => (go = r));
    const job = jobs.start("work", async (c) => {
      c.progress(0, 1, "Applying to forge-ledger");
      c.line("forge-ledger: 17 facts kept, 0 rejected");
      c.line("Building the catalog: pass 2 of 8… (4 s in)", { now: true });
      await held;
      return {};
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(jobs.get(job.id)!.progress.message).toBe("Building the catalog: pass 2 of 8… (4 s in)");
    go();
    await jobs.settle(job.id);
  });

  it("closing the app past a job's commit says no Stop after its record ended", async () => {
    const recorded: string[] = [];
    const jobs = new JobManager(() => undefined, undefined, {
      record: () => ({ line: (l) => void recorded.push(l), end: () => undefined }),
    });
    let go!: () => void;
    const held = new Promise<void>((r) => (go = r));
    const job = jobs.start("work", async (c) => {
      c.commit();
      await held;
      return {};
    });
    jobs.closeAll();
    expect(recorded.at(-1)).toBe(CLOSED);
    expect(jobs.linesOf(job.id)?.lines).not.toContain(TOO_LATE);
    go();
    await jobs.settle(job.id);
  });
});
