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

/**
 * Seventh UX walk: an answer to a map question is read by Apply (verify --write) as a correction
 * is, so a repo whose answered questions are newer than its last Apply is listed too; a change's
 * own question (filed under the change id) is not, since Apply never reads it.
 */
it("lists applyFirst for answered map questions newer than the repo's last Apply", async () => {
  const { mkdir, utimes, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { questionsDirOf, specDirOf } = await import("@maycombhq/core");
  const { root } = await speckitRoot({ repos: ["forge-ledger"], open: false });
  const s = await startServer({ root, port: 0, user: "pat", extend: (r, ctx) => uiRoutes(r, ctx) });
  const plan = async () =>
    (await (
      await fetch(`${s.url}/api/propose?scope=work`, { headers: { "X-Atticus-Token": s.token } })
    ).json()) as { files: { path: string }[]; applyFirst?: string[] };
  const question = (id: string, repo: string, command: string, state: string) =>
    [
      "schemaVersion: 4",
      `id: ${id}`,
      "askedBy:",
      "  step: facts-targets",
      `  command: ${command}`,
      "  at: 2026-11-08T09:00:00Z",
      `repo: ${repo}`,
      "question: Which repo serves the routes under /accounts?",
      "options:",
      "  - label: forge-ledger",
      "    means: forge-ledger serves them",
      "    changes: The calls join forge-ledger",
      "evidence:",
      "  - src/main/java/forge/ledger/Accounts.java:1",
      "scope:",
      "  level: repo",
      `  id: ${repo}`,
      `state: ${state}`,
      `rerun: ${command}`,
      ...(state === "answered"
        ? [
            "answer:",
            "  option: 1",
            "  by: pat",
            "  at: 2026-11-08T10:00:00Z",
            "  scope:",
            "    level: repo",
            `    id: ${repo}`,
          ]
        : []),
      "",
    ].join("\n");
  const at = (p: string, iso: string) => utimes(p, new Date(iso), new Date(iso));
  try {
    await mkdir(questionsDirOf(root), { recursive: true });
    await mkdir(specDirOf(root, "forge-ledger"), { recursive: true });
    const header = join(specDirOf(root, "forge-ledger"), "spec.yaml");
    await writeFile(header, "repo: forge-ledger\n");
    await at(header, "2026-11-08T09:30:00Z");
    const answered = join(questionsDirOf(root), "q-aaaaaaaaaaaa.yaml");
    await writeFile(
      answered,
      question("q-aaaaaaaaaaaa", "forge-ledger", "atticus verify forge-ledger --write", "answered"),
    );
    await at(answered, "2026-11-08T10:00:00Z");
    // An open question and a change's own answered question never ask for Apply.
    const open = join(questionsDirOf(root), "q-bbbbbbbbbbbb.yaml");
    await writeFile(
      open,
      question("q-bbbbbbbbbbbb", "forge-ledger", "atticus verify forge-ledger --write", "open"),
    );
    await at(open, "2026-11-08T10:00:00Z");
    const ofChange = join(questionsDirOf(root), "q-cccccccccccc.yaml");
    await writeFile(
      ofChange,
      question("q-cccccccccccc", "add-a-limit", "atticus change feature add-a-limit", "answered"),
    );
    await at(ofChange, "2026-11-08T10:00:00Z");
    const first = await plan();
    expect(first.files.some((f) => f.path.endsWith("q-aaaaaaaaaaaa.yaml"))).toBe(true);
    expect(first.applyFirst).toEqual(["forge-ledger"]);
    // Apply ran after the answer: nothing to apply first.
    await at(header, "2026-11-08T10:05:00Z");
    expect((await plan()).applyFirst).toEqual([]);
  } finally {
    await s.close();
  }
}, 60_000);

/**
 * Ninth UX walk: Home offers the upgrade in the app. GET /api/upgrade lists the steps doctor
 * counts; POST runs atticus upgrade as a local job on the person's click.
 */
it("lists the pending upgrade steps and runs atticus upgrade as a local job", async () => {
  const { readFile, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { orgPackDirOf } = await import("@maycombhq/core");
  const { root } = await speckitRoot({ repos: ["forge-ledger"], open: false });
  const rt = join(orgPackDirOf(root), "runtime.yaml");
  await writeFile(
    rt,
    [
      "schemaVersion: 3",
      "assistants: { allowed: [copilot], default: copilot }",
      "decide: { links: auto }",
      "",
    ].join("\n"),
  );
  const s = await startServer({ root, port: 0, user: "pat", extend: (r, ctx) => uiRoutes(r, ctx) });
  try {
    const h = { "X-Atticus-Token": s.token, "Content-Type": "application/json" };
    const get = async () =>
      (await (await fetch(`${s.url}/api/upgrade`, { headers: h })).json()) as {
        pending: { id: string; files: string[] }[];
        newer: boolean;
      };
    const before = await get();
    expect(before.newer).toBe(false);
    expect(before.pending.map((p) => p.id)).toContain("runtime-v4");
    const r = await fetch(`${s.url}/api/upgrade`, { method: "POST", headers: h, body: "{}" });
    expect(r.status).toBe(202);
    const { jobId } = (await r.json()) as { jobId: string };
    let job: { state: string; result?: { code: number; lines: string[] } };
    for (;;) {
      job = (await (
        await fetch(`${s.url}/api/jobs/${jobId}`, { headers: h })
      ).json()) as typeof job;
      if (job.state !== "running" && job.state !== "queued") break;
      await new Promise((x) => setTimeout(x, 50));
    }
    expect(job.state, job.result?.lines.join("\n")).toBe("done");
    expect(await readFile(rt, "utf8")).toMatch(/^schemaVersion: 4/m);
    expect((await get()).pending).toEqual([]);
    const again = await fetch(`${s.url}/api/upgrade`, { method: "POST", headers: h, body: "{}" });
    expect(again.status).toBe(409);
  } finally {
    await s.close();
  }
}, 60_000);

/**
 * Final review: Apply took the repo from the path as it came, so an encoded ../ read a facts
 * file outside the metarepo. A repo that isn't a repo name is refused, one the workspace
 * doesn't list isn't found, and no job starts for either.
 */
it("refuses Apply for a repo that isn't a repo name or isn't in the workspace", async () => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { dirname, join } = await import("node:path");
  const { factsDirOf } = await import("@maycombhq/core");
  const { root } = await speckitRoot({ repos: ["forge-ledger"], open: false });
  // A facts file where ../../outside/evil from the facts folder would land.
  const evil = join(factsDirOf(root), "..", "..", "outside", "evil.jsonl");
  await mkdir(dirname(evil), { recursive: true });
  await writeFile(evil, "");
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
  try {
    const h = { "X-Atticus-Token": s.token, "Content-Type": "application/json" };
    const post = (repo: string) =>
      fetch(`${s.url}/api/facts/${repo}/apply`, { method: "POST", headers: h, body: "{}" });
    for (const repo of ["..%2F..%2Foutside%2Fevil", "..%5C..%5Coutside%5Cevil"]) {
      const r = await post(repo);
      expect(r.status).toBe(400);
      expect(ctxOf.jobs.runningOf("local")).toBeUndefined();
    }
    const unknown = await post("forge-nowhere");
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { detail?: string }).detail).toContain("forge-nowhere");
    expect(ctxOf.jobs.runningOf("local")).toBeUndefined();
  } finally {
    await s.close();
  }
}, 60_000);
