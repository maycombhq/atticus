import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { uiModelRunRoutes } from "../src/ui-api-runs.js";

/**
 * ADR 0106: what Atticus asked a model and what it answered, for every run under .runs/: the
 * list, and one run's prompt, answer and the problems each round handed back. Read-only.
 */

const agent = {
  schemaVersion: 1,
  id: "knowledge-reader",
  role: "architect",
  description: "Reads pages.",
  inputs: ["documents"],
  outputArtifact: "specs",
  tokenBudget: 4000,
  allowedRuntimes: ["hand-off"],
};
const data = (id: string, origin: string, text: string) =>
  `<atticus-data id="${id}" kind="document" origin="${origin}">\n${text}\n</atticus-data>`;

let root: string;
let srv: RunningServer;
const call = async (path: string) => {
  const r = await fetch(srv.url + path, { headers: { "X-Atticus-Token": srv.token } });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

/** A run as the hand-off runtime writes it: run.json, its prompt, and the answer in its folder. */
async function run(n: number, at: string, prompt: string, state: string, answer?: string) {
  const id = `run-2026102303400${n}-0001`;
  const dir = join(root, ".runs", "knowledge-scan", id);
  await mkdir(dir, { recursive: true });
  const sources = [...prompt.matchAll(/origin="([^"]+)"/g)].map((m, i) => ({
    id: `s${i}`,
    kind: "document",
    origin: m[1],
    bytes: 1,
    tokens: 1,
    classification: "internal",
    sha256: "0".repeat(64),
    trusted: false,
  }));
  await writeFile(
    join(dir, "run.json"),
    JSON.stringify({
      runId: id,
      request: {
        change: "knowledge-scan",
        agent,
        pack: {
          prompt,
          manifest: {
            schemaVersion: 1,
            change: "knowledge-scan",
            agent: agent.id,
            createdAt: at,
            budget: 4000,
            totalTokens: 900 + n,
            sources,
            dropped: [],
            promptSha256: "0".repeat(64),
          },
        },
        outputPath: "knowledge-items.yaml",
        outputIn: "run",
      },
      runtime: "hand-off",
      state,
      attempt: 1,
      startedAt: at,
      ...(state !== "waiting" ? { finishedAt: at } : {}),
      errors: [],
    }),
  );
  await writeFile(join(dir, "prompt.md"), prompt);
  await writeFile(join(dir, "context-manifest.json"), "{}");
  if (answer !== undefined) await writeFile(join(dir, "knowledge-items.yaml"), answer);
  return id;
}

