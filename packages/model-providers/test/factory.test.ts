import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentDefinition, Runtime } from "@maycombhq/core";
import {
  AiOffError,
  buildContextPack,
  clearModelProviders,
  createRuntime,
  DATA_RULE,
  ModelRuntime,
  registerModelProvider,
  registeredModelProviders,
  type AiRequest,
} from "@maycombhq/ai";
import {
  builtInModelProviders,
  registerBuiltInModelProviders,
  type HttpRequest,
} from "../src/index.js";

const NOW = new Date("2026-10-20T06:00:00Z");
const agent = AgentDefinition.parse({
  schemaVersion: 1,
  id: "designer",
  role: "architect",
  description: "Drafts the design of a change.",
  inputs: ["stories"],
  outputArtifact: "design",
  tokenBudget: 5000,
  allowedRuntimes: ["model"],
});
const request = (): AiRequest => ({
  change: "add-transfer-limit",
  agent,
  outputPath: "design.md",
  pack: buildContextPack({
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
        origin: "atticus",
        text: "Design the Forge transfer limit.",
        classification: "public",
        trusted: true,
      },
    ],
  }),
});
const rt = (r: Record<string, unknown>) => ({
  runtime: Runtime.parse({
    schemaVersion: 1,
    assistants: { allowed: ["copilot"], default: "copilot" },
    modes: { allowed: ["model"], default: "model" },
    ...r,
  }),
});
const tmp = () => mkdtemp(join(tmpdir(), "atticus-providers-"));
const KEY = "factory-test-key-not-real";

afterEach(() => clearModelProviders());

function recorder(text: string) {
  const sent: HttpRequest[] = [];
  return {
    sent,
    transport: async (r: HttpRequest) => {
      sent.push(r);
      return {
        status: 200,
        headers: new Headers(),
        text: JSON.stringify({
          content: [{ type: "text", text }],
          stop_reason: "end_turn",
          usage: { input_tokens: 11, output_tokens: 7 },
        }),
      };
    },
  };
}

describe("runtime.yaml model mode with the built-in providers", () => {
  it("registers anthropic, openai-compatible, azure-openai and bedrock", () => {
    registerBuiltInModelProviders();
    expect(registeredModelProviders()).toEqual([
      "anthropic",
      "azure-openai",
      "bedrock",
      "openai-compatible",
    ]);
  });

  it("adapters.model.type anthropic runs a step end to end (no network), with usage from the response", async () => {
    const r = recorder("# Design");
    registerBuiltInModelProviders({ env: { ATTICUS_MODEL_KEY: KEY }, transport: r.transport });
    const runtime = await createRuntime(
      rt({
        models: { allowed: ["claude-opus-5-5"] },
        adapters: {
          model: {
            type: "anthropic",
            settings: { model: "claude-opus-5-5", keyEnv: "ATTICUS_MODEL_KEY" },
          },
        },
      }),
      { root: await tmp() },
    );
    expect(runtime).toBeInstanceOf(ModelRuntime);
    const run = await runtime.run((await runtime.prepare(request())).runId);
    expect(run.state).toBe("validated");
    expect(run.output).toBe("# Design");
    expect(run.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    expect(JSON.parse(r.sent[0]!.body).system).toContain(DATA_RULE);
  });

  it("models.allowed still refuses a model it doesn't list", async () => {
    registerBuiltInModelProviders({
      env: { ATTICUS_MODEL_KEY: KEY },
      transport: recorder("x").transport,
    });
    await expect(
      createRuntime(
        rt({
          models: { allowed: ["claude-sonnet-5-5"] },
          adapters: {
            model: {
              type: "anthropic",
              settings: { model: "claude-opus-5-5", keyEnv: "ATTICUS_MODEL_KEY" },
            },
          },
        }),
        { root: await tmp() },
      ),
    ).rejects.toThrow("model claude-opus-5-5 is not allowed by runtime.yaml");
  });

  it("ai: off still starts nothing, even with providers installed", async () => {
    registerBuiltInModelProviders({
      env: { ATTICUS_MODEL_KEY: KEY },
      transport: recorder("x").transport,
    });
    await expect(
      createRuntime(
        rt({
          ai: "off",
          adapters: {
            model: { type: "anthropic", settings: { model: "m", keyEnv: "ATTICUS_MODEL_KEY" } },
          },
        }),
        { root: await tmp() },
      ),
    ).rejects.toThrow(AiOffError);
  });

  it("a type with no provider keeps the plain message (vertex has none built in)", async () => {
    registerBuiltInModelProviders();
    await expect(
      createRuntime(rt({ adapters: { model: { type: "vertex", settings: { model: "m" } } } }), {
        root: await tmp(),
      }),
    ).rejects.toThrow(
      "No vertex model provider is installed. Add its plugin, or use hand-off mode.",
    );
  });

  it("a failed call fails the run with the plain message, never the key", async () => {
    registerBuiltInModelProviders({
      env: { ATTICUS_MODEL_KEY: KEY },
      transport: async () => ({
        status: 401,
        headers: new Headers(),
        text: `{"error":{"message":"bad ${KEY}"}}`,
      }),
    });
    const runtime = await createRuntime(
      rt({
        adapters: {
          model: { type: "anthropic", settings: { model: "m", keyEnv: "ATTICUS_MODEL_KEY" } },
        },
      }),
      { root: await tmp() },
    );
    const run = await runtime.run((await runtime.prepare(request())).runId);
    expect(run.state).toBe("failed");
    expect(run.errors[0]).toMatch(/refused the credentials \(HTTP 401\)/);
    expect(JSON.stringify(run)).not.toContain(KEY);
  });

  it("an organisation's own provider registers the same way and can replace a built-in", async () => {
    registerBuiltInModelProviders();
    registerModelProvider("tidewater-gateway", (s) => ({
      model: String(s.model),
      complete: async () => ({
        text: "from the house gateway",
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    }));
    const runtime = await createRuntime(
      rt({ adapters: { model: { type: "anthropic", settings: { model: "m" } } } }),
      {
        root: await tmp(),
        providers: {
          anthropic: (s) => ({
            model: String(s.model),
            complete: async () => ({
              text: "passed in",
              usage: { inputTokens: 1, outputTokens: 1 },
            }),
          }),
        },
      },
    );
    const run = await runtime.run((await runtime.prepare(request())).runId);
    expect(run.output).toBe("passed in");
    expect(() => registerModelProvider("mock", builtInModelProviders().anthropic!)).toThrow(
      /test provider/,
    );
  });
});

describe("runtime.yaml (C6) for model providers", () => {
  const parse = (model: unknown) =>
    Runtime.safeParse({
      schemaVersion: 1,
      assistants: { allowed: ["copilot"], default: "copilot" },
      adapters: { model },
    });

  it("accepts openai-compatible, and keyEnv as a setting name", () => {
    expect(
      parse({
        type: "openai-compatible",
        settings: { model: "m", baseUrl: "https://gw.example/v1", keyEnv: "ATTICUS_MODEL_KEY" },
      }).success,
    ).toBe(true);
  });

  it("still refuses secret-looking setting names such as apiKey", () => {
    const r = parse({ type: "anthropic", settings: { apiKey: "x" } });
    expect(r.success).toBe(false);
  });
});
