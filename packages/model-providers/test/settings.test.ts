import { describe, expect, it } from "vitest";
import { RuntimeConfigError } from "@maycombhq/ai";
import {
  AnthropicProvider,
  BedrockProvider,
  ModelProviderConfigError,
  OpenAiCompatibleProvider,
  looksLikeKey,
  readKey,
} from "../src/index.js";

const fake = async () => ({ status: 200, headers: new Headers(), text: "{}" });
const env = { ATTICUS_MODEL_KEY: "test-key-not-real-0001" };

describe("looksLikeKey", () => {
  it("spots keys, tokens and signed URLs", () => {
    for (const v of [
      "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
      "sk-proj-abcdefghijklmnop1234",
      "AKIAIOSFODNN7EXAMPLE",
      "Bearer abcdefghijkl",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl",
      "0123456789abcdef0123456789abcdef",
      "Zx81kQpL0vR2mN7tY4wB9cD3fG6hJ5sA",
      "https://user:pass@gateway.example/v1",
      "https://gateway.example/v1?api-key=whatever",
      "https://gateway.example/v1?sig=whatever",
    ])
      expect(looksLikeKey(v), v).toBe(true);
  });

  it("leaves names, model ids, regions, versions, paths and addresses alone", () => {
    for (const v of [
      "ATTICUS_MODEL_KEY",
      "ATTICUS_TIDEWATER_GATEWAY_MODEL_KEY_2026",
      "claude-opus-5-5",
      "anthropic.claude-opus-5-5",
      "us.anthropic.claude-opus-5-5-v1:0",
      "Qwen2-72B-Instruct-AWQ-int4-gptq-v2-final",
      "tidewater-llm-70b",
      "us-east-1",
      "2024-10-21",
      "https://llm-gateway.tidewater.example/v1",
      "C:\\certs\\tidewater-root-ca.pem",
      "/etc/pki/tls/certs/forge-root.pem",
      "x-api-key",
    ])
      expect(looksLikeKey(v), v).toBe(false);
  });
});

describe("provider settings", () => {
  it("refuses a literal key in any setting, without echoing it", () => {
    const key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";
    const attempt = () =>
      new AnthropicProvider({ model: "claude-opus-5-5", keyEnv: key }, { env, transport: fake });
    expect(attempt).toThrow(ModelProviderConfigError);
    expect(attempt).toThrow(/looks like a key or token itself/);
    try {
      attempt();
    } catch (e) {
      expect((e as Error).message).not.toContain(key);
    }
    expect(
      () =>
        new OpenAiCompatibleProvider(
          {
            model: "m",
            baseUrl: "https://gw.example/v1",
            deployment: "0123456789abcdef0123456789abcdef",
          },
          { env, transport: fake },
        ),
    ).toThrow(/deployment .*looks like a key/);
  });

  it("refuses a keyEnv that isn't a variable name", () => {
    expect(
      () => new AnthropicProvider({ model: "m", keyEnv: "not a name" }, { env, transport: fake }),
    ).toThrow(/must be the name of an environment variable/);
  });

  it("says which variable is unset, and is a config error the CLI prints", () => {
    const attempt = () =>
      new AnthropicProvider(
        { model: "m", keyEnv: "ATTICUS_MISSING_KEY" },
        { env, transport: fake },
      );
    expect(attempt).toThrow(RuntimeConfigError);
    expect(attempt).toThrow(
      "The anthropic model provider reads its key from ATTICUS_MISSING_KEY, which is set neither in the environment nor in this machine's credential store. Keep it there with atticus secret set ATTICUS_MISSING_KEY (or the AI tab's \"Set the key on this machine\"), or set the environment variable; the key never goes in runtime.yaml.",
    );
    const none = { get: () => undefined };
    expect(() => readKey("x", "EMPTY", { EMPTY: "  " }, none)).toThrow(/set neither/);
  });

  it("refuses unknown settings, naming the ones it reads", () => {
    expect(
      () =>
        new AnthropicProvider(
          { model: "m", keyEnv: "ATTICUS_MODEL_KEY", temprature: "1" },
          { env, transport: fake },
        ),
    ).toThrow(
      /has temprature, which the anthropic model provider doesn't read. It reads: anthropicVersion, auth, baseUrl/,
    );
  });

  it("needs the model, and wrong types say what they should be", () => {
    expect(
      () => new AnthropicProvider({ keyEnv: "ATTICUS_MODEL_KEY" }, { env, transport: fake }),
    ).toThrow(
      "The anthropic model provider needs adapters.model.settings.model in runtime.yaml (for example model: claude-opus-5-5).",
    );
    expect(
      () =>
        new AnthropicProvider(
          { model: "m", keyEnv: "ATTICUS_MODEL_KEY", maxRetries: 50 },
          { env, transport: fake },
        ),
    ).toThrow(/maxRetries .*whole number from 0 to 6/);
    expect(
      () =>
        new AnthropicProvider(
          { model: "m", keyEnv: "ATTICUS_MODEL_KEY", auth: "cookie" },
          { env, transport: fake },
        ),
    ).toThrow(/auth .*one of x-api-key, bearer/);
  });

  it("calls https only; plain http only on this machine", () => {
    expect(
      () =>
        new OpenAiCompatibleProvider(
          { model: "m", baseUrl: "http://llm.tidewater.example/v1" },
          { env, transport: fake },
        ),
    ).toThrow(/only calls https:\/\/ addresses/);
    expect(
      new OpenAiCompatibleProvider(
        { model: "m", baseUrl: "http://127.0.0.1:8000/v1" },
        { env, transport: fake },
      ).url,
    ).toBe("http://127.0.0.1:8000/v1/chat/completions");
  });

  it("Azure needs a deployment, an API version and a key variable", () => {
    const azure = (s: Record<string, string>) => () =>
      new OpenAiCompatibleProvider(s, { env, transport: fake, flavour: "azure" });
    expect(azure({ baseUrl: "https://tidewater-ai.openai.azure.com" })).toThrow(/deployment/);
    expect(
      azure({ baseUrl: "https://tidewater-ai.openai.azure.com", deployment: "atticus-gpt" }),
    ).toThrow(/apiVersion/);
    expect(
      azure({
        baseUrl: "https://tidewater-ai.openai.azure.com",
        deployment: "atticus-gpt",
        apiVersion: "2024-10-21",
      }),
    ).toThrow(/keyEnv/);
  });

  it("Bedrock needs a region and the AWS variables, and names the missing ones", () => {
    expect(
      () =>
        new BedrockProvider({ model: "anthropic.claude-opus-5-5" }, { env: {}, transport: fake }),
    ).toThrow(/needs a region/);
    expect(
      () =>
        new BedrockProvider(
          { model: "anthropic.claude-opus-5-5", region: "us-east-1" },
          { env: { AWS_ACCESS_KEY_ID: "AKIDEXAMPLE" }, transport: fake },
        ),
    ).toThrow(/AWS_SECRET_ACCESS_KEY isn't set/);
    const p = new BedrockProvider(
      { model: "anthropic.claude-opus-5-5" },
      {
        env: { AWS_REGION: "us-west-2", AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b" },
        transport: fake,
      },
    );
    expect(p.url).toBe(
      "https://bedrock-runtime.us-west-2.amazonaws.com/model/anthropic.claude-opus-5-5/converse",
    );
    expect(
      () =>
        new BedrockProvider(
          { model: "m", region: "Mars" },
          { env: { AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b" }, transport: fake },
        ),
    ).toThrow(/AWS region/);
  });
});
