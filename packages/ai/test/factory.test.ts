import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentDefinition, DEFAULT_RUNTIME, Runtime } from "@maycombhq/core";
import {
  AiOffError,
  clearModelProviders,
  registerModelProvider,
  registeredModelProviders,
  registerToolSource,
  buildContextPack,
  createRuntime,
  DATA_RULE,
  HandoffRuntime,
  HeadlessClaudeCodeRuntime,
  MockRuntime,
  ModelRuntime,
  ReplayRuntime,
  RuntimeConfigError,
  runtimeForCli,
  type AiRequest,
  type HeadlessInvocation,
  type ModelProvider,
} from "../src/index.js";

const NOW = new Date("2026-10-18T06:00:00Z");
const now = () => NOW;

const agent = AgentDefinition.parse({
  schemaVersion: 1,
  id: "task-runner",
  role: "developer",
  description: "Implements one task of a change in its repo.",
  inputs: ["stories", "design", "tasks"],
  outputArtifact: "code",
  tokenBudget: 5000,
  allowedRuntimes: ["hand-off", "model", "headless-claude-code", "mock", "replay"],
});

function request(): AiRequest {
  const pack = buildContextPack({
    change: "add-transfer-limit",
    agent: agent.id,
    budget: 5000,
    levels: ["public", "internal"],
    maxClassification: "internal",
    now: NOW,
    sources: [
      {
        id: "0",
        kind: "instruction",
        origin: "atticus/taskrun",
        text: "Do task 1.2.",
        classification: "public",
        trusted: true,
      },
    ],
  });
  return { change: "add-transfer-limit", agent, pack, outputPath: "tasks/1.2/plan.md" };
}

const rt = (r: Record<string, unknown>) =>
  ({
    runtime: Runtime.parse({
      schemaVersion: 1,
      assistants: { allowed: ["copilot", "claude-code"], default: "copilot" },
      ...r,
    }),
  }) as const;

const tmp = () => mkdtemp(join(tmpdir(), "atticus-factory-"));

