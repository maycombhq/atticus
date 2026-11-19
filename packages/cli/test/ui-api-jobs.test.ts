import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { Api } from "@maycombhq/core";
import { startServer, type RunningServer, type ServerContext } from "@maycombhq/server";
import { extendUiRoutes } from "../src/ui-commands.js";

/**
 * ADR 0202 point 5: a job a page's action started says what it is for, and GET /api/jobs finds
 * it again by that (a panel after a reload): the running one, a finished one, none. And point 2
 * on the Console's entries: `stoppable` and `stopLands`. The Forge metarepo; no network.
 */

const FORGE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/forge/metarepo");
const Jobs = z.object({ jobs: z.array(Api.Job) });
let srv: RunningServer;
let ctx!: ServerContext;
const get = async (path: string) => {
  const r = await fetch(srv.url + path, { headers: { "X-Atticus-Token": srv.token } });
  return { status: r.status, body: (await r.json()) as unknown };
};
const post = async (path: string, body: unknown = {}) => {
  const r = await fetch(srv.url + path, {
    method: "POST",
    headers: { "X-Atticus-Token": srv.token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "atticus-ui-jobs-"));
  await cp(FORGE, root, { recursive: true });
  srv = await startServer({
    root,
    port: 0,
    user: "pat",
    watch: false,
    extend: (r, c) => {
      ctx = c;
      return extendUiRoutes(r, c);
    },
  });
}, 120_000);
afterAll(async () => {
  await srv.close();
});

describe("GET /api/jobs (ADR 0202 point 5)", () => {
  it("none yet: an empty list, for an action and for all", async () => {
    expect((await get("/api/jobs?action=apply&repo=forge-ledger")).body).toEqual({ jobs: [] });
    expect(Jobs.parse((await get("/api/jobs")).body).jobs).toEqual([]);
  });

  it("refuses an action that is none of the app's", async () => {
    const r = await get("/api/jobs?action=deploy");
    expect(r.status).toBe(400);
    expect(Api.Problem.parse(r.body).detail).toContain("apply");
  });

  it("an Apply of a repo is found by action and repo, running and then finished", async () => {
    const started = await post("/api/facts/forge-ledger/apply");
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const id = String(started.body.jobId);
    const at = Jobs.parse((await get("/api/jobs?action=apply&repo=forge-ledger")).body).jobs;
    expect(at.map((j) => j.id)).toEqual([id]);
    expect(at[0]!.for).toEqual({ action: "apply", repo: "forge-ledger" });
    expect(typeof at[0]!.stoppable).toBe("boolean");
    expect(Date.parse(at[0]!.startedAt)).not.toBeNaN();
    // Another repo's panel, and another action's, find nothing.
    expect((await get("/api/jobs?action=apply&repo=forge-payments")).body).toEqual({ jobs: [] });
    expect((await get("/api/jobs?action=build")).body).toEqual({ jobs: [] });
    const end = await ctx.jobs.settle(id);
    const after = Jobs.parse((await get("/api/jobs?action=apply&repo=forge-ledger")).body).jobs;
    expect(after.map((j) => [j.id, j.state])).toEqual([[id, end.state]]);
    expect(after[0]!.stoppable).toBe(false);
    expect(after[0]!.finishedAt).toBeDefined();
    // With no parameter: every job kept.
    expect(Jobs.parse((await get("/api/jobs")).body).jobs.map((j) => j.id)).toContain(id);
  }, 120_000);

  it("a running job's Console entry says whether Stop can still take effect", async () => {
    let go!: () => void;
    const job = ctx.jobs.start(
      "local",
      async (c) => {
        await new Promise<void>((r) => (go = r));
        c.commit();
        await new Promise<void>((r) => (go = r));
        return {};
      },
      {
        title: "Applying to forge-ledger",
        for: { action: "apply", repo: "forge-ledger" },
        hearsStop: true,
      },
    );
    const entry = async () =>
      Api.ActivityList.parse((await get("/api/activity")).body).entries.find(
        (e) => e.id === job.id,
      )!;
    expect(await entry()).toMatchObject({ stoppable: true, stopLands: "now" });
    go();
    await new Promise((r) => setTimeout(r, 20));
    const late = await entry();
    expect(late.stoppable).toBe(false);
    expect(late.stopLands).toBeUndefined();
    go();
    await ctx.jobs.settle(job.id);
    expect((await entry()).stoppable).toBe(false);
  });
  it("a job whose work doesn't hear Stop offers none, refuses one, and never ends Stopped", async () => {
    let go!: () => void;
    const job = ctx.jobs.start("local", () => new Promise<void>((r) => (go = r)), {
      title: "Upgrading the metarepo",
      for: { action: "upgrade" },
    });
    const entry = Api.ActivityList.parse((await get("/api/activity")).body).entries.find(
      (e) => e.id === job.id,
    )!;
    expect(entry.stoppable).toBe(false);
    expect(entry.stop).toBeUndefined();
    const stop = await post(`/api/jobs/${job.id}/cancel`);
    expect(stop.status).toBe(409);
    expect(Api.Problem.parse(stop.body).detail).toBe(
      "Upgrading the metarepo can't be stopped: it runs to its end, so what it writes stays whole.",
    );
    expect(ctx.jobs.get(job.id)!.stopping).toBeUndefined();
    go();
    const end = await ctx.jobs.settle(job.id);
    expect(end.state).toBe("done");
    expect(ctx.jobs.linesOf(job.id)!.lines).not.toContain("Stopped.");
  });
});
