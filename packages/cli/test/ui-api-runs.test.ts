import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api } from "@maycombhq/core";
import { startServer, type RunningServer, type ServerContext } from "@maycombhq/server";
import { uiModelRunRoutes } from "../src/ui-api-runs.js";
import { recordConfirmedAddress } from "../src/model-address.js";
import { readUserState } from "../src/user-state.js";

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

let srvCtx: ServerContext;
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
    extend: (r, ctx) => {
      srvCtx = ctx;
      return uiModelRunRoutes(r, ctx, { runStep: fakeStep });
    },
  });
});
afterAll(async () => srv?.close());

describe("model runs (ADR 0106)", () => {
  it("lists every run, newest first, with its step, round and whether it was answered", async () => {
    const r = await call("/api/runs");
    expect(r.status).toBe(200);
    const list = Api.RunList.parse(r.body);
    // Third UX walk: each run says its errors, as the run page reads them (a failed run's page
    // crashed without).
    const raw = r.body as unknown as { runs: { errors?: unknown }[] };
    expect(raw.runs.every((x) => Array.isArray(x.errors))).toBe(true);
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

    // Round 41: one AI step at a time; a second would also take the other's run as its own.
    it("refuses a second AI step while one runs, naming the one that runs", async () => {
      await setModel("schemaVersion: 1\nadapters:\n  model: { type: anthropic }\n");
      let release!: () => void;
      const busy = srvCtx.jobs.start("step", () => new Promise<void>((x) => (release = x)));
      const before = started.length;
      try {
        const r = await post("/api/runs", { args: ["scan", "survey", "forge-ledger"] });
        expect(r.status).toBe(409);
        expect(String(r.body.detail)).toContain(busy.id);
        expect(String(r.body.detail)).toMatch(/AI step is running/);
        expect(started).toHaveLength(before);
      } finally {
        release();
        await srvCtx.jobs.settle(busy.id);
      }
      expect((await post("/api/runs", { args: ["scan", "survey", "forge-ledger"] })).status).toBe(
        202,
      );
      for (let i = 0; i < 50 && started.length === before; i++)
        await new Promise((x) => setTimeout(x, 20));
      await srvCtx.jobs.settle(srvCtx.jobs.runningOf("step")?.id ?? busy.id);
    });

    it("gives the step the configured model's limit when runtime.yaml says it (ADR 0112)", async () => {
      await setModel(
        "schemaVersion: 1\nadapters:\n  model: { type: openai-compatible, settings: { model: forge-small, maxInput: 12078 } }\n",
      );
      // Round 50: a provider with no address of its own is sent the key once the person
      // confirmed where it goes (Test or a save in the app's AI settings).
      await recordConfirmedAddress(root, {
        type: "openai-compatible",
        settings: { model: "forge-small", maxInput: 12078 },
      });
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

describe("a step prepared for the person's own assistant (UX review)", () => {
  it("runs it with --handoff, with no model needed, and gives the run to open", async () => {
    const asked: string[][] = [];
    const s = await startServer({
      root,
      port: 0,
      user: "pat",
      version: "1.0.0",
      extend: (r, ctx) =>
        uiModelRunRoutes(r, ctx, {
          runStep: async (args) => {
            asked.push(args);
            const id = await run(
              9,
              "2026-10-23T03:40:09Z",
              "# Task: write the stories\n",
              "waiting",
            );
            return {
              code: 0,
              out: [
                JSON.stringify({
                  state: "handoff",
                  runId: id,
                  resumeArgs: [...args.filter((a) => a !== "--json"), "--json", "--resume", id],
                  messages: ["Paste prompt.md into your assistant."],
                }),
              ],
              err: [],
            };
          },
        }),
    });
    try {
      await setModel("schemaVersion: 1\n");
      const r = await fetch(s.url + "/api/runs/handoff", {
        method: "POST",
        headers: { "X-Atticus-Token": s.token, "Content-Type": "application/json" },
        body: JSON.stringify({ args: ["plan", "stories", "add-limit"] }),
      });
      const body = (await r.json()) as { runId?: string; lines?: string[] };
      expect(r.status, JSON.stringify(body)).toBe(201);
      expect(asked).toEqual([["plan", "stories", "add-limit", "--handoff", "--json"]]);
      expect(body.runId).toBe("run-20261023034009-0001");
      expect(body.lines).toEqual(["Paste prompt.md into your assistant."]);
      // Fourth UX walk: its resume is kept, so Done finishes the step. Round 50: in the
      // person's own state, made from the words the step was started with, never beside the run.
      const kept = await readUserState<{ args: string[] }>(root, `resume/${body.runId!}.json`);
      expect(kept?.args).toEqual(["plan", "stories", "add-limit", "--resume", body.runId]);
      await expect(
        readFile(join(root, ".runs", "knowledge-scan", body.runId!, "resume.json"), "utf8"),
      ).rejects.toThrow();
    } finally {
      await s.close();
    }
  });
});

describe("a wiki's own scan from the app (UX review, round 36)", () => {
  it("passes knowledge scan's --source with its value, and no other option", async () => {
    const asked: string[][] = [];
    const s = await startServer({
      root,
      port: 0,
      user: "pat",
      version: "1.0.0",
      extend: (r, ctx) =>
        uiModelRunRoutes(r, ctx, {
          runStep: async (args) => {
            asked.push(args);
            await run(7, "2026-10-23T03:40:07Z", "# Task: read the wiki\n", "waiting");
            return { code: 0, out: ["Run prepared."], err: [] };
          },
        }),
    });
    const prep = (args: string[]) =>
      fetch(s.url + "/api/runs/handoff", {
        method: "POST",
        headers: { "X-Atticus-Token": s.token, "Content-Type": "application/json" },
        body: JSON.stringify({ args }),
      });
    try {
      await setModel("schemaVersion: 1\n");
      const ok = await prep(["knowledge", "scan", "--source", "forge-wiki"]);
      expect(ok.status, await ok.clone().text()).toBe(201);
      expect(asked).toEqual([
        ["knowledge", "scan", "--source", "forge-wiki", "--handoff", "--json"],
      ]);
      // Only --source, only on the steps that read a wiki, once, and only with a value.
      for (const bad of [
        ["knowledge", "scan", "--full"],
        ["knowledge", "scan", "--source"],
        ["knowledge", "scan", "--source", "--mode"],
        ["knowledge", "scan", "--source", "a", "--source", "b"],
        ["scan", "survey", "--source", "forge-wiki"],
      ])
        expect((await prep(bad)).status, bad.join(" ")).toBe(400);
      expect(asked).toHaveLength(1);
    } finally {
      await s.close();
    }
  });
});

describe("Done finishes a step the app prepared (fourth UX walk)", () => {
  it("runs its kept resume, and names the next run when the step offers another prompt", async () => {
    const { resumeAfterDone, keepResume } = await import("../src/handoff-resume.js");
    const id = await run(8, "2026-10-23T03:40:08Z", "# Task: draft the change\n", "validated");
    const keep = () =>
      keepResume(root, "knowledge-scan", id, [
        "change",
        "draft",
        "c1",
        "--handoff",
        "--resume",
        id,
      ]);
    await keep();
    const asked: string[][] = [];
    const wrote = await resumeAfterDone(
      root,
      async (args) => {
        asked.push(args);
        return { code: 0, out: ["Wrote proposal.md and specs/limits/spec.md."], err: [] };
      },
      "knowledge-scan",
      id,
    );
    expect(asked).toEqual([["change", "draft", "c1", "--resume", id, "--handoff", "--json"]]);
    expect(wrote).toEqual({ lines: ["Wrote proposal.md and specs/limits/spec.md."] });
    // Round 50: a kept resume runs once.
    expect(
      await resumeAfterDone(
        root,
        async () => ({ code: 0, out: [], err: [] }),
        "knowledge-scan",
        id,
      ),
    ).toBeUndefined();
    await keep();
    const next = await resumeAfterDone(
      root,
      async () => {
        const n = await run(7, "2026-10-23T03:40:07Z", "# Task: the next part\n", "waiting");
        return {
          code: 0,
          out: [JSON.stringify({ state: "handoff", runId: n, messages: ["Next part."] })],
          err: [],
        };
      },
      "knowledge-scan",
      id,
    );
    expect(next).toEqual({ next: "run-20261023034007-0001", lines: ["Next part."] });
    expect(
      await resumeAfterDone(
        root,
        async () => ({ code: 0, out: [], err: [] }),
        "knowledge-scan",
        "run-none",
      ),
    ).toBeUndefined();
  });

  // Sixth UX walk: a step the app prepared said what to type in a terminal next; the app says
  // what to do in the app instead, and the command line keeps its commands.
  it("says what to do next in the app, not on the command line", async () => {
    const { resumeAfterDone, prepareStep, appLines, keepResume } =
      await import("../src/handoff-resume.js");
    const id = await run(6, "2026-10-23T03:40:06Z", "# Task: place the change\n", "validated");
    await keepResume(root, "knowledge-scan", id, [
      "change",
      "feature",
      "c1",
      "--handoff",
      "--resume",
      id,
    ]);
    const next = await resumeAfterDone(
      root,
      async () => {
        const n = await run(5, "2026-10-23T03:40:05Z", "# Task: the critic's lens\n", "waiting");
        return {
          code: 0,
          out: [
            JSON.stringify({
              state: "handoff",
              runId: n,
              messages: [
                `Context: 3 records. Handed the critic's true lens to your assistant to review the feature draft (run ${n}). When it is done, run: atticus handoff done ${n}, then atticus change feature c1 --resume ${n}`,
              ],
            }),
          ],
          err: [],
        };
      },
      "knowledge-scan",
      id,
    );
    expect(next!.lines).toEqual([
      "Context: 3 records. Handed the critic's true lens to your assistant to review the feature draft (run run-20261023034005-0001). The next prompt is ready: open it on Runs.",
    ]);
    // Prepared from the app: its prompt is the one just prepared.
    const prep = await prepareStep(
      root,
      async () => ({
        code: 0,
        out: [
          "Handed the change's needs to your assistant (run run-x). When it is done: atticus handoff done run-x, then atticus change needs c1 --resume run-x",
        ],
        err: [],
      }),
      ["change", "needs", "c1"],
    );
    expect(prep.prepared.lines).toEqual([
      "Handed the change's needs to your assistant (run run-x). The prompt is ready: open it on Runs, then press Done once your assistant has written the answer.",
    ]);
    // A stage that stopped for a person, or finished.
    expect(
      appLines([
        `Answer each with atticus questions answer <id> --option <n> (or --text "..."), or with /atticus-answer.`,
        "Then run atticus change feature c1 again.",
        "Then run atticus change architecture c1 again.",
        "Then run atticus plan stories c1 --resume run-x again.",
        "Answer the questions first, then run atticus plan stories c1 again: the next draft gets your answers and the problems above.",
        "Open the stage's pull request for a person to approve: atticus change handoff c1 --approve",
        "Wrote feature.yaml.",
      ]),
    ).toEqual([
      "Answer each on Questions.",
      "Then prepare the feature stage again on Feature design.",
      "Then prepare the architecture stage again on Architecture.",
      "Then prepare the stories stage again on Stories.",
      "Answer the questions first, then prepare the stories stage again on Stories: the next draft gets your answers and the problems above.",
      "Raise the stage's hand-off on the change page for a person to approve.",
      "Wrote feature.yaml.",
    ]);
  });

  it("says what a step said in its JSON when it hands nothing off (round 39)", async () => {
    const { prepareStep } = await import("../src/handoff-resume.js");
    const r = await prepareStep(
      root,
      async () => ({
        code: 1,
        out: [
          JSON.stringify(
            {
              state: "stopped",
              messages: ["forge-notes already has scan settings."],
              errors: ["Nothing to read."],
              questions: [{ id: "q1", question: "Which host is it?" }],
            },
            null,
            2,
          ),
        ],
        err: [],
      }),
      ["scan", "survey", "forge-notes"],
    );
    expect(r.prepared.lines).toEqual([
      "forge-notes already has scan settings.",
      "Nothing to read.",
      "Question q1: Which host is it? (answer it on Questions)",
    ]);
  });
});