describe("createRuntime", () => {
  it("gives the hand-off runtime by default (the built-in runtime.yaml)", async () => {
    const r = await createRuntime({ runtime: DEFAULT_RUNTIME }, { root: await tmp() });
    expect(r).toBeInstanceOf(HandoffRuntime);
    expect(r.kind).toBe("hand-off");
  });

  it("refuses a mode runtime.yaml doesn't allow, saying what to change", async () => {
    await expect(
      createRuntime({ runtime: DEFAULT_RUNTIME }, { root: await tmp(), mode: "model" }),
    ).rejects.toThrow(/doesn't allow model mode \(allowed: hand-off\)/);
    await expect(
      createRuntime(
        { runtime: DEFAULT_RUNTIME },
        { root: await tmp(), mode: "telepathy" as never },
      ),
    ).rejects.toThrow(RuntimeConfigError);
  });

  it("starts no AI step when runtime.yaml turns AI off, but still replays recordings in tests (ADR 0046)", async () => {
    const off = rt({ ai: "off" });
    await expect(createRuntime(off, { root: await tmp() })).rejects.toThrow(AiOffError);
    await expect(createRuntime(off, { root: await tmp() })).rejects.toThrow(
      /AI is off here .*Write the artifact yourself/,
    );
    const replay = await createRuntime(off, {
      root: await tmp(),
      mode: "replay",
      replayDir: await tmp(),
    });
    expect(replay.kind).toBe("replay");
    // text-only still allows text steps.
    expect((await createRuntime(rt({ ai: "text-only" }), { root: await tmp() })).kind).toBe(
      "hand-off",
    );
  });

  it("model mode: a clear error without a model adapter or an installed provider", async () => {
    const allowed = { modes: { allowed: ["hand-off", "model"], default: "model" } };
    await expect(createRuntime(rt(allowed), { root: await tmp() })).rejects.toThrow(
      /needs a model adapter in runtime.yaml/,
    );
    await expect(
      createRuntime(
        rt({ ...allowed, adapters: { model: { type: "anthropic", settings: { model: "m" } } } }),
        { root: await tmp() },
      ),
    ).rejects.toThrow(
      "No anthropic model provider is installed. Add its plugin, or use hand-off mode.",
    );
  });

  it("model mode: uses an installed provider, honours models.allowed, no network", async () => {
    const calls: string[] = [];
    const provider = (model: string): ModelProvider => ({
      model,
      async complete(i) {
        calls.push(i.system);
        return { text: "plan", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    });
    const cfg = rt({
      modes: { allowed: ["model"], default: "model" },
      models: { allowed: ["model-a"] },
      adapters: { model: { type: "anthropic", settings: { model: "model-a" } } },
    });
    const r = await createRuntime(cfg, {
      root: await tmp(),
      now,
      providers: { anthropic: (s) => provider(String(s.model)) },
    });
    expect(r).toBeInstanceOf(ModelRuntime);
    const run = await r.run((await r.prepare(request())).runId);
    expect(run.state).toBe("validated");
    expect(run.output).toBe("plan");
    expect(calls[0]).toContain(DATA_RULE);
    const other = rt({
      modes: { allowed: ["model"], default: "model" },
      models: { allowed: ["model-a"] },
      adapters: { model: { type: "anthropic", settings: { model: "model-b" } } },
    });
    await expect(
      createRuntime(other, {
        root: await tmp(),
        providers: { anthropic: (s) => provider(String(s.model)) },
      }),
    ).rejects.toThrow(/model-b is not allowed/);
  });

  it("model mode: offers the registered tools to a mock model that calls them (ADR 0107)", async () => {
    const cfg = rt({
      modes: { allowed: ["model"], default: "model" },
      adapters: { model: { type: "mock", settings: { model: "mock-model" } } },
    });
    const root = await tmp();
    const seen: string[] = [];
    registerToolSource((r) => {
      seen.push(r);
      return () => ({
        definitions: [{ name: "show", description: "Show.", inputSchema: { type: "object" } }],
        call: async () => "shown",
      });
    });
    try {
      const r = await createRuntime(cfg, {
        root,
        now,
        modelAnswer: () => "plan",
        modelScript: (_i, round) => (round === 1 ? { calls: [{ name: "show", input: {} }] } : {}),
      });
      const run = await r.run((await r.prepare(request())).runId);
      expect(seen).toEqual([root]);
      expect(run.output).toBe("plan");
      expect(run.tools?.calls.map((c) => c.name)).toEqual(["show"]);
    } finally {
      registerToolSource(undefined);
    }
  });

  it("model mode: registered providers (ADR 0065), passed-in ones win, mock is reserved", async () => {
    const answer = (text: string) => (s: Record<string, unknown>) => ({
      model: String(s.model),
      complete: async () => ({ text, usage: { inputTokens: 1, outputTokens: 1 } }),
    });
    const cfg = rt({
      modes: { allowed: ["model"], default: "model" },
      adapters: { model: { type: "openai-compatible", settings: { model: "m" } } },
    });
    try {
      registerModelProvider("openai-compatible", answer("registered"));
      expect(registeredModelProviders()).toEqual(["openai-compatible"]);
      const r = await createRuntime(cfg, { root: await tmp() });
      expect((await r.run((await r.prepare(request())).runId)).output).toBe("registered");
      const p = await createRuntime(cfg, {
        root: await tmp(),
        providers: { "openai-compatible": answer("passed in") },
      });
      expect((await p.run((await p.prepare(request())).runId)).output).toBe("passed in");
      expect(() => registerModelProvider("mock", answer("x"))).toThrow(RuntimeConfigError);
    } finally {
      clearModelProviders();
    }
    await expect(createRuntime(cfg, { root: await tmp() })).rejects.toThrow(
      "No openai-compatible model provider is installed. Add its plugin, or use hand-off mode.",
    );
  });

  it("model mode with the mock provider answers from the prompt", async () => {
    const r = await createRuntime(
      rt({
        modes: { allowed: ["model"], default: "model" },
        adapters: { model: { type: "mock", settings: { model: "mock-1" } } },
      }),
      { root: await tmp(), modelAnswer: (p) => `saw ${p.includes("Do task 1.2") ? "task" : "?"}` },
    );
    const run = await r.run((await r.prepare(request())).runId);
    expect(run.output).toBe("saw task");
  });

  it("replay and mock need no permission from runtime.yaml but need their inputs", async () => {
    const root = await tmp();
    expect(
      await createRuntime({ runtime: DEFAULT_RUNTIME }, { root, mode: "replay", recordings: [] }),
    ).toBeInstanceOf(ReplayRuntime);
    await expect(
      createRuntime({ runtime: DEFAULT_RUNTIME }, { root, mode: "replay" }),
    ).rejects.toThrow(/needs a folder of recordings/);
    expect(
      await createRuntime({ runtime: DEFAULT_RUNTIME }, { root, mode: "mock", respond: () => "x" }),
    ).toBeInstanceOf(MockRuntime);
    await expect(
      createRuntime({ runtime: DEFAULT_RUNTIME }, { root, mode: "mock" }),
    ).rejects.toThrow(/Mock mode is for tests/);
  });

  it("headless Claude Code needs claude-code among the allowed assistants", async () => {
    const cfg = {
      runtime: Runtime.parse({
        schemaVersion: 1,
        assistants: { allowed: ["copilot"], default: "copilot" },
        modes: { allowed: ["headless-claude-code"], default: "headless-claude-code" },
      }),
    };
    await expect(createRuntime(cfg, { root: await tmp() })).rejects.toThrow(
      /doesn't list under assistants.allowed/,
    );
  });
});

describe("headless Claude Code", () => {
  const cfg = rt({ modes: { allowed: ["headless-claude-code"], default: "headless-claude-code" } });

  it("writes the prompt file and runs claude -p in the worktree through the runner", async () => {
    const root = await tmp();
    const worktree = join(root, "workspace/.worktrees/add-transfer-limit/forge-ledger");
    await mkdir(worktree, { recursive: true });
    const seen: HeadlessInvocation[] = [];
    const r = await createRuntime(cfg, {
      root,
      now,
      headless: {
        runner: async (i) => {
          seen.push(i);
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              type: "result",
              result: "Changed TransferService.java",
              is_error: false,
              usage: { input_tokens: 120, output_tokens: 30 },
            }),
            stderr: "",
          };
        },
        invocation: () => ({
          cwd: worktree,
          permissionMode: "acceptEdits",
          env: { SPECIFY_FEATURE_DIRECTORY: "specs/1.2" },
        }),
      },
    });
    expect(r).toBeInstanceOf(HeadlessClaudeCodeRuntime);
    const prepared = await r.prepare(request());
    const run = await r.run(prepared.runId);
    expect(run.state).toBe("validated");
    expect(run.output).toBe("Changed TransferService.java");
    expect(run.usage).toEqual({ inputTokens: 120, outputTokens: 30 });
    expect(seen).toHaveLength(1);
    const i = seen[0]!;
    expect(i.cwd).toBe(worktree);
    expect(i.args.slice(0, 7)).toEqual([
      "-p",
      "--output-format",
      "json",
      "--permission-mode",
      "acceptEdits",
      "--permission-prompts",
      "none",
    ]);
    expect(i.args).toContain(DATA_RULE);
    expect(i.env).toEqual({ SPECIFY_FEATURE_DIRECTORY: "specs/1.2" });
    expect(i.promptFile).toBe(join(root, ".runs/add-transfer-limit", prepared.runId, "prompt.md"));
    const file = await readFile(i.promptFile, "utf8");
    expect(file).toBe(i.prompt);
    expect(file).toContain("Do task 1.2.");
    expect(file).not.toContain("atticus handoff done");
  });

  it("runs a reviewer in a short folder of its own, so the only file it can write is its findings", async () => {
    const root = await tmp();
    const seen: HeadlessInvocation[] = [];
    const lens = AgentDefinition.parse({
      ...agent,
      id: "business-critic",
      outputArtifact: "findings",
      checklist: "constitution",
    });
    const r = await createRuntime(cfg, {
      root,
      now,
      headless: {
        runner: async (i) => {
          seen.push(i);
          // Claude Code writes the findings where its working folder is.
          await writeFile(join(i.cwd, "findings.yaml"), "findings: []\n", "utf8");
          return {
            exitCode: 0,
            stdout: JSON.stringify({ result: "Wrote findings.yaml", is_error: false }),
            stderr: "",
          };
        },
        // The step's own invocation would put it at the root, where it could edit the draft.
        invocation: () => ({ cwd: root, permissionMode: "acceptEdits" }),
      },
    });
    const prepared = await r.prepare({
      ...request(),
      agent: lens,
      outputPath: "findings.yaml",
      outputIn: "run",
    });
    const run = await r.run(prepared.runId);
    expect(run.state).toBe("validated");
    expect(run.output).toBe("findings: []\n");
    const dir = join(root, ".runs/add-transfer-limit", prepared.runId);
    // Outside the metarepo, under the system's temp folder: a short path Windows can start a
    // program in (a run folder under a deep metarepo can pass 260 characters), and nothing of
    // the metarepo's to edit. The findings are kept in the run folder; the folder is removed.
    const cwd = seen[0]!.cwd;
    expect(cwd.startsWith(tmpdir())).toBe(true);
    expect(cwd.startsWith(root)).toBe(false);
    expect(await readFile(join(dir, "findings.yaml"), "utf8")).toBe("findings: []\n");
    expect(existsSync(cwd)).toBe(false);
    expect(seen[0]!.prompt).toContain("Write the result to findings.yaml.");
    expect(seen[0]!.prompt).not.toContain(".runs/add-transfer-limit");
  });

  it("fails the run on a non-zero exit, an error result or output that isn't JSON", async () => {
    const root = await tmp();
    const answers = [
      {
        exitCode: 1,
        stdout: JSON.stringify({ result: "auth failed", is_error: true }),
        stderr: "",
      },
      { exitCode: 0, stdout: "Segmentation fault", stderr: "boom" },
    ];
    const r = await createRuntime(cfg, {
      root,
      now,
      headless: { runner: async () => answers.shift()!, invocation: () => ({ cwd: root }) },
    });
    const a = await r.run((await r.prepare(request())).runId);
    expect(a.state).toBe("failed");
    expect(a.errors[0]).toMatch(/reported a failure: auth failed/);
    const b = await r.run((await r.prepare(request())).runId);
    expect(b.state).toBe("failed");
    expect(b.errors[0]).toMatch(/without JSON output: boom/);
  });
});

