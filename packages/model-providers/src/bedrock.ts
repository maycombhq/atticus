import type { ChatInput, ChatTurn } from "@maycombhq/ai";
import {
  BaseProvider,
  COMMON_SETTINGS,
  num,
  toolInput,
  type CompleteInput,
  type ProviderDeps,
} from "./common.js";
import { copy, type Where } from "./messages.js";
import { ModelProviderConfigError, SettingsReader, type RawSettings } from "./settings.js";
import { signV4, type AwsCredentials } from "./sigv4.js";

export const BEDROCK_SETTINGS = [...COMMON_SETTINGS, "region", "baseUrl"] as const;

/**
 * AWS Bedrock's Converse API (`POST /model/{modelId}/converse`), signed with SigV4. The
 * credentials are the standard AWS environment variables (AWS_ACCESS_KEY_ID,
 * AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN), read on each call so refreshed temporary
 * credentials are picked up. `baseUrl` points at a VPC (PrivateLink) endpoint when there is one.
 */
export class BedrockProvider extends BaseProvider {
  readonly model: string;
  readonly region: string;
  private readonly base: URL;
  private readonly now: () => Date;

  constructor(settings: RawSettings, deps: ProviderDeps = {}) {
    const s = new SettingsReader("bedrock", settings, BEDROCK_SETTINGS);
    super(s, deps);
    this.model = s.str("model", { required: true, example: "anthropic.claude-opus-5-5" });
    const region =
      s.str("region") ?? this.env.AWS_REGION?.trim() ?? this.env.AWS_DEFAULT_REGION?.trim();
    if (!region) throw new ModelProviderConfigError(copy.awsNoRegion());
    if (!/^[a-z]{2}(-[a-z]+)+-\d+$/.test(region))
      throw new ModelProviderConfigError(
        copy.badSetting("bedrock", "region", "must be an AWS region such as us-east-1"),
      );
    this.region = region;
    this.base = s.url("baseUrl", {
      fallback: `https://bedrock-runtime.${region}.amazonaws.com`,
      example: `https://bedrock-runtime.${region}.amazonaws.com`,
    });
    this.now = deps.now ?? (() => new Date());
    this.credentials(); // fail with the settings when the variables are missing
  }

  get url(): string {
    return `${this.base.href.replace(/\/+$/, "")}/model/${encodeURIComponent(this.model)}/converse`;
  }

  private credentials(): AwsCredentials {
    const id = this.env.AWS_ACCESS_KEY_ID?.trim();
    const secret = this.env.AWS_SECRET_ACCESS_KEY?.trim();
    const missing = [
      ...(id ? [] : ["AWS_ACCESS_KEY_ID"]),
      ...(secret ? [] : ["AWS_SECRET_ACCESS_KEY"]),
    ];
    if (missing.length) throw new ModelProviderConfigError(copy.awsUnset(missing));
    const token = this.env.AWS_SESSION_TOKEN?.trim();
    return {
      accessKeyId: id!,
      secretAccessKey: secret!,
      ...(token ? { sessionToken: token } : {}),
    };
  }

  protected where(): Where {
    return {
      provider: "AWS Bedrock",
      host: this.base.host,
      model: this.model,
      credentials:
        "Check AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_SESSION_TOKEN (temporary credentials expire), that the role may call bedrock:InvokeModel, and that model access is granted in this region",
    };
  }

  protected secrets(): string[] {
    const c = this.credentials();
    return [c.secretAccessKey, c.accessKeyId, ...(c.sessionToken ? [c.sessionToken] : [])];
  }

  /**
   * A conversation with tools (ADR 0107 addendum): Converse's `toolConfig`, `toolUse` blocks in
   * the answer and `toolResult` blocks back. Converse has no tool choice "none", so the last
   * request still names the tools (its history uses them) and says to answer without them.
   */
  async chat(input: ChatInput): Promise<ChatTurn> {
    const max = this.tokensFor(input);
    const messages = input.messages.map((m) =>
      m.role === "user"
        ? { role: "user", content: [{ text: m.text }] }
        : m.role === "assistant"
          ? {
              role: "assistant",
              content: [
                ...(m.text ? [{ text: m.text }] : []),
                ...m.calls.map((c) => ({
                  toolUse: { toolUseId: c.id, name: c.name, input: c.input },
                })),
              ],
            }
          : {
              role: "user",
              content: m.results.map((r) => ({
                toolResult: {
                  toolUseId: r.id,
                  content: [{ text: r.text }],
                  ...(r.error ? { status: "error" } : {}),
                },
              })),
            },
    );
    const body = JSON.stringify({
      system: [{ text: input.system }],
      messages,
      inferenceConfig: { maxTokens: max },
      toolConfig: {
        tools: input.tools.map((t) => ({
          toolSpec: {
            name: t.name,
            description: t.description,
            inputSchema: { json: t.inputSchema },
          },
        })),
      },
    });
    const res = (await this.signedPost(body, input.signal)) as {
      output?: {
        message?: {
          content?: {
            text?: unknown;
            toolUse?: { toolUseId?: string; name?: string; input?: unknown };
          }[];
        };
      };
      stopReason?: string;
      usage?: Record<string, unknown>;
    };
    const blocks = res.output?.message?.content ?? [];
    const text = blocks.map((b) => (typeof b.text === "string" ? b.text : "")).join("");
    const calls = blocks
      .filter((b) => typeof b.toolUse?.name === "string")
      .map((b, i) => ({
        id: b.toolUse!.toolUseId ?? `tool-${i + 1}`,
        name: b.toolUse!.name!,
        input: toolInput(b.toolUse!.input),
      }));
    return this.finishTurn(
      text,
      calls,
      this.stopOf(res.stopReason),
      max,
      this.usageOf(res.usage),
      input,
    );
  }

  private stopOf(stop: string | undefined) {
    return {
      cutOff: stop === "max_tokens",
      ...(stop === "guardrail_intervened" || stop === "content_filtered"
        ? { declined: stop.replace("_", " ") }
        : {}),
    };
  }

  private usageOf(u: Record<string, unknown> | undefined) {
    return {
      ...(num(u?.inputTokens) !== undefined ? { inputTokens: num(u?.inputTokens)! } : {}),
      ...(num(u?.outputTokens) !== undefined ? { outputTokens: num(u?.outputTokens)! } : {}),
    };
  }

  private signedPost(body: string, signal?: AbortSignal): Promise<unknown> {
    const url = new URL(this.url);
    return this.post({
      url: url.href,
      // Signed per try: a retry gets a fresh x-amz-date and the current credentials.
      headers: () =>
        signV4({
          method: "POST",
          url,
          headers: { "content-type": "application/json", accept: "application/json" },
          body,
          region: this.region,
          service: "bedrock",
          credentials: this.credentials(),
          date: this.now(),
        }),
      body,
      ...(signal ? { signal } : {}),
    });
  }

  async complete(input: CompleteInput) {
    const max = this.tokensFor(input);
    const body = JSON.stringify({
      system: [{ text: input.system }],
      messages: [{ role: "user", content: [{ text: input.prompt }] }],
      inferenceConfig: { maxTokens: max },
    });
    const res = (await this.signedPost(body, input.signal)) as {
      output?: { message?: { content?: { text?: unknown }[] } };
      stopReason?: string;
      usage?: Record<string, unknown>;
    };
    const text = (res.output?.message?.content ?? [])
      .map((b) => (typeof b.text === "string" ? b.text : ""))
      .join("");
    return this.finish(text, this.stopOf(res.stopReason), max, this.usageOf(res.usage), input);
  }
}
