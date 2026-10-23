import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  AnthropicProvider,
  BedrockProvider,
  ModelProviderError,
  OpenAiCompatibleProvider,
  TransportError,
  backoffMs,
  retryAfterMs,
  DEFAULT_RETRY,
  type Clock,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from "../src/index.js";

const KEY = "test-key-NOT-real-7f3a9c";
const env = { ATTICUS_MODEL_KEY: KEY };

type Reply = Partial<HttpResponse> & { json?: unknown; throws?: Error };

/** A transport that records each request and answers from a script. Nothing leaves the process. */
function scripted(replies: Reply[]) {
  const requests: HttpRequest[] = [];
  const transport: Transport = async (r) => {
    requests.push(r);
    // The last reply repeats, so one 429 means "always 429".
    const next = (replies.length > 1 ? replies.shift() : replies[0]) ?? { status: 500 };
    if (next.throws) throw next.throws;
    return {
      status: next.status ?? 200,
      headers: next.headers ?? new Headers(),
      text: next.text ?? JSON.stringify(next.json ?? {}),
    };
  };
  return { requests, transport };
}

function testClock() {
  const slept: number[] = [];
  const clock: Clock = {
    sleep: async (ms) => {
      slept.push(ms);
    },
    random: () => 0.5,
    now: () => Date.parse("2026-10-20T12:00:00Z"),
  };
  return { slept, clock };
}

const input = {
  system: "You are the architect agent.",
  prompt: "Draft the design.",
  maxOutputTokens: 4000,
};

const anthropicOk = {
  json: {
    content: [
      { type: "thinking", thinking: "" },
      { type: "text", text: "# Design\n" },
      { type: "text", text: "Forge Pay calls Northwind Pay." },
    ],
    stop_reason: "end_turn",
    usage: { input_tokens: 1200, cache_read_input_tokens: 300, output_tokens: 42 },
  },
};

