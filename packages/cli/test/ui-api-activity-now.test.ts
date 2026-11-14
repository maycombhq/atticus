import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { printToCurrent } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { capturedIo } from "../src/main.js";
import { capturedStep } from "../src/map-all.js";
import { captured } from "../src/ui-api-steps.js";
import { uiActivityRoutes } from "../src/ui-api-activity.js";
import { writeProgress } from "../src/write-progress.js";

/**
 * Beta.28.1, the review's blocker: a step's line printed just before a long synchronous pass
 * reached the Console only when the pass ended (the batch's leading edge went out only after a
 * quiet 100 ms, and one setImmediate doesn't let a 100 ms timer fire). A progress line (printed
 * with `now`) goes out at once, with its job's lines before it. The reviewer's probe, on a real
 * server: quietMs 0, step, 20 ms busy, step, 400 ms busy: the second step is out before the
 * 400 ms start.
 */

let srv: RunningServer;
const live: { id: string; lines: string[] }[] = [];

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "atticus-activity-now-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  srv = await startServer({
    root,
    port: 0,
    user: "pat",
    watch: false,
    extend: (r, ctx) => uiActivityRoutes(r, ctx, { alive: () => true, tickMs: 1000 }),
  });
  srv.events.listen((e) => {
    if (e.type === "activity.lines") live.push({ id: e.id as string, lines: e.lines as string[] });
  });
});
afterAll(() => srv?.close());

const busy = (ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // the thread kept, as a build's pass keeps it
  }
};
const said = (id: string) => live.filter((x) => x.id === id).flatMap((x) => x.lines);

describe("a progress line reaches the Console before the step's work", () => {
  it("the reviewer's probe: the second step is out before its 400 ms pass", async () => {
    let before: string[] = [];
    const job = srv.jobs.start("work", async (c) => {
      const p = writeProgress((l) => c.line(l, { now: true }), { quietMs: 0, heartbeatMs: 0 });
      c.line("a plain line, batched");
      await p.step("Building the catalog: pass 1 of 8");
      busy(20);
      await p.step("Building the catalog: pass 2 of 8");
      before = said(job.id);
      busy(400);
      p.end();
      return {};
    });
    await srv.jobs.settle(job.id);
    expect(before.some((l) => l.startsWith("Building the catalog: pass 2 of 8"))).toBe(true);
    // The plain line before them went with the first, in order.
    expect(before.indexOf("a plain line, batched")).toBe(0);
  });

  it("a command's progress through its Output (capturedIo) is a `now` line, never in err", async () => {
    const out: string[] = [];
    const err: string[] = [];
    let before: string[] = [];
    const job = srv.jobs.start("work", async () => {
      await new Promise((r) => setTimeout(r, 150));
      printToCurrent("first");
      capturedIo(out, err).progress!("Writing specs… (3 s in)");
      before = said(job.id);
      busy(200);
      return {};
    });
    await srv.jobs.settle(job.id);
    expect(before).toEqual(["first", "Writing specs… (3 s in)"]);
    expect([...out, ...err]).toEqual([]);
  });

  it("a local step's progress (ui-api-steps captured) is a `now` line, never in its result (S2)", async () => {
    let before: string[] = [];
    let ran: Awaited<ReturnType<typeof captured>> | undefined;
    const job = srv.jobs.start("step", async () => {
      await new Promise((r) => setTimeout(r, 150));
      ran = await captured(async (io) => {
        io.out("a line");
        io.progress!("Building the catalog: pass 1 of 8… (2 s in)");
        before = said(job.id);
        busy(200);
        return 0;
      });
      return {};
    });
    await srv.jobs.settle(job.id);
    expect(before).toContain("Building the catalog: pass 1 of 8… (2 s in)");
    expect(ran).toEqual({ code: 0, out: ["a line"], err: [] });
  });

  it("map --all's kept output sends progress on, never into its errors (S2)", () => {
    const outer: string[] = [];
    const c = capturedStep({
      out: () => undefined,
      err: (l) => outer.push(`err ${l}`),
      progress: (l) => outer.push(`progress ${l}`),
    });
    c.progress!("Loading the catalog… (1 s in)");
    c.err("No checkout of forge-ledger");
    expect(c.errs).toEqual(["No checkout of forge-ledger"]);
    expect(outer).toEqual(["progress Loading the catalog… (1 s in)"]);
    // With nothing to send it to, it is dropped, still never an error line.
    const alone = capturedStep();
    alone.progress!("Writing specs…");
    expect(alone.errs).toEqual([]);
  });
});