// The step a test starts: recorded, never run (no model, no network).
const started: string[][] = [];
const fakeStep = async (args: string[]) => {
  started.push(args);
  await run(4, "2026-10-23T03:40:04Z", "# Task: survey the repo\n", "validated", "ok\n");
  return { code: 0, out: ["The step is done."], err: [] };
};
const post = async (path: string, body: unknown) => {
  const r = await fetch(srv.url + path, {
    method: "POST",
    headers: { "X-Atticus-Token": srv.token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};
const setModel = (yaml: string) => writeFile(join(root, "org-pack", "runtime.yaml"), yaml);

let first: string;
let second: string;
let third: string;

beforeAll(async () => {
  root = join(await mkdtemp(join(tmpdir(), "atticus-ui-runs-")), "meta");
  await mkdir(join(root, "org-pack"), { recursive: true });
  await writeFile(join(root, "org-pack", "sources.yaml"), "schemaVersion: 1\n");
  first = await run(
    1,
    "2026-10-23T03:40:01Z",
    "# Task: read the pages\n",
    "validated",
    "items:\n  - id: firewall-rule-request\n",
  );
  second = await run(
    2,
    "2026-10-23T03:40:02Z",
    `# Task: read the pages\n\n${data("9-problems", "checks on attempt 1", "The answer above failed these checks.\n- team ledger-team: quote: the quote is not on the page, word for word\n- request firewall-rule-request: title: Invalid input")}\n\n${data("8-previous", "attempt 1", "items:\n  - id: firewall-rule-request\n")}\n`,
    "validated",
    "items:\n  - id: firewall-rule-request\n    title: Network firewall rule\n",
  );
  third = await run(3, "2026-10-23T03:40:03Z", "# Task: read the pages\n", "waiting");
  srv = await startServer({
    root,
    user: "pat",
    version: "1.0.0",
    extend: (r, ctx) => uiModelRunRoutes(r, ctx, { runStep: fakeStep }),
  });
});
afterAll(async () => srv?.close());

describe("model runs (ADR 0106)", () => {
  it("lists every run, newest first, with its step, round and whether it was answered", async () => {
    const r = await call("/api/runs");
    expect(r.status).toBe(200);
    const list = Api.RunList.parse(r.body);
    expect(list.runs.map((x) => x.runId)).toEqual([third, second, first]);
    expect(list.runs[1]).toMatchObject({
      change: "knowledge-scan",
      agent: "knowledge-reader",
      runtime: "hand-off",
      state: "validated",
      attempt: 2,
      answered: true,
      handedBack: 2,
      promptTokens: 902,
    });
    expect(list.runs[0]).toMatchObject({ state: "waiting", answered: false, attempt: 1 });
    expect((await call("/api/runs?change=nothing-here")).body).toMatchObject({ runs: [] });
  });

  it("gives one run's prompt, its answer and the problems handed back to it", async () => {
    const r = await call(`/api/runs/${second}/transcript`);
    expect(r.status).toBe(200);
    const t = Api.RunTranscript.parse(r.body);
    expect(t.prompt).toMatch(/^# Task: read the pages/);
    expect(t.answer).toBe(
      "items:\n  - id: firewall-rule-request\n    title: Network firewall rule\n",
    );
    expect(t.handedBack).toEqual([
      {
        attempt: 1,
        problems: [
          "team ledger-team: quote: the quote is not on the page, word for word",
          "request firewall-rule-request: title: Invalid input",
        ],
        previousAnswer: "items:\n  - id: firewall-rule-request",
      },
    ]);
    expect(t.rounds.map((x) => x.runId)).toEqual([first, second, third]);
    expect(t.run.runId).toBe(second);
  });

  it("says there is no answer yet for a run that waits, and no run for an id it hasn't", async () => {
    const t = Api.RunTranscript.parse((await call(`/api/runs/${third}/transcript`)).body);
    expect(t.answer).toBeUndefined();
    expect(t.handedBack).toEqual([]);
    expect((await call("/api/runs/run-1-0001/transcript")).status).toBe(404);
    expect((await call("/api/runs/..%2F..%2Fetc/transcript")).status).toBe(404);
  });

  describe("starting a step on the server (ADR 0106)", () => {
    it("says the server has no model, and refuses to start one, when runtime.yaml configures none", async () => {
      expect((await call("/api/runs")).body).toMatchObject({ serverModel: null });
      const r = await post("/api/runs", { args: ["scan", "survey", "forge-ledger"] });
      expect(r.status).toBe(409);
      expect(String(r.body.detail)).toMatch(/runtime\.yaml configures no model/);
      expect(started).toEqual([]);
    });

    it("starts an AI step with the configured model, as a job, and only an AI step", async () => {
      await setModel("schemaVersion: 1\nadapters:\n  model: { type: anthropic }\n");
      expect((await call("/api/runs")).body).toMatchObject({ serverModel: "anthropic" });
      const r = await post("/api/runs", { args: ["scan", "survey", "forge-ledger"] });
      expect(r.status).toBe(202);
      expect(r.body.jobId).toEqual(expect.any(String));
      for (let i = 0; i < 50 && !started.length; i++) await new Promise((x) => setTimeout(x, 20));
      expect(started).toEqual([["scan", "survey", "forge-ledger", "--mode", "model"]]);
      // The job's result names the run the step made, so the app links to it.
      let job = (await call(`/api/jobs/${String(r.body.jobId)}`)).body;
      for (let i = 0; i < 50 && job.state !== "done"; i++) {
        await new Promise((x) => setTimeout(x, 20));
        job = (await call(`/api/jobs/${String(r.body.jobId)}`)).body;
      }
      expect(job.result).toMatchObject({ code: 0, runId: "run-20261023034004-0001" });
      expect(
        (await post("/api/runs", { args: ["change", "handoff", "add-transfer-limit"] })).status,
      ).toBe(400);
      expect((await post("/api/runs", { args: ["scan", "survey", "--force"] })).status).toBe(400);
      expect((await post("/api/runs", { args: [] })).status).toBe(400);
      expect(started).toHaveLength(1);
    });

    it("gives the step the configured model's limit when runtime.yaml says it (ADR 0112)", async () => {
      await setModel(
        "schemaVersion: 1\nadapters:\n  model: { type: openai-compatible, settings: { model: forge-small, maxInput: 12078 } }\n",
      );
      const before = started.length;
      const r = await post("/api/runs", { args: ["spec", "draft", "forge-ledger"] });
      expect(r.status).toBe(202);
      for (let i = 0; i < 50 && started.length === before; i++)
        await new Promise((x) => setTimeout(x, 20));
      expect(started.slice(before)).toEqual([
        ["spec", "draft", "forge-ledger", "--mode", "model", "--max-tokens", "12078"],
      ]);
    });
  });
});
