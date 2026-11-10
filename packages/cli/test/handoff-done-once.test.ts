import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { AUTO_CHECKED } from "../src/handoff-autodone.js";
import {
  forgetKeptResume,
  hasKeptResume,
  keepResume,
  resumeAfterDone,
  resumedRunOf,
} from "../src/handoff-resume.js";
import { extendUiRoutes } from "../src/ui-commands.js";

/**
 * Review of beta.23 (ADR 0189): a hand-off's resume runs once. Done and the app's own check at
 * once, or the command line's own --resume and then the app's, never apply one answer twice; and
 * the thread's "checked by" says who ran the run's last check. On the invented Forge estate.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const CHANGE = "add-gift-note";

beforeAll(async () => {
  process.env.XDG_STATE_HOME = await mkdtemp(join(tmpdir(), "atticus-done-once-state-"));
});

async function forgeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-done-once-"));
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  for (const r of parse(readFileSync(join(FORGE, "expected/scan.yaml"), "utf8")) as Record<
    string,
    unknown
  >[]) {
    const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
    if (!p.ok) throw new Error(String(r.id));
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  return root;
}

const agent = (id: string) => ({
  schemaVersion: 1,
  id,
  role: "architect",
  description: "Reads pages.",
  inputs: ["documents"],
  outputArtifact: "specs",
  tokenBudget: 4000,
  allowedRuntimes: ["hand-off"],
});

/** A hand-off run with its answer written. */
async function handedOff(
  root: string,
  id: string,
  o: { state: string; agent?: string; change?: string },
): Promise<string> {
  const change = o.change ?? CHANGE;
  const a = agent(o.agent ?? "knowledge-reader");
  const dir = join(root, ".runs", change, id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "run.json"),
    JSON.stringify({
      runId: id,
      request: {
        change,
        agent: a,
        pack: {
          prompt: "# Task\n",
          manifest: {
            schemaVersion: 1,
            change,
            agent: a.id,
            createdAt: "2026-11-09T09:00:00Z",
            budget: 4000,
            totalTokens: 900,
            sources: [],
            dropped: [],
            promptSha256: "0".repeat(64),
          },
        },
        outputPath: "notes.yaml",
        outputIn: "run",
      },
      runtime: "hand-off",
      state: o.state,
      attempt: 1,
      startedAt: "2026-11-09T09:00:00Z",
      errors: [],
    }),
  );
  await writeFile(join(dir, "prompt.md"), "# Task\n");
  await writeFile(join(dir, "context-manifest.json"), "{}");
  await writeFile(join(dir, "notes.yaml"), "ok: true\n");
  return dir;
}

const exists = (f: string) =>
  stat(f).then(
    () => true,
    () => false,
  );
const resumeOf = (id: string) => ["change", "feature", CHANGE, "--resume", id];

describe("a kept resume runs once", () => {
  it("when two resumes of the same run come at once: the second finds it done", async () => {
    const root = await forgeRoot();
    const id = "run-20261109090000-0001";
    await keepResume(root, CHANGE, id, resumeOf(id));
    let ran = 0;
    const step = async () => {
      ran++;
      await new Promise((r) => setTimeout(r, 50));
      return { code: 0, out: ["Wrote feature.yaml."], err: [] };
    };
    const [a, b] = await Promise.all([
      resumeAfterDone(root, step, CHANGE, id),
      resumeAfterDone(root, step, CHANGE, id),
    ]);
    expect(ran).toBe(1);
    expect([a, b].filter(Boolean)).toEqual([{ lines: ["Wrote feature.yaml."] }]);
  });

  it("is forgotten once the command line resumed the run itself", async () => {
    const root = await forgeRoot();
    const id = "run-20261109090000-0002";
    expect(resumedRunOf(["change", "feature", CHANGE, "--resume", id])).toBe(id);
    expect(resumedRunOf(["change", "feature", CHANGE, `--resume=${id}`])).toBe(id);
    expect(resumedRunOf(["critic", CHANGE, "--resume"])).toBeUndefined();
    expect(resumedRunOf(["change", "feature", CHANGE])).toBeUndefined();
    await keepResume(root, CHANGE, id, resumeOf(id));
    expect(await hasKeptResume(root, id)).toBe(true);
    await forgetKeptResume(root, id);
    expect(await hasKeptResume(root, id)).toBe(false);
    // Nothing is resumed again.
    expect(
      await resumeAfterDone(root, async () => ({ code: 0, out: [], err: [] }), CHANGE, id),
    ).toBeUndefined();
  });
});

