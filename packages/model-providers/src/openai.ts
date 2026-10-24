import type { ChatInput, ChatTurn } from "@maycombhq/ai";
import {
  BaseProvider,
  COMMON_SETTINGS,
  num,
  toolInput,
  type CompleteInput,
  type ProviderDeps,
} from "./common.js";
import type { Where } from "./messages.js";
import { readKey, SettingsReader, type RawSettings } from "./settings.js";

/** The text of a Chat Completions message: a string, or its text parts. */
const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((p: { type?: string; text?: string }) => (p.type === "text" ? (p.text ?? "") : ""))
          .join("")
      : "";

/** Why a choice was declined, when it was. */
const declinedOf = (
  choice: { message?: { refusal?: unknown }; finish_reason?: string } | undefined,
): string | undefined =>
  choice?.finish_reason === "content_filter"
    ? "content filter"
    : typeof choice?.message?.refusal === "string" && choice.message.refusal
      ? "refusal"
      : undefined;

export const OPENAI_SETTINGS = [
  ...COMMON_SETTINGS,
  "flavour",
  "baseUrl",
  "keyEnv",
  "auth",
  "deployment",
  "apiVersion",
  "outputLimitField",
] as const;

export type OpenAiFlavour = "openai" | "azure";

/**
 * Chat Completions, the shape most model endpoints speak.
 *
 * - `flavour: openai` (the default): `POST {baseUrl}/chat/completions` with
 *   `Authorization: Bearer <key>`. For internal LLM gateways, vLLM, and other servers that
 *   speak the OpenAI shape. `keyEnv` is optional here: a gateway on the inside may take none.
 * - `flavour: azure` (and runtime.yaml `type: azure-openai`): Azure OpenAI's deployment URL,
 *   `POST {baseUrl}/openai/deployments/{deployment}/chat/completions?api-version={apiVersion}`
 *   with the `api-key` header (or `auth: bearer` for a Microsoft Entra ID token in the variable).
 */
export class OpenAiCompatibleProvider extends BaseProvider {
  readonly model: string;
  readonly #key: string | undefined;
  readonly flavour: OpenAiFlavour;
  private readonly base: URL;
  private readonly keyEnv: string | undefined;
  private readonly deployment: string | undefined;
  private readonly apiVersion: string | undefined;
  private readonly auth: "api-key" | "bearer";
  private readonly maxField: "max_tokens" | "max_completion_tokens";

  constructor(settings: RawSettings, deps: ProviderDeps & { flavour?: OpenAiFlavour } = {}) {
    const forced = deps.flavour;
    const name = forced === "azure" ? "azure-openai" : "openai-compatible";
    const s = new SettingsReader(name, settings, OPENAI_SETTINGS);
    super(s, deps);
    this.flavour = forced ?? s.oneOf("flavour", ["openai", "azure"] as const, "openai");
    const azure = this.flavour === "azure";
    this.base = s.url("baseUrl", {
      example: azure ? "https://tidewater-ai.openai.azure.com" : "https://llm-gateway.example/v1",
    });
    this.deployment = azure
      ? s.str("deployment", { required: true, example: "atticus-gpt" })
      : s.str("deployment");
    this.apiVersion = azure
      ? s.str("apiVersion", { required: true, example: "2024-10-21" })
      : s.str("apiVersion");
    this.model =
      s.str("model") ??
      (azure ? this.deployment! : s.str("model", { required: true, example: "tidewater-llm-70b" }));
    this.keyEnv = s.keyEnv({ required: azure });
    this.auth = s.oneOf("auth", ["api-key", "bearer"] as const, azure ? "api-key" : "bearer");
    this.maxField = s.oneOf(
      "outputLimitField",
      ["max_tokens", "max_completion_tokens"] as const,
      "max_tokens",
    );
    this.#key = this.keyEnv ? readKey(name, this.keyEnv, this.env) : undefined;
  }

  get url(): string {
    const base = this.base.href.replace(/\/+$/, "").replace(/\?.*$/, "");
    if (this.flavour === "azure")
      return `${base}/openai/deployments/${encodeURIComponent(this.deployment!)}/chat/completions?api-version=${encodeURIComponent(this.apiVersion!)}`;
    return `${base}/chat/completions${this.apiVersion ? `?api-version=${encodeURIComponent(this.apiVersion)}` : ""}`;
  }

