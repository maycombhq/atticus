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

/**
 * Sixth UX walk: Home offers Apply before Propose only for a repo whose corrections are newer
 * than its last Apply (verify --write rewrites the repo's spec header), not for every
 * corrections file not proposed yet.
 */
it("lists applyFirst only for corrections newer than the repo's last Apply", async () => {
  const { mkdir, utimes, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { factsDirOf, specDirOf } = await import("@maycombhq/core");
  const { root } = await speckitRoot({ repos: ["forge-ledger"], open: false });
  const s = await startServer({ root, port: 0, user: "pat", extend: (r, ctx) => uiRoutes(r, ctx) });
  const plan = async () =>
    (await (
      await fetch(`${s.url}/api/propose?scope=work`, { headers: { "X-Atticus-Token": s.token } })
    ).json()) as { files: { path: string }[]; applyFirst?: string[] };
  try {
    await mkdir(factsDirOf(root), { recursive: true });
    const corrections = join(factsDirOf(root), "forge-ledger.corrections.jsonl");
    await writeFile(corrections, '{"fact":"f1","field":"path","value":"/x"}\n');
    await utimes(corrections, new Date("2026-11-08T10:00:00Z"), new Date("2026-11-08T10:00:00Z"));
    expect((await plan()).applyFirst).toEqual(["forge-ledger"]);
    // Apply ran after the correction: nothing to apply first.
    await mkdir(specDirOf(root, "forge-ledger"), { recursive: true });
    const header = join(specDirOf(root, "forge-ledger"), "spec.yaml");
    await writeFile(header, "repo: forge-ledger\n");
    await utimes(header, new Date("2026-11-08T10:05:00Z"), new Date("2026-11-08T10:05:00Z"));
    const after = await plan();
    expect(after.files.some((f) => f.path.endsWith("forge-ledger.corrections.jsonl"))).toBe(true);
    expect(after.applyFirst).toEqual([]);
    // A correction saved since: Apply again.
    await utimes(corrections, new Date("2026-11-08T10:09:00Z"), new Date("2026-11-08T10:09:00Z"));
    expect((await plan()).applyFirst).toEqual(["forge-ledger"]);
  } finally {
    await s.close();
  }
}, 60_000);