describe("anthropic", () => {
  it("sends the Messages API shape and reads usage from the response", async () => {
    const { requests, transport } = scripted([anthropicOk]);
    const p = new AnthropicProvider(
      { model: "claude-opus-5-5", keyEnv: "ATTICUS_MODEL_KEY" },
      { env, transport },
    );
    const out = await p.complete(input);
    expect(out).toEqual({
      text: "# Design\nForge Pay calls Northwind Pay.",
      usage: { inputTokens: 1500, outputTokens: 42 },
    });
    const r = requests[0]!;
    expect(r.url).toBe("https://api.anthropic.com/v1/messages");
    expect(r.method).toBe("POST");
    expect(r.headers).toEqual({
      "content-type": "application/json",
      accept: "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": KEY,
    });
    expect(JSON.parse(r.body)).toEqual({
      model: "claude-opus-5-5",
      max_tokens: 4000,
      system: input.system,
      messages: [{ role: "user", content: input.prompt }],
    });
    expect(r.timeoutMs).toBe(300_000);
  });

  it("a gateway base URL, bearer auth, and the output cap from settings", async () => {
    const { requests, transport } = scripted([anthropicOk]);
    const p = new AnthropicProvider(
      {
        model: "claude-opus-5-5",
        keyEnv: "ATTICUS_MODEL_KEY",
        baseUrl: "https://llm-gateway.tidewater.example/anthropic/",
        auth: "bearer",
        maxOutput: 1000,
        timeoutMs: 60_000,
      },
      { env, transport },
    );
    await p.complete({ ...input, maxOutputTokens: 190_000 });
    expect(requests[0]!.url).toBe("https://llm-gateway.tidewater.example/anthropic/v1/messages");
    expect(requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(requests[0]!.headers["x-api-key"]).toBeUndefined();
    expect(JSON.parse(requests[0]!.body).max_tokens).toBe(1000);
    expect(requests[0]!.timeoutMs).toBe(60_000);
  });

  it("takes the model's input limit as a setting, which the steps fit their prompts to (ADR 0112)", () => {
    const p = new AnthropicProvider(
      { model: "claude-opus-5-5", keyEnv: "ATTICUS_MODEL_KEY", maxInput: 180_000 },
      { env },
    );
    expect(p.maxInputTokens).toBe(180_000);
    expect(
      new AnthropicProvider({ model: "claude-opus-5-5", keyEnv: "ATTICUS_MODEL_KEY" }, { env })
        .maxInputTokens,
    ).toBeUndefined();
    expect(
      () =>
        new AnthropicProvider(
          { model: "claude-opus-5-5", keyEnv: "ATTICUS_MODEL_KEY", maxInput: 10 },
          { env },
        ),
    ).toThrow(/maxInput/);
  });

  it("refuses a cut-off or declined answer instead of using it", async () => {
    const cut = scripted([
      { json: { content: [{ type: "text", text: "half" }], stop_reason: "max_tokens" } },
    ]);
    const p = new AnthropicProvider(
      { model: "m", keyEnv: "ATTICUS_MODEL_KEY" },
      { env, transport: cut.transport },
    );
    await expect(p.complete(input)).rejects.toThrow(
      /stopped the answer at the output limit \(4000 tokens\)/,
    );
    const no = scripted([{ json: { content: [], stop_reason: "refusal" } }]);
    const q = new AnthropicProvider(
      { model: "m", keyEnv: "ATTICUS_MODEL_KEY" },
      { env, transport: no.transport },
    );
    await expect(q.complete(input)).rejects.toThrow(/declined to answer \(refusal\)/);
  });
});

describe("openai-compatible", () => {
  const ok = {
    json: {
      choices: [{ message: { role: "assistant", content: "plan" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 900, completion_tokens: 12 },
    },
  };

  it("plain base URL (gateway, vLLM): Chat Completions with a bearer key", async () => {
    const { requests, transport } = scripted([ok]);
    const p = new OpenAiCompatibleProvider(
      {
        model: "tidewater-llm-70b",
        baseUrl: "https://llm-gateway.tidewater.example/v1",
        keyEnv: "ATTICUS_MODEL_KEY",
      },
      { env, transport },
    );
    expect(await p.complete(input)).toEqual({
      text: "plan",
      usage: { inputTokens: 900, outputTokens: 12 },
    });
    const r = requests[0]!;
    expect(r.url).toBe("https://llm-gateway.tidewater.example/v1/chat/completions");
    expect(r.headers).toEqual({
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${KEY}`,
    });
    expect(JSON.parse(r.body)).toEqual({
      model: "tidewater-llm-70b",
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.prompt },
      ],
      max_tokens: 4000,
      stream: false,
    });
  });

  it("no key for a server on this machine; max_completion_tokens when asked", async () => {
    const { requests, transport } = scripted([ok]);
    const p = new OpenAiCompatibleProvider(
      {
        model: "local",
        baseUrl: "http://127.0.0.1:8000/v1",
        outputLimitField: "max_completion_tokens",
      },
      { env: {}, transport },
    );
    await p.complete(input);
    expect(requests[0]!.headers.authorization).toBeUndefined();
    expect(JSON.parse(requests[0]!.body).max_completion_tokens).toBe(4000);
  });

  it("Azure: deployment URL, api-version, the api-key header, no model in the body", async () => {
    const { requests, transport } = scripted([ok]);
    const p = new OpenAiCompatibleProvider(
      {
        baseUrl: "https://tidewater-ai.openai.azure.com",
        deployment: "atticus-gpt",
        apiVersion: "2024-10-21",
        keyEnv: "ATTICUS_MODEL_KEY",
      },
      { env, transport, flavour: "azure" },
    );
    expect(p.model).toBe("atticus-gpt");
    await p.complete(input);
    const r = requests[0]!;
    expect(r.url).toBe(
      "https://tidewater-ai.openai.azure.com/openai/deployments/atticus-gpt/chat/completions?api-version=2024-10-21",
    );
    expect(r.headers["api-key"]).toBe(KEY);
    expect(r.headers.authorization).toBeUndefined();
    expect(JSON.parse(r.body).model).toBeUndefined();
  });

  it("Azure with an Entra ID token: auth bearer", async () => {
    const { requests, transport } = scripted([ok]);
    await new OpenAiCompatibleProvider(
      {
        flavour: "azure",
        model: "gpt-4o",
        baseUrl: "https://tidewater-ai.openai.azure.com",
        deployment: "atticus-gpt",
        apiVersion: "2024-10-21",
        keyEnv: "ATTICUS_MODEL_KEY",
        auth: "bearer",
      },
      { env, transport },
    ).complete(input);
    expect(requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(requests[0]!.headers["api-key"]).toBeUndefined();
  });

  it("length and content_filter are refused; missing usage is estimated", async () => {
    const mk = (json: unknown) =>
      new OpenAiCompatibleProvider(
        { model: "m", baseUrl: "https://gw.example/v1" },
        { env: {}, transport: scripted([{ json }]).transport },
      );
    await expect(
      mk({ choices: [{ message: { content: "x" }, finish_reason: "length" }] }).complete(input),
    ).rejects.toThrow(/output limit/);
    await expect(
      mk({ choices: [{ message: { content: null }, finish_reason: "content_filter" }] }).complete(
        input,
      ),
    ).rejects.toThrow(/declined to answer \(content filter\)/);
    const out = await mk({
      choices: [{ message: { content: "abcdefgh" }, finish_reason: "stop" }],
    }).complete(input);
    expect(out.usage.inputTokens).toBeGreaterThan(0);
    expect(out.usage.outputTokens).toBeGreaterThan(0);
  });
});

describe("bedrock", () => {
  const awsEnv = {
    AWS_ACCESS_KEY_ID: "AKIDEXAMPLE",
    AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    AWS_SESSION_TOKEN: "session-token-example",
  };
  const ok = {
    json: {
      output: { message: { role: "assistant", content: [{ text: "stories" }] } },
      stopReason: "end_turn",
      usage: { inputTokens: 700, outputTokens: 9, totalTokens: 709 },
    },
  };

  it("sends the Converse shape, signed with SigV4", async () => {
    const { requests, transport } = scripted([ok]);
    const p = new BedrockProvider(
      { model: "anthropic.claude-opus-5-5-v1:0", region: "us-east-1" },
      { env: awsEnv, transport, now: () => new Date("2026-10-20T12:00:00Z") },
    );
    expect(await p.complete(input)).toEqual({
      text: "stories",
      usage: { inputTokens: 700, outputTokens: 9 },
    });
    const r = requests[0]!;
    expect(r.url).toBe(
      "https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-opus-5-5-v1%3A0/converse",
    );
    expect(JSON.parse(r.body)).toEqual({
      system: [{ text: input.system }],
      messages: [{ role: "user", content: [{ text: input.prompt }] }],
      inferenceConfig: { maxTokens: 4000 },
    });
    expect(r.headers["x-amz-date"]).toBe("20261020T120000Z");
    expect(r.headers["x-amz-security-token"]).toBe("session-token-example");
    expect(r.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261020\/us-east-1\/bedrock\/aws4_request, SignedHeaders=accept;content-type;host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/,
    );
  });

  it("a VPC endpoint base URL; a retry is signed again", async () => {
    const { requests, transport } = scripted([{ status: 503 }, ok]);
    let t = Date.parse("2026-10-20T12:00:00Z");
    const p = new BedrockProvider(
      {
        model: "anthropic.claude-opus-5-5",
        region: "us-east-1",
        baseUrl: "https://vpce-0abc.bedrock-runtime.us-east-1.vpce.amazonaws.com",
      },
      { env: awsEnv, transport, clock: testClock().clock, now: () => new Date((t += 1000)) },
    );
    await p.complete(input);
    expect(requests).toHaveLength(2);
    expect(
      requests[0]!.url.startsWith(
        "https://vpce-0abc.bedrock-runtime.us-east-1.vpce.amazonaws.com/model/",
      ),
    ).toBe(true);
    expect(requests[0]!.headers["x-amz-date"]).not.toBe(requests[1]!.headers["x-amz-date"]);
  });

  it("403 says what to check for AWS", async () => {
    const p = new BedrockProvider(
      { model: "anthropic.claude-opus-5-5", region: "us-east-1" },
      {
        env: awsEnv,
        transport: scripted([{ status: 403, json: { message: "not authorized" } }]).transport,
      },
    );
    await expect(p.complete(input)).rejects.toThrow(
      /AWS Bedrock at bedrock-runtime.us-east-1.amazonaws.com refused the credentials \(HTTP 403\). Check AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_SESSION_TOKEN/,
    );
  });
});

describe("retries", () => {
  const make = (replies: Reply[], maxRetries?: number) => {
    const s = scripted(replies);
    const c = testClock();
    const p = new AnthropicProvider(
      {
        model: "claude-opus-5-5",
        keyEnv: "ATTICUS_MODEL_KEY",
        ...(maxRetries === undefined ? {} : { maxRetries }),
      },
      { env, transport: s.transport, clock: c.clock },
    );
    return { p, ...s, ...c };
  };

  it("retries 429 and 5xx with backoff, then succeeds", async () => {
    const { p, requests, slept } = make([
      { status: 429 },
      { status: 529 },
      { status: 502 },
      anthropicOk,
    ]);
    await p.complete(input);
    expect(requests).toHaveLength(4);
    // equal jitter with random 0.5: 3/4 of 1 s, 2 s, 4 s
    expect(slept).toEqual([750, 1500, 3000]);
  });

  it("honours Retry-After in seconds, as a date, and Azure's retry-after-ms", async () => {
    const { p, slept } = make([
      { status: 429, headers: new Headers({ "retry-after": "7" }) },
      { status: 429, headers: new Headers({ "retry-after": "Tue, 20 Oct 2026 12:00:03 GMT" }) },
      { status: 503, headers: new Headers({ "retry-after-ms": "250" }) },
      anthropicOk,
    ]);
    await p.complete(input);
    expect(slept).toEqual([7000, 3000, 250]);
  });

  it("is bounded: maxRetries, then a plain message", async () => {
    const { p, requests } = make([{ status: 429 }], 2);
    await expect(p.complete(input)).rejects.toThrow(
      "Anthropic at api.anthropic.com kept asking Atticus to slow down (HTTP 429) after 3 tries. Wait a few minutes and run it again, or ask for a higher rate limit.",
    );
    expect(requests).toHaveLength(3);
    const five = make([{ status: 500 }], 0);
    await expect(five.p.complete(input)).rejects.toThrow(/failed with HTTP 500 after 1 try/);
  });

  it("won't wait longer than a minute on Retry-After", async () => {
    const { p, requests, slept } = make([
      { status: 429, headers: new Headers({ "retry-after": "3600" }) },
    ]);
    await expect(p.complete(input)).rejects.toThrow(/asked Atticus to wait 3600 seconds/);
    expect(requests).toHaveLength(1);
    expect(slept).toEqual([]);
  });

  it("never retries 400, 401 or 404", async () => {
    for (const status of [400, 401, 404]) {
      const { p, requests } = make([{ status }]);
      await expect(p.complete(input)).rejects.toThrow(ModelProviderError);
      expect(requests).toHaveLength(1);
    }
  });

  it("retries a dropped connection, not a timeout", async () => {
    const reset = make([{ throws: new TransportError("ECONNRESET") }, anthropicOk]);
    await reset.p.complete(input);
    expect(reset.requests).toHaveLength(2);
    const slow = make([{ throws: new TransportError("timeout", { timedOut: true }) }]);
    await expect(slow.p.complete(input)).rejects.toThrow(
      "Anthropic at api.anthropic.com didn't answer within 300 seconds. Run it again, or raise adapters.model.settings.timeoutMs.",
    );
    expect(slow.requests).toHaveLength(1);
  });

  it("backoff is capped and Retry-After parses", () => {
    expect(backoffMs(10, DEFAULT_RETRY, () => 1)).toBe(30_000);
    const h = (o: Record<string, string>) => ({ status: 429, text: "", headers: new Headers(o) });
    expect(retryAfterMs(h({ "retry-after": "1.5" }), 0)).toBe(1500);
    expect(retryAfterMs(h({ "retry-after": "soon" }), 0)).toBeUndefined();
    expect(retryAfterMs(h({}), 0)).toBeUndefined();
  });

  it("stops when the caller aborts", async () => {
    const ac = new AbortController();
    const s = scripted([{ status: 503 }]);
    const p = new AnthropicProvider(
      { model: "m", keyEnv: "ATTICUS_MODEL_KEY" },
      {
        env,
        transport: s.transport,
        clock: {
          ...testClock().clock,
          sleep: async (_ms, signal) => {
            ac.abort(new Error("cancelled by the person"));
            if (signal?.aborted) throw signal.reason;
          },
        },
      },
    );
    await expect(p.complete({ ...input, signal: ac.signal })).rejects.toThrow(
      "cancelled by the person",
    );
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]!.signal).toBe(ac.signal);
  });
});

describe("plain-words errors", () => {
  const fail = async (reply: Reply, o: { azure?: boolean } = {}) => {
    const { transport } = scripted([reply]);
    const p = o.azure
      ? new OpenAiCompatibleProvider(
          {
            baseUrl: "https://tidewater-ai.openai.azure.com",
            deployment: "atticus-gpt",
            apiVersion: "2024-10-21",
            keyEnv: "ATTICUS_MODEL_KEY",
            maxRetries: 0,
          },
          { env, transport, flavour: "azure" },
        )
      : new AnthropicProvider(
          { model: "claude-opus-5-5", keyEnv: "ATTICUS_MODEL_KEY", maxRetries: 0 },
          { env, transport },
        );
    try {
      await p.complete(input);
    } catch (e) {
      return (e as Error).message;
    }
    throw new Error("expected a failure");
  };

  it("401 says check the key variable", async () => {
    expect(await fail({ status: 401, json: { error: { message: "invalid x-api-key" } } })).toBe(
      "Anthropic at api.anthropic.com refused the credentials (HTTP 401). Check that the environment variable ATTICUS_MODEL_KEY holds a valid key for api.anthropic.com, and that it may use the model claude-opus-5-5.",
    );
  });

  it("404 says check the model or the deployment", async () => {
    expect(await fail({ status: 404 })).toBe(
      "Anthropic at api.anthropic.com has no model called claude-opus-5-5 (HTTP 404). Check adapters.model.settings.model and baseUrl in runtime.yaml.",
    );
    expect(await fail({ status: 404 }, { azure: true })).toBe(
      "Azure OpenAI at tidewater-ai.openai.azure.com has no deployment called atticus-gpt (HTTP 404). Check adapters.model.settings.deployment and baseUrl in runtime.yaml.",
    );
  });

  it("400 carries the provider's own words, short", async () => {
    expect(
      await fail({
        status: 400,
        json: {
          type: "error",
          error: { type: "invalid_request_error", message: "max_tokens: too large" },
        },
      }),
    ).toBe(
      "Anthropic at api.anthropic.com rejected the request (HTTP 400): max_tokens: too large. Check the model settings in runtime.yaml (maxOutput is a common cause).",
    );
  });

  it("HTML instead of JSON (a login page) says check baseUrl", async () => {
    expect(await fail({ status: 200, text: "<html>Sign in</html>" })).toMatch(
      /answered with something that isn't the expected JSON. Check baseUrl/,
    );
  });

  it("proxy refusals, an unreachable proxy, certificates and DNS each say so", async () => {
    expect(
      await fail({
        throws: new TransportError("UND_ERR_ABORTED", {
          proxy: "http://proxy.tidewater.example:8080",
          proxyStatus: 407,
        }),
      }),
    ).toBe(
      "The proxy http://proxy.tidewater.example:8080 refused to connect Atticus to api.anthropic.com (HTTP 407). Check HTTPS_PROXY, the proxy's credentials (HTTP 407 means it wants them) and that it allows api.anthropic.com; or add api.anthropic.com to NO_PROXY.",
    );
    expect(
      await fail({
        throws: new TransportError("ECONNREFUSED", {
          proxy: "http://proxy.tidewater.example:8080",
        }),
      }),
    ).toMatch(/couldn't reach the proxy http:\/\/proxy.tidewater.example:8080 \(ECONNREFUSED\)/);
    expect(
      await fail({
        throws: new TransportError("SELF_SIGNED_CERT_IN_CHAIN", { proxy: "http://p.example:1" }),
      }),
    ).toMatch(
      /doesn't trust the certificate api.anthropic.com presented \(SELF_SIGNED_CERT_IN_CHAIN\).*NODE_EXTRA_CA_CERTS/,
    );
    expect(await fail({ throws: new TransportError("ENOTFOUND") })).toMatch(
      /couldn't reach api.anthropic.com \(ENOTFOUND\).*HTTPS_PROXY/,
    );
  });
});

describe("the key never shows", () => {
  it("not in messages, even when the provider echoes it back", async () => {
    for (const status of [400, 401, 418]) {
      const { transport } = scripted([
        { status, json: { error: { message: `bad key ${KEY} for org` } } },
      ]);
      const p = new AnthropicProvider(
        { model: "m", keyEnv: "ATTICUS_MODEL_KEY", maxRetries: 0 },
        { env, transport },
      );
      const err = await p.complete(input).catch((e: Error) => e);
      expect(err).toBeInstanceOf(ModelProviderError);
      expect((err as Error).message).not.toContain(KEY);
      expect(inspect(err)).not.toContain(KEY);
      expect(JSON.stringify(err)).not.toContain(KEY);
    }
  });

  it("not in the provider object when inspected, logged or serialised", () => {
    const p = new AnthropicProvider(
      { model: "m", keyEnv: "ATTICUS_MODEL_KEY" },
      { env, transport: scripted([]).transport },
    );
    expect(inspect(p, { depth: 5 })).not.toContain(KEY);
    expect(JSON.stringify(p)).not.toContain(KEY);
    const o = new OpenAiCompatibleProvider(
      { model: "m", baseUrl: "https://gw.example/v1", keyEnv: "ATTICUS_MODEL_KEY" },
      { env, transport: scripted([]).transport },
    );
    expect(inspect(o, { depth: 5 })).not.toContain(KEY);
  });

  it("AWS secrets are masked in Bedrock messages too", async () => {
    const secret = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
    const p = new BedrockProvider(
      { model: "m", region: "us-east-1", maxRetries: 0 },
      {
        env: { AWS_ACCESS_KEY_ID: "AKIDEXAMPLE", AWS_SECRET_ACCESS_KEY: secret },
        transport: scripted([
          { status: 400, json: { message: `signature for ${secret} AKIDEXAMPLE` } },
        ]).transport,
      },
    );
    const msg = await p.complete(input).catch((e: Error) => e.message);
    expect(msg).not.toContain(secret);
    expect(msg).not.toContain("AKIDEXAMPLE");
  });
});
