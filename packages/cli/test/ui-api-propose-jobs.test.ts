import { expect, it } from "vitest";
import { startServer, type ServerContext } from "@maycombhq/server";
import { uiRoutes } from "../src/ui-api.js";
import { speckitRoot } from "./run-helpers.js";

/**
 * Windows review: Apply, Propose and Bring in answer at once with a job (an editor panel waits
 * 30 s for one answer); the job's result is the code and the lines.
 */
it("Bring in answers 202 with a job whose result says why it stopped", async () => {
  const { root } = await speckitRoot({ repos: ["forge-ledger"], open: false });
  const s = await startServer({ root, port: 0, user: "pat", extend: (r, ctx) => uiRoutes(r, ctx) });
  try {
    const h = { "X-Atticus-Token": s.token, "Content-Type": "application/json" };
    const r = await fetch(`${s.url}/api/propose/bring-in`, {
      method: "POST",
      headers: h,
      body: "{}",
    });
    expect(r.status).toBe(202);
    const { jobId } = (await r.json()) as { jobId: string };
    let job: { state: string; result?: { code: number; lines: string[] } };
    for (;;) {
      job = (await (
        await fetch(`${s.url}/api/jobs/${jobId}`, { headers: h })
      ).json()) as typeof job;
      if (job.state !== "running") break;
      await new Promise((x) => setTimeout(x, 50));
    }
    expect(job.state).toBe("failed");
    expect(job.result?.code).toBe(2);
    expect(job.result?.lines.join(" ")).toContain("follows no remote branch");
  } finally {
    await s.close();
  }
}, 60_000);

/**
 * Round 41: one local step at a time. Bring in moves the working tree; it never runs while Apply
 * writes facts. The refusal names the step that runs.
 */
it("refuses a second local step while one runs, naming the one that runs", async () => {
  const { root } = await speckitRoot({ repos: ["forge-ledger"], open: false });
  let ctxOf!: ServerContext;
  const s = await startServer({
    root,
    port: 0,
    user: "pat",
    extend: (r, ctx) => {
      ctxOf = ctx;
      return uiRoutes(r, ctx);
    },
  });
  let release!: () => void;
  const busy = ctxOf.jobs.start("local", async (c) => {
    c.progress(0, 1, "Applying to forge-ledger");
    await new Promise<void>((x) => (release = x));
  });
  try {
    const h = { "X-Atticus-Token": s.token, "Content-Type": "application/json" };
    for (const path of ["/api/propose/bring-in", "/api/facts/forge-ledger/apply"]) {
      const r = await fetch(`${s.url}${path}`, { method: "POST", headers: h, body: "{}" });
      expect(r.status).toBe(409);
      const p = (await r.json()) as { detail?: string };
      expect(p.detail).toContain(busy.id);
      expect(p.detail).toContain("Applying to forge-ledger");
    }
  } finally {
    release();
    await ctxOf.jobs.settle(busy.id);
    await s.close();
  }
}, 60_000);