  protected where(): Where {
    return {
      provider: this.flavour === "azure" ? "Azure OpenAI" : "The OpenAI-compatible endpoint",
      host: this.base.host,
      model: this.flavour === "azure" ? this.deployment! : this.model,
      ...(this.keyEnv ? { keyEnv: this.keyEnv } : {}),
      ...(this.flavour === "azure" ? { modelSetting: "deployment" } : {}),
    };
  }

  protected secrets(): string[] {
    return this.#key ? [this.#key] : [];
  }

  private headers(): Record<string, string> {
    const auth: Record<string, string> = !this.#key
      ? {}
      : this.auth === "api-key"
        ? { "api-key": this.#key }
        : { authorization: `Bearer ${this.#key}` };
    return { "content-type": "application/json", accept: "application/json", ...auth };
  }

  /**
   * A conversation with tools (ADR 0107 addendum): Chat Completions' `tools` (functions),
   * `tool_calls` in the answer and `tool` messages back; the last request has tool_choice none.
   */
  async chat(input: ChatInput): Promise<ChatTurn> {
    const max = this.tokensFor(input);
    const azure = this.flavour === "azure";
    const messages: unknown[] = [{ role: "system", content: input.system }];
    for (const m of input.messages) {
      if (m.role === "user") messages.push({ role: "user", content: m.text });
      else if (m.role === "assistant")
        messages.push({
          role: "assistant",
          content: m.text || null,
          tool_calls: m.calls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.input) },
          })),
        });
      else
        for (const r of m.results)
          messages.push({ role: "tool", tool_call_id: r.id, content: r.text });
    }
    const res = (await this.post({
      url: this.url,
      headers: this.headers(),
      body: {
        ...(azure ? {} : { model: this.model }),
        messages,
        tools: input.tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.inputSchema },
        })),
        tool_choice: input.final ? "none" : "auto",
        [this.maxField]: max,
        stream: false,
      },
      ...(input.signal ? { signal: input.signal } : {}),
    })) as {
      choices?: {
        message?: {
          content?: unknown;
          refusal?: unknown;
          tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[];
        };
        finish_reason?: string;
      }[];
      usage?: Record<string, unknown>;
    };
    const choice = res.choices?.[0];
    const calls = (choice?.message?.tool_calls ?? [])
      .filter((c) => typeof c.function?.name === "string")
      .map((c, i) => ({
        id: c.id ?? `call-${i + 1}`,
        name: c.function!.name!,
        input: toolInput(c.function!.arguments),
      }));
    const u = res.usage ?? {};
    return this.finishTurn(
      textOf(choice?.message?.content),
      calls,
      {
        cutOff: choice?.finish_reason === "length",
        ...(declinedOf(choice) ? { declined: declinedOf(choice)! } : {}),
      },
      max,
      {
        ...(num(u.prompt_tokens) !== undefined ? { inputTokens: num(u.prompt_tokens)! } : {}),
        ...(num(u.completion_tokens) !== undefined
          ? { outputTokens: num(u.completion_tokens)! }
          : {}),
      },
      input,
    );
  }

  async complete(input: CompleteInput) {
    const max = this.tokensFor(input);
    const azure = this.flavour === "azure";
    const res = (await this.post({
      url: this.url,
      headers: this.headers(),
      body: {
        ...(azure ? {} : { model: this.model }),
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.prompt },
        ],
        [this.maxField]: max,
        stream: false,
      },
      ...(input.signal ? { signal: input.signal } : {}),
    })) as {
      choices?: { message?: { content?: unknown; refusal?: unknown }; finish_reason?: string }[];
      usage?: Record<string, unknown>;
    };
    const choice = res.choices?.[0];
    const text = textOf(choice?.message?.content);
    const declined = declinedOf(choice);
    const u = res.usage ?? {};
    return this.finish(
      text,
      { cutOff: choice?.finish_reason === "length", ...(declined ? { declined } : {}) },
      max,
      {
        ...(num(u.prompt_tokens) !== undefined ? { inputTokens: num(u.prompt_tokens)! } : {}),
        ...(num(u.completion_tokens) !== undefined
          ? { outputTokens: num(u.completion_tokens)! }
          : {}),
      },
      input,
    );
  }
}