describe("runtimeForCli", () => {
  async function metarepo(runtimeYaml?: string) {
    const root = await tmp();
    await mkdir(join(root, "org-pack"), { recursive: true });
    if (runtimeYaml) await writeFile(join(root, "org-pack/runtime.yaml"), runtimeYaml);
    return root;
  }

  it("reads runtime.yaml's default mode", async () => {
    const root = await metarepo();
    const r = await runtimeForCli(root, { env: {} });
    expect(r.mode).toBe("hand-off");
    expect(r.runtime).toBeInstanceOf(HandoffRuntime);
    expect(r.describe).toMatch(/handed to your assistant/);
  });

  it("takes the mode from --mode, then ATTICUS_RUNTIME, and replay from ATTICUS_REPLAY_DIR", async () => {
    const root = await metarepo();
    const r = await runtimeForCli(root, {
      env: { ATTICUS_RUNTIME: "replay", ATTICUS_REPLAY_DIR: join(root, "recordings") },
    });
    expect(r.mode).toBe("replay");
    await expect(
      runtimeForCli(root, { mode: "model", env: { ATTICUS_RUNTIME: "replay" } }),
    ).rejects.toThrow(/doesn't allow model mode/);
    await expect(runtimeForCli(root, { mode: "mock", env: {} })).rejects.toThrow(
      /Mock mode is for tests/,
    );
  });

  it("refuses a broken runtime.yaml instead of falling back to defaults", async () => {
    const root = await metarepo(
      "schemaVersion: 1\nassistants: { allowed: [copilot], default: claude-code }\n",
    );
    await expect(runtimeForCli(root, { env: {} })).rejects.toThrow(
      /org-pack\/runtime.yaml has problems/,
    );
  });
});
