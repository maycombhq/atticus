import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CancelledError, withCommit } from "@maycombhq/core";
import { durationWords, writeProgress } from "../src/write-progress.js";

/**
 * Beta.28.1 ("nothing slow runs silently", the owner's field report 1): Apply's write stage said
 * nothing for up to an hour while it loaded the catalog, built it and wrote contracts and specs.
 * Now each step is a line as it starts, with the time so far; a step that runs past the
 * heartbeat says it still runs, every heartbeat; Stop is heard between steps until the catalog
 * is being written, and after that it is said why the write finishes first.
 */

const noYield = () => Promise.resolve();

describe("durationWords", () => {
  it("says seconds, minutes and hours plainly", () => {
    expect(durationWords(0)).toBe("0 s");
    expect(durationWords(4_400)).toBe("4 s");
    expect(durationWords(59_999)).toBe("59 s");
    expect(durationWords(60_000)).toBe("1 min");
    expect(durationWords(95_000)).toBe("1 min 35 s");
    expect(durationWords(3_600_000 + 120_000)).toBe("1 h 2 min");
  });
});

describe("writeProgress", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-13T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("says each step as it starts, in order, with the time so far, and the total at the end", async () => {
    const lines: string[] = [];
    const p = writeProgress((l) => lines.push(l), {
      yieldNow: noYield,
      quietMs: 0,
      title: "The write",
    });
    await p.step("Loading the catalog");
    vi.advanceTimersByTime(2_000);
    p.say("The catalog on file: 98,412 records.");
    await p.step("Building the catalog: pass 1 of 8 (each repo's source)");
    vi.advanceTimersByTime(12_000);
    await p.step("Writing contracts");
    p.end({ done: true });
    expect(lines).toEqual([
      "Loading the catalog… (0 s in)",
      "The catalog on file: 98,412 records.",
      "Building the catalog: pass 1 of 8 (each repo's source)… (2 s in)",
      "Writing contracts… (14 s in)",
      "The write took 14 s.",
    ]);
  });

  it("names the three slowest steps at the end of work that took half a minute or more", async () => {
    // Beta.28.4 (the owner's field report: ten minutes, and no way to tell which step took them).
    const lines: string[] = [];
    const p = writeProgress((l) => lines.push(l), {
      yieldNow: noYield,
      quietMs: 0,
      heartbeatMs: 0,
      title: "The write",
    });
    await p.step("Loading the catalog");
    vi.advanceTimersByTime(18_000);
    await p.step(
      "Building the catalog: pass 3 of 8 (the merge, intake, features and the glossary)",
    );
    vi.advanceTimersByTime(1_000);
    await p.step("Building the catalog: pass 3 of 8, the glossary");
    vi.advanceTimersByTime(583_000);
    await p.step("Writing contracts");
    vi.advanceTimersByTime(400);
    await p.step("Rendering the map");
    vi.advanceTimersByTime(4_000);
    p.end({ done: true });
    expect(lines.slice(-2)).toEqual([
      "The slowest steps: building the catalog: pass 3 of 8, the glossary (9 min 43 s); loading the catalog (18 s); rendering the map (4 s).",
      "The write took 10 min 6 s.",
    ]);
    // Work that didn't finish says them too (a Stop, a refusal): where the time went so far.
    const stopped: string[] = [];
    const q = writeProgress((l) => stopped.push(l), {
      yieldNow: noYield,
      quietMs: 0,
      heartbeatMs: 0,
      title: "The write",
    });
    await q.step("Loading the catalog");
    vi.advanceTimersByTime(45_000);
    await q.step("Checking the build's guards");
    vi.advanceTimersByTime(2_000);
    q.end();
    expect(stopped.at(-1)).toBe(
      "The slowest steps: loading the catalog (45 s); checking the build's guards (2 s).",
    );
    // A step said twice (a second build in one piece of work) counts once, with both times;
    // steps under a second are left out, and quick work says no such line.
    const twice: string[] = [];
    const r = writeProgress((l) => twice.push(l), {
      yieldNow: noYield,
      quietMs: 0,
      heartbeatMs: 0,
      title: "The build",
    });
    await r.step("Reading the build's inputs");
    vi.advanceTimersByTime(20_000);
    await r.step("Checking the build's guards");
    vi.advanceTimersByTime(300);
    await r.step("Reading the build's inputs");
    vi.advanceTimersByTime(15_000);
    r.end({ done: true });
    expect(twice.slice(-2)).toEqual([
      "The slowest steps: reading the build's inputs (35 s).",
      "The build took 35 s.",
    ]);
    const quick: string[] = [];
    const k = writeProgress((l) => quick.push(l), { yieldNow: noYield, quietMs: 0, title: "It" });
    await k.step("Loading the catalog");
    vi.advanceTimersByTime(29_000);
    k.end({ done: true });
    expect(quick).toEqual(["Loading the catalog… (0 s in)", "It took 29 s."]);
  });

  it("says a step still runs every heartbeat while it runs, and stops once the next starts", async () => {
    const lines: string[] = [];
    const p = writeProgress((l) => lines.push(l), {
      yieldNow: noYield,
      quietMs: 0,
      heartbeatMs: 30_000,
      title: "The write",
    });
    await p.step("Building the catalog: pass 2 of 8 (the framework models and the estate join)");
    vi.advanceTimersByTime(29_000);
    expect(lines).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    vi.advanceTimersByTime(30_000);
    expect(lines.slice(1)).toEqual([
      "Still building the catalog: pass 2 of 8 (the framework models and the estate join): 30 s on this step (30 s in).",
      "Still building the catalog: pass 2 of 8 (the framework models and the estate join): 1 min on this step (1 min in).",
    ]);
    await p.step("Writing specs");
    vi.advanceTimersByTime(20_000);
    expect(lines.at(-1)).toBe("Writing specs… (1 min in)");
    vi.advanceTimersByTime(10_000);
    expect(lines.at(-1)).toBe("Still writing specs: 30 s on this step (1 min 30 s in).");
    p.end({ done: true });
    vi.advanceTimersByTime(120_000);
    // Nothing after the end: the heartbeat is off.
    expect(lines.at(-1)).toBe("The write took 1 min 30 s.");
  });

  it("lets each line out before the step's work (awaits the yield)", async () => {
    const order: string[] = [];
    const p = writeProgress((l) => order.push(`line ${l}`), {
      quietMs: 0,
      yieldNow: async () => {
        order.push("yield");
      },
    });
    await p.step("Loading the catalog");
    order.push("work");
    expect(order).toEqual(["line Loading the catalog… (0 s in)", "yield", "work"]);
    p.end({ done: true });
  });

  it("stops at the next step once Stop is asked, before the commit", async () => {
    const lines: string[] = [];
    const ctl = new AbortController();
    const p = writeProgress((l) => lines.push(l), {
      yieldNow: noYield,
      quietMs: 0,
      signal: ctl.signal,
    });
    await p.step("Loading the catalog");
    ctl.abort();
    await expect(p.step("Building the catalog")).rejects.toBeInstanceOf(CancelledError);
    // The step it stopped at isn't said as started.
    expect(lines).toEqual(["Loading the catalog… (0 s in)"]);
    p.end({ done: true });
  });

  it("after the commit, a Stop is said once and the write goes on", async () => {
    const lines: string[] = [];
    const ctl = new AbortController();
    const p = writeProgress((l) => lines.push(l), {
      yieldNow: noYield,
      quietMs: 0,
      signal: ctl.signal,
    });
    await p.step("Checking the build's guards");
    p.commit();
    await p.step("Writing the catalog (120 files)");
    ctl.abort();
    await p.step("Writing contracts");
    await p.step("Writing specs");
    p.end({ done: true });
    expect(lines.filter((l) => l.startsWith("Stop heard"))).toHaveLength(1);
    expect(lines).toContain("Writing specs… (0 s in)");
  });

  it("says nothing for work that ends within the quiet time, then the step it is on once past it", async () => {
    const quick: string[] = [];
    const q = writeProgress((l) => quick.push(l), { yieldNow: async () => {}, title: "The write" });
    await q.step("Loading the catalog");
    vi.advanceTimersByTime(500);
    await q.step("Writing specs");
    q.end({ done: true });
    vi.advanceTimersByTime(5_000);
    expect(quick).toEqual([]);

    const slow: string[] = [];
    const p = writeProgress((l) => slow.push(l), { yieldNow: async () => {}, title: "The write" });
    await p.step("Loading the catalog");
    vi.advanceTimersByTime(500);
    await p.step("Building the catalog: pass 2 of 8 (the framework models and the estate join)");
    expect(slow).toEqual([]);
    vi.advanceTimersByTime(1_500);
    expect(slow).toEqual([
      "Building the catalog: pass 2 of 8 (the framework models and the estate join)… (2 s in)",
    ]);
    await p.step("Writing specs");
    p.end({ done: true });
    expect(slow.slice(1)).toEqual(["Writing specs… (2 s in)", "The write took 2 s."]);
  });

  it("a step that starts past the quiet time is said even when the timer couldn't fire (a busy thread)", async () => {
    const lines: string[] = [];
    const p = writeProgress((l) => lines.push(l), { yieldNow: async () => {} });
    await p.step("Loading the catalog");
    // The clock moves without timers firing: the thread was busy.
    vi.setSystemTime(Date.now() + 5_000);
    await p.step("Writing specs");
    expect(lines).toEqual(["Writing specs… (5 s in)"]);
    p.end({ done: true });
  });

  it("never fails the work when printing throws", async () => {
    const p = writeProgress(
      () => {
        throw new Error("socket closed");
      },
      { yieldNow: noYield, quietMs: 0 },
    );
    await expect(p.step("Loading the catalog")).resolves.toBeUndefined();
    p.end({ done: true });
  });

  it("says no end line when the work didn't finish (a Stop, a refusal, nothing to write)", async () => {
    const lines: string[] = [];
    const p = writeProgress((l) => lines.push(l), {
      yieldNow: noYield,
      quietMs: 0,
      title: "The write",
    });
    await p.step("Loading the catalog");
    p.end();
    expect(lines).toEqual(["Loading the catalog… (0 s in)"]);
  });

  it("tick gives way inside a step, and stops there on Stop until the commit", async () => {
    const ctl = new AbortController();
    let gave = 0;
    const p = writeProgress(() => undefined, {
      yieldNow: async () => void gave++,
      quietMs: 0,
      signal: ctl.signal,
    });
    await p.step("Building the catalog: pass 2 of 8 (the framework models and the estate join)");
    await p.tick();
    expect(gave).toBe(2);
    ctl.abort();
    await expect(p.tick()).rejects.toBeInstanceOf(CancelledError);
    const q = writeProgress(() => undefined, { yieldNow: noYield, signal: ctl.signal });
    q.commit();
    await expect(q.tick()).resolves.toBeUndefined();
  });

  it("commit tells the job it runs in (a later Stop is too late)", async () => {
    let told = 0;
    await withCommit(
      () => void told++,
      async () => {
        writeProgress(() => undefined, { yieldNow: noYield }).commit();
      },
    );
    expect(told).toBe(1);
  });
});