describe("Done and the app's own check of one run", () => {
  let root: string;
  let srv: RunningServer;
  const asked: string[][] = [];
  const call = async (path: string, method: string) => {
    const r = await fetch(srv.url + path, { method, headers: { "X-Atticus-Token": srv.token } });
    const text = await r.text();
    return { status: r.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  };

  beforeAll(async () => {
    root = await forgeRoot();
    srv = await startServer({
      root,
      port: 0,
      user: "pat",
      watch: false,
      extend: (r, ctx) =>
        extendUiRoutes(r, ctx, {
          autoDone: { off: true },
          runStep: async (args) => {
            asked.push(args);
            await new Promise((x) => setTimeout(x, 80));
            return { code: 0, out: ["Wrote feature.yaml."], err: [] };
          },
        }),
    });
  });
  afterAll(() => srv?.close());
  beforeEach(() => {
    asked.length = 0;
  });

  it("resumes a run the command line validated once, however many Dones come at once", async () => {
    const id = "run-20261109090000-0003";
    await handedOff(root, id, { state: "validated" });
    await keepResume(root, CHANGE, id, resumeOf(id));
    const all = await Promise.all([1, 2, 3].map(() => call(`/api/runs/${id}/done`, "POST")));
    expect(asked).toHaveLength(1);
    expect(all.filter((x) => x.status === 200)).toHaveLength(1);
    expect(all.filter((x) => x.status === 409)).toHaveLength(2);
  });

  it("a person's Done takes the app's mark of an earlier check off", async () => {
    const id = "run-20261109090000-0004";
    const dir = await handedOff(root, id, { state: "waiting", change: "knowledge-scan" });
    await writeFile(join(dir, AUTO_CHECKED), '{"at":"2026-11-09T09:01:00Z"}\n');
    const done = await call(`/api/runs/${id}/done`, "POST");
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.state).toBe("validated");
    expect(await exists(join(dir, AUTO_CHECKED))).toBe(false);
  });
});

describe("Done as a job (review of beta.23: an editor panel waits for one answer)", () => {
  let root: string;
  let srv: RunningServer;
  const call = async (path: string, method: string, body?: unknown) => {
    const r = await fetch(srv.url + path, {
      method,
      headers: {
        "X-Atticus-Token": srv.token,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    return { status: r.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  };
  const settled = async (jobId: string) => {
    for (let i = 0; i < 200; i++) {
      const j = await call(`/api/jobs/${jobId}`, "GET");
      if (j.body.state !== "running" && j.body.state !== "queued") return j.body;
      await new Promise((x) => setTimeout(x, 20));
    }
    throw new Error(`job ${jobId} didn't end`);
  };

  beforeAll(async () => {
    root = await forgeRoot();
    srv = await startServer({
      root,
      port: 0,
      user: "pat",
      watch: false,
      extend: (r, ctx) =>
        extendUiRoutes(r, ctx, {
          autoDone: { off: true },
          runStep: async () => {
            await new Promise((x) => setTimeout(x, 150));
            return { code: 0, out: ["Wrote feature.yaml."], err: [] };
          },
        }),
    });
  });
  afterAll(() => srv?.close());

  it("answers 202 at once, and the job's result is the answer Done gives", async () => {
    const id = "run-20261109090000-0006";
    await handedOff(root, id, { state: "waiting", change: "knowledge-scan" });
    const started = await call(`/api/runs/${id}/done`, "POST", { job: true });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const jobId = String(started.body.jobId);
    const j = await settled(jobId);
    expect(j.state, JSON.stringify(j)).toBe("done");
    const answer = (j.result as { answer: Record<string, unknown> }).answer;
    expect(answer.state).toBe("validated");
    expect(answer.runId).toBe(id);
    // The Console names the hand-off run the job is the Done of.
    const act = await call("/api/activity", "GET");
    const entries = (act.body.entries ?? []) as { id: string; handoffRun?: string }[];
    expect(JSON.stringify(entries)).toContain(id);
  });

  it("refuses a second Done while the first one's job runs, and one of a finished run, at once", async () => {
    const id = "run-20261109090000-0007";
    await handedOff(root, id, { state: "validated" });
    await keepResume(root, CHANGE, id, resumeOf(id));
    const first = await call(`/api/runs/${id}/done`, "POST", { job: true });
    expect(first.status).toBe(202);
    const second = await call(`/api/runs/${id}/done`, "POST", { job: true });
    expect(second.status).toBe(409);
    expect((await settled(String(first.body.jobId))).state).toBe("done");
    const cancelled = "run-20261109090000-0008";
    await handedOff(root, cancelled, { state: "cancelled" });
    expect((await call(`/api/runs/${cancelled}/done`, "POST", { job: true })).status).toBe(409);
  });

  it("refuses a body it doesn't know", async () => {
    const id = "run-20261109090000-0009";
    await handedOff(root, id, { state: "waiting", change: "knowledge-scan" });
    expect((await call(`/api/runs/${id}/done`, "POST", { jobb: true })).status).toBe(400);
  });
});

describe("the app's own check of a run the command line validated", () => {
  let root: string;
  let srv: RunningServer;
  const asked: string[][] = [];

  beforeAll(async () => {
    root = await forgeRoot();
    srv = await startServer({
      root,
      port: 0,
      user: "pat",
      watch: false,
      extend: (r, ctx) =>
        extendUiRoutes(r, ctx, {
          autoDone: { stableMs: 20 },
          runStep: async (args) => {
            asked.push(args);
            return { code: 0, out: ["Wrote feature.yaml."], err: [] };
          },
        }),
    });
  });
  afterAll(() => srv?.close());

  it("only resumes it, and doesn't say the app checked it", async () => {
    const id = "run-20261109090000-0005";
    const dir = await handedOff(root, id, { state: "validated", agent: "feature-placer" });
    await keepResume(root, CHANGE, id, resumeOf(id));
    srv.events.publish({ type: "file.changed", path: `.runs/${CHANGE}` });
    for (let i = 0; i < 100 && !asked.length; i++) await new Promise((x) => setTimeout(x, 20));
    await new Promise((x) => setTimeout(x, 100));
    expect(asked).toEqual([[...resumeOf(id), "--handoff", "--json"]]);
    expect(await exists(join(dir, AUTO_CHECKED))).toBe(false);
  });
});
