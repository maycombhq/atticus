import { describe, expect, it } from "vitest";
import type { ChatInput } from "@maycombhq/ai";
import {
  AnthropicProvider,
  BedrockProvider,
  ModelProviderError,
  OpenAiCompatibleProvider,
  type HttpRequest,
  type Transport,
} from "../src/index.js";

// ADR 0107 addendum: each built-in provider speaks its own tool-call API. Every reply here is
// a recorded shape answered by a scripted transport; nothing leaves the process.

const KEY = "test-key-NOT-real-7f3a9c";
const env = { ATTICUS_MODEL_KEY: KEY };

function scripted(replies: unknown[]) {
  const requests: HttpRequest[] = [];
  const transport: Transport = async (r) => {
    requests.push(r);
    return { status: 200, headers: new Headers(), text: JSON.stringify(replies.shift() ?? {}) };
  };
  return { requests, transport };
}

const tools = [
  {
    name: "show",
    description: "Show one record in full.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
];

/** A conversation one round in: the prompt, the model's call, the tool's result. */
const second: ChatInput = {
  system: "You are the feature-placer agent.",
  tools,
  maxOutputTokens: 2000,
  messages: [
    { role: "user", text: "Place the change." },
    {
      role: "assistant",
      text: "",
      calls: [{ id: "c1", name: "show", input: { id: "forge-ledger" } }],
    },
    { role: "tool", results: [{ id: "c1", name: "show", text: "System forge-ledger" }] },
  ],
};

describe("anthropic tool calls", () => {
  const p = (transport: Transport) =>
    new AnthropicProvider(
      { model: "claude-opus-5-5", keyEnv: "ATTICUS_MODEL_KEY" },
      { env, transport },
    );

  it("reads tool_use blocks as calls", async () => {
    const { requests, transport } = scripted([
      {
        content: [
          { type: "text", text: "Looking it up." },
          { type: "tool_use", id: "toolu_1", name: "show", input: { id: "forge-ledger" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 100, output_tokens: 20 },
      },
    ]);
    const turn = await p(transport).chat({ ...second, messages: [second.messages[0]!] });
    expect(turn).toEqual({
      text: "Looking it up.",
      calls: [{ id: "toolu_1", name: "show", input: { id: "forge-ledger" } }],
      usage: { inputTokens: 100, outputTokens: 20 },
    });
    const body = JSON.parse(requests[0]!.body);
    expect(body.tools).toEqual([
      {
        name: "show",
        description: "Show one record in full.",
        input_schema: tools[0]!.inputSchema,
      },
    ]);
    expect(body.tool_choice).toEqual({ type: "auto" });
  });

  it("sends the call back as tool_use and the result as tool_result; final means tool_choice none", async () => {
    const { requests, transport } = scripted([
      { content: [{ type: "text", text: "feature: ledger" }], stop_reason: "end_turn", usage: {} },
    ]);
    const turn = await p(transport).chat({ ...second, final: true });
    expect(turn.text).toBe("feature: ledger");
    expect(turn.calls).toEqual([]);
    const body = JSON.parse(requests[0]!.body);
    expect(body.tool_choice).toEqual({ type: "none" });
    expect(body.messages).toEqual([
      { role: "user", content: "Place the change." },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "c1", name: "show", input: { id: "forge-ledger" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "c1", content: "System forge-ledger" }],
      },
    ]);
  });

  it("refuses a cut-off turn", async () => {
    const { transport } = scripted([{ content: [], stop_reason: "max_tokens" }]);
    await expect(p(transport).chat(second)).rejects.toBeInstanceOf(ModelProviderError);
  });
});

describe("openai-compatible tool calls", () => {
  const p = (transport: Transport) =>
    new OpenAiCompatibleProvider(
      {
        baseUrl: "https://llm-gateway.example/v1",
        model: "tidewater-llm-70b",
        keyEnv: "ATTICUS_MODEL_KEY",
      },
      { env, transport },
    );

  it("reads tool_calls (arguments as JSON text) and sends results as tool messages", async () => {
    const { requests, transport } = scripted([
      {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_9",
                  type: "function",
                  function: { name: "show", arguments: '{"id":"forge-ledger"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 8 },
      },
    ]);
    const turn = await p(transport).chat(second);
    expect(turn.calls).toEqual([{ id: "call_9", name: "show", input: { id: "forge-ledger" } }]);
    const body = JSON.parse(requests[0]!.body);
    expect(body.tools[0]).toEqual({
      type: "function",
      function: {
        name: "show",
        description: "Show one record in full.",
        parameters: tools[0]!.inputSchema,
      },
    });
    expect(body.tool_choice).toBe("auto");
    expect(body.messages.slice(1)).toEqual([
      { role: "user", content: "Place the change." },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "show", arguments: '{"id":"forge-ledger"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "System forge-ledger" },
    ]);
  });

  it("final asks for no tools; a broken arguments string is an empty input", async () => {
    const { requests, transport } = scripted([
      {
        choices: [
          {
            message: {
              tool_calls: [{ id: "x", function: { name: "show", arguments: "{not json" } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    ]);
    const turn = await p(transport).chat({ ...second, final: true });
    expect(turn.calls[0]!.input).toEqual({});
    expect(JSON.parse(requests[0]!.body).tool_choice).toBe("none");
  });
});

describe("bedrock tool calls", () => {
  it("reads toolUse blocks and sends toolResult blocks, with the tools in toolConfig", async () => {
    const { requests, transport } = scripted([
      {
        output: {
          message: {
            role: "assistant",
            content: [{ toolUse: { toolUseId: "tu-1", name: "show", input: { id: "forge-pay" } } }],
          },
        },
        stopReason: "tool_use",
        usage: { inputTokens: 70, outputTokens: 5 },
      },
    ]);
    const p = new BedrockProvider(
      { model: "anthropic.claude-opus-5-5-v1:0", region: "us-east-1" },
      {
        env: { AWS_ACCESS_KEY_ID: "AKIDEXAMPLE", AWS_SECRET_ACCESS_KEY: "secret-example" },
        transport,
        now: () => new Date("2026-10-23T12:00:00Z"),
      },
    );
    const turn = await p.chat(second);
    expect(turn.calls).toEqual([{ id: "tu-1", name: "show", input: { id: "forge-pay" } }]);
    const body = JSON.parse(requests[0]!.body);
    expect(body.toolConfig.tools[0]).toEqual({
      toolSpec: {
        name: "show",
        description: "Show one record in full.",
        inputSchema: { json: tools[0]!.inputSchema },
      },
    });
    expect(body.messages.at(-1)).toEqual({
      role: "user",
      content: [{ toolResult: { toolUseId: "c1", content: [{ text: "System forge-ledger" }] } }],
    });
    expect(requests[0]!.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
  });
});
