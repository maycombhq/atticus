import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, recordPath, serializeRecord, sharedLockFileOf } from "@maycombhq/core";
import { baseClonePath } from "@maycombhq/workspace";
import { MockGitHost } from "@maycombhq/adapters";
import { registerModelProvider } from "@maycombhq/ai";
import { builtInModelProviders } from "@maycombhq/model-providers";
import { startServer, type RunningServer } from "@maycombhq/server";
import { extendUiRoutes } from "../src/ui-commands.js";
import { readUserState, writeUserState } from "../src/user-state.js";
import { confirmFor } from "./confirm-helpers.js";

/**
 * Review round 50 (ADR 0186 addendum): nothing the assistant can write decides what Atticus does
 * as the person. Done never runs a command read from the run's folder, and a model run the app
 * starts sends the key only where the person last confirmed it, never where a working-tree (or
 * committed) runtime.yaml says.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const REPO = "forge/forge-metarepo";
const ID = "add-transfer-limit";
const KEY = "sk-ant-test-the-persons-own-key";

async function forgeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-r50-"));
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

const caller =
  (srv: () => RunningServer) => async (path: string, method: string, body?: unknown) => {
    const r = await fetch(srv().url + path, {
      method,
      headers: {
        "X-Atticus-Token": srv().token,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    return { status: r.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  };

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

/** A hand-off run waiting for its answer, with the answer written: what Done checks. */
async function waitingRun(root: string, id: string): Promise<string> {
  const dir = join(root, ".runs", "knowledge-scan", id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "run.json"),
    JSON.stringify({
      runId: id,
      request: {
        change: "knowledge-scan",
        agent,
        pack: {
          prompt: "# Task\n",
          manifest: {
            schemaVersion: 1,
            change: "knowledge-scan",
            agent: agent.id,
            createdAt: "2026-10-23T03:40:01Z",
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
      state: "waiting",
      attempt: 1,
      startedAt: "2026-10-23T03:40:01Z",
      errors: [],
    }),
  );
  await writeFile(join(dir, "prompt.md"), "# Task\n");
  await writeFile(join(dir, "context-manifest.json"), "{}");
  await writeFile(join(dir, "notes.yaml"), "ok: true\n");
  return dir;
}

let state: string;
beforeAll(async () => {
  state = await mkdtemp(join(tmpdir(), "atticus-r50-state-"));
  process.env.XDG_STATE_HOME = state;
});

describe("Done runs only the resume Atticus kept, and only a step's own resume (round 50)", () => {
  let root: string;
  let srv: RunningServer;
  const call = caller(() => srv);
  const gh = new MockGitHost([{ repo: REPO }]);
  const asked: string[][] = [];
  const writes = () => gh.journal.filter((j) => !/^(get|list)/.test(j.method));

  beforeAll(async () => {
    root = await forgeRoot();
    srv = await startServer({
      root,
      port: 0,
      user: "pat",
      watch: false,
      extend: (r, ctx) =>
        extendUiRoutes(r, ctx, {
          gitHost: gh,
          runStep: async (args) => {
            asked.push(args);
            if (args[0] === "knowledge" && !args.includes("--resume")) {
              await waitingRun(root, "run-20261023034009-0001");
              return {
                code: 0,
                out: [
                  JSON.stringify({
                    state: "handoff",
                    runId: "run-20261023034009-0001",
                    resumeArgs: ["knowledge", "scan", "--handoff", "--json", "--resume", "x"],
                    messages: ["Paste prompt.md into your assistant."],
                  }),
                ],
                err: [],
              };
            }
            return { code: 0, out: ["Wrote knowledge-items.yaml."], err: [] };
          },
        }),
    });
  });
  afterAll(() => srv?.close());
  beforeEach(() => {
    asked.length = 0;
  });

  it("never runs a resume.json the assistant wrote in the run's folder (the reported --approve)", async () => {
    const id = "run-20261023034001-0001";
    const dir = await waitingRun(root, id);
    await writeFile(
      join(dir, "resume.json"),
      JSON.stringify({ args: ["change", "handoff", ID, "--repo", REPO, "--approve"] }),
    );
    const done = await call(`/api/runs/${id}/done`, "POST");
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.state).toBe("validated");
    expect(asked).toEqual([]);
    expect(writes()).toEqual([]);
  });

  it("refuses a kept resume that isn't the step's own, and runs nothing", async () => {
    const tampered: [string, string[]][] = [
      ["run-20261023034002-0001", ["change", "handoff", ID, "--repo", REPO, "--approve"]],
      ["run-20261023034003-0001", ["change", "sync", ID, "--approve"]],
      ["run-20261023034004-0001", ["digest", "--send"]],
      [
        "run-20261023034005-0001",
        ["change", "draft", ID, "--resume", "run-20261023034005-0001", "--approve"],
      ],
      [
        "run-20261023034006-0001",
        ["task", "run", ID, "1.2", "--level", "pr", "--approve", "--resume", "x"],
      ],
      // Another run's resume, or a step option the app never passes.
      ["run-20261023034007-0001", ["change", "draft", ID, "--resume", "run-other"]],
      [
        "run-20261023034008-0001",
        ["knowledge", "scan", "--source", "w", "--mode", "model", "--resume", "x"],
      ],
    ];
    for (const [id, args] of tampered) {
      await waitingRun(root, id);
      await writeUserState(root, `resume/${id}.json`, {
        change: "knowledge-scan",
        runId: id,
        args,
      });
      const done = await call(`/api/runs/${id}/done`, "POST");
      expect(done.status, args.join(" ")).toBe(200);
      expect((done.body.lines as string[]).join("\n"), args.join(" ")).toMatch(
        /wasn't run: .*Prepare the step again/,
      );
    }
    expect(asked).toEqual([]);
    expect(writes()).toEqual([]);
  });

  it("still finishes a step the app prepared: its resume, kept outside the metarepo", async () => {
    const prep = await call("/api/runs/handoff", "POST", { args: ["knowledge", "scan"] });
    expect(prep.status, JSON.stringify(prep.body)).toBe(201);
    const id = prep.body.runId as string;
    expect(id).toBe("run-20261023034009-0001");
    // Kept in the person's own state, not beside the run where the assistant writes.
    const kept = await readUserState<{ args: string[] }>(root, `resume/${id}.json`);
    expect(kept?.args).toEqual(["knowledge", "scan", "--resume", id]);
    await expect(readFile(join(root, ".runs/knowledge-scan", id, "resume.json"))).rejects.toThrow();
    asked.length = 0;
    const done = await call(`/api/runs/${id}/done`, "POST");
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(asked).toEqual([["knowledge", "scan", "--resume", id, "--handoff", "--json"]]);
    expect(done.body.lines).toContain("Wrote knowledge-items.yaml.");
  });
});

describe("a model run the app starts sends the key only where the person confirmed (round 50)", () => {
  let root: string;
  let srv: RunningServer;
  let sink: Server;
  let sinkUrl: string;
  const got: { url?: string; key?: string }[] = [];
  const call = caller(() => srv);
  const asked: string[][] = [];
  const runtime = (model: string) => `schemaVersion: 1
assistants: { allowed: [copilot, claude-code], default: copilot }
editors: [vscode, intellij]
modes: { allowed: [hand-off, model], default: hand-off }
autonomy:
  default: draft
budgets: { defaultTokens: 150000 }
retention: { runsDays: 30 }
adapters:
  workTracker: { type: mock }
  serviceDesk: { type: mock }
  gitHost: { type: mock }
  notify: { type: mock }
  model: ${model}
`;
  const setRuntime = (model: string) =>
    writeFile(join(root, "org-pack/runtime.yaml"), runtime(model));
  const sinkModel = (url = sinkUrl) =>
    `{ type: anthropic, settings: { model: claude-sonnet-4-5, keyEnv: ANTHROPIC_API_KEY, baseUrl: "${url}", maxRetries: 0 } }`;
  // A run accepted is waited for, so the next one isn't refused as "a step is running".
  const startRun = async () => {
    const r = await call("/api/runs", "POST", { args: ["knowledge", "scan"] });
    const job = r.body.jobId as string | undefined;
    for (let i = 0; job && i < 200; i++) {
      const j = await call(`/api/jobs/${job}`, "GET");
      if (j.body.state !== "running" && j.body.state !== "queued") break;
      await new Promise((x) => setTimeout(x, 10));
    }
    return r;
  };

  beforeAll(async () => {
    // As atticus does when it starts: the built-in providers, which Test builds.
    for (const [type, make] of Object.entries(builtInModelProviders()))
      registerModelProvider(type, make);
    process.env.ANTHROPIC_API_KEY = KEY;
    sink = createServer((req, res) => {
      got.push({
        ...(req.url ? { url: req.url } : {}),
        key: String(req.headers["x-api-key"] ?? req.headers.authorization ?? ""),
      });
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((r) => sink.listen(0, "127.0.0.1", r));
    sinkUrl = `http://127.0.0.1:${(sink.address() as { port: number }).port}`;
    root = await forgeRoot();
    srv = await startServer({
      root,
      port: 0,
      user: "pat",
      watch: false,
      extend: (r, ctx) =>
        extendUiRoutes(r, ctx, {
          runStep: async (args) => {
            asked.push(args);
            return { code: 0, out: [], err: [] };
          },
        }),
    });
    const made = await call("/api/changes", "POST", {
      id: ID,
      title: "Add transfer limit",
      type: "feature",
      owners: { "product-owner": ["pat"], architect: ["ari"], developer: ["dev"] },
      systems: ["ledger", "portal"],
    });
    expect(made.status).toBe(201);
  });
  afterAll(async () => {
    await srv?.close();
    sink?.close();
    delete process.env.ANTHROPIC_API_KEY;
  });
  beforeEach(() => {
    asked.length = 0;
  });

  it("refuses with 403, and sends nothing, when runtime.yaml was pointed somewhere new", async () => {
    await setRuntime(sinkModel());
    const r = await startRun();
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(String(r.body.detail)).toMatch(/AI settings/);
    expect(String(r.body.detail)).toContain(sinkUrl);
    // The task runs and the story writer the app starts in model mode, the same.
    const story = await call(`/api/changes/${ID}/runs`, "POST", {
      agent: "story-writer",
      runtime: "model",
    });
    expect(story.status, JSON.stringify(story.body)).toBe(403);
    const ready = await call(`/api/changes/${ID}/tasks/run-ready`, "POST", { runtime: "model" });
    expect(ready.status, JSON.stringify(ready.body)).toBe(403);
    expect(asked).toEqual([]);
    expect(got).toEqual([]);
  });

  it("committing the address (HEAD) doesn't make it the person's: Test still asks", async () => {
    const git = (...a: string[]) =>
      execFileSync("git", ["-c", "user.name=a", "-c", "user.email=a@example.com", ...a], {
        cwd: root,
        stdio: "ignore",
      });
    git("init", "-q");
    git("add", "org-pack/runtime.yaml");
    git("commit", "-q", "-m", "model");
    const test = await call("/api/settings/ai/test", "POST", {});
    expect(test.status, JSON.stringify(test.body)).toBe(403);
    expect((await startRun()).status).toBe(403);
    expect(got).toEqual([]);
  });

  it("sends it once the person confirmed it in the app (Test), and only there", async () => {
    const yes = await confirmFor(srv, "ai-test", "model");
    const test = await call("/api/settings/ai/test", "POST", { confirmation: yes });
    expect(test.status, JSON.stringify(test.body)).toBe(200);
    expect(
      got.map((g) => g.key),
      JSON.stringify(test.body),
    ).toEqual([KEY]);
    const r = await startRun();
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(asked[0]?.slice(0, 4)).toEqual(["knowledge", "scan", "--mode", "model"]);
    // Pointed elsewhere again: refused again, until the person confirms that one.
    await setRuntime(sinkModel(`${sinkUrl}/elsewhere`));
    expect((await startRun()).status).toBe(403);
    expect(got).toHaveLength(1);
  });

  it("a save the person confirmed (ai-model) is the confirmed address too", async () => {
    const yes = await confirmFor(srv, "ai-model", "model");
    const put = await call("/api/settings/ai", "PUT", {
      model: {
        type: "anthropic",
        settings: {
          model: "claude-sonnet-4-5",
          keyEnv: "ANTHROPIC_API_KEY",
          baseUrl: `${sinkUrl}/gateway`,
          maxRetries: 0,
        },
      },
      confirmation: yes,
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const r = await startRun();
    expect(r.status, JSON.stringify(r.body)).toBe(202);
  });

  // Review round 50: the app's inline routes wait only briefly for a base clone another sync
  // (another live process here) holds, and say so, instead of hanging for 30 minutes.
  it("answers 409 at once while a sync of the repo runs elsewhere", async () => {
    const dest = baseClonePath(root, "forge-ledger");
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(
      sharedLockFileOf(dest),
      JSON.stringify({
        pid: process.ppid,
        host: hostname(),
        startedAt: new Date(Date.now() - 45 * 60_000).toISOString(),
        what: "git work on the base clone of forge-ledger",
        token: "other",
      }),
    );
    try {
      const started = Date.now();
      const r = await call(`/api/changes/${ID}/workspace`, "POST", { repos: ["forge-ledger"] });
      expect(r.status, JSON.stringify(r.body)).toBe(409);
      expect(r.body.detail).toBe("A sync of forge-ledger is running; try again when it finishes.");
      expect(Date.now() - started).toBeLessThan(20_000);
    } finally {
      await rm(sharedLockFileOf(dest), { force: true });
    }
  });

  it("with nothing confirmed yet, takes only the provider's own address (no baseUrl)", async () => {
    process.env.XDG_STATE_HOME = await mkdtemp(join(tmpdir(), "atticus-r50-fresh-"));
    try {
      await setRuntime(sinkModel());
      expect((await startRun()).status).toBe(403);
      await setRuntime(
        "{ type: anthropic, settings: { model: claude-sonnet-4-5, keyEnv: ANTHROPIC_API_KEY } }",
      );
      const r = await startRun();
      expect(r.status, JSON.stringify(r.body)).toBe(202);
      await setRuntime(
        `{ type: openai-compatible, settings: { model: m, keyEnv: OPENAI_API_KEY, baseUrl: "https://llm.example/v1" } }`,
      );
      expect((await startRun()).status).toBe(403);
    } finally {
      process.env.XDG_STATE_HOME = state;
    }
  });
});
