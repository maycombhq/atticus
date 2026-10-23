import {
  estimateTokens,
  type ChatInput,
  type ChatTurn,
  type ModelProvider,
  type ToolCallRequest,
} from "@maycombhq/ai";
import { DEFAULT_RETRY, postJson, realClock, type Clock, type RetryPolicy } from "./http.js";
import { copy, type Where } from "./messages.js";
import { undiciTransport, type Transport } from "./network.js";
import { ModelProviderError, SettingsReader, type Env } from "./settings.js";

/** What every built-in provider can be given besides its settings (tests inject all of it). */
export interface ProviderDeps {
  /** Where keys, AWS credentials, proxy and CA settings are read. Default: process.env. */
  env?: Env;
  /** The HTTP layer. Default: undici through the proxy and CA from env. */
  transport?: Transport;
  clock?: Clock;
  /** The clock for signing (Bedrock). Default: now. */
  now?: () => Date;
  /** Override the retry timing (tests); maxRetries still comes from the settings. */
  retry?: Partial<RetryPolicy>;
}

/** Settings every provider reads. */
export const COMMON_SETTINGS = ["model", "timeoutMs", "maxRetries", "maxOutput", "caFile"] as const;

export type CompleteInput = Parameters<ModelProvider["complete"]>[0];

/** The parts every provider shares: timeouts, retries, output cap, transport, messages. */
export abstract class BaseProvider implements ModelProvider {
  abstract readonly model: string;
  protected readonly timeoutMs: number;
  protected readonly maxOutputTokens: number;
  protected readonly retry: RetryPolicy;
  protected readonly clock: Clock;
  // Private (#) so inspecting or logging a provider never shows the environment it reads.
  readonly #env: Env;
  readonly #deps: ProviderDeps;
  #transport?: Transport;

  constructor(
    protected readonly s: SettingsReader,
    deps: ProviderDeps,
  ) {
    this.#deps = deps;
    this.#env = deps.env ?? process.env;
    this.timeoutMs = s.int("timeoutMs", { min: 1000, max: 3_600_000, fallback: 300_000 });
    this.maxOutputTokens = s.int("maxOutput", { min: 1, max: 1_000_000, fallback: 16_000 });
    this.retry = {
      ...DEFAULT_RETRY,
      ...deps.retry,
      maxRetries: s.int("maxRetries", { min: 0, max: 6, fallback: DEFAULT_RETRY.maxRetries }),
    };
    this.clock = deps.clock ?? realClock;
    // Built now, so a bad caFile fails with the settings, before any step runs.
    this.transport();
  }

  /** The injected transport, or undici through the proxy and CA the environment names. */
  protected transport(): Transport {
    if (this.#deps.transport) return this.#deps.transport;
    const caFile = this.s.str("caFile");
    this.#transport ??= undiciTransport({ env: this.#env, ...(caFile ? { caFile } : {}) });
    return this.#transport;
  }

  /** The environment keys and credentials come from. */
  protected get env(): Env {
    return this.#env;
  }

  protected abstract where(): Where;
  /** Secret values that must never reach a message. */
  protected abstract secrets(): string[];

  protected tokensFor(input: { maxOutputTokens: number }): number {
    return Math.max(1, Math.min(input.maxOutputTokens, this.maxOutputTokens));
  }

  protected post(o: {
    url: string;
    headers: Record<string, string> | (() => Record<string, string>);
    body: unknown;
    signal?: AbortSignal;
  }): Promise<unknown> {
    return postJson({
      where: this.where(),
      transport: this.transport(),
      url: o.url,
      headers: o.headers,
      body: typeof o.body === "string" ? o.body : JSON.stringify(o.body),
      timeoutMs: this.timeoutMs,
      retry: this.retry,
      clock: this.clock,
      secrets: this.secrets(),
      ...(o.signal ? { signal: o.signal } : {}),
    });
  }

  /** Turn the provider's stop reason into a refusal when the answer is incomplete or declined. */
  protected finish(
    text: string,
    stop: { cutOff: boolean; declined?: string },
    max: number,
    usage: { inputTokens?: number; outputTokens?: number },
    input: CompleteInput,
  ) {
    if (stop.cutOff) throw new ModelProviderError(copy.cutOff(this.where(), max));
    if (stop.declined) throw new ModelProviderError(copy.declined(this.where(), stop.declined));
    if (!text.trim()) throw new ModelProviderError(copy.noText(this.where()));
    return {
      text,
      usage: {
        inputTokens: usage.inputTokens ?? estimateTokens(input.system + input.prompt),
        outputTokens: usage.outputTokens ?? estimateTokens(text),
      },
    };
  }

  /** One turn of a conversation with tools: its calls, or its text; refused like `finish`. */
  protected finishTurn(
    text: string,
    calls: ToolCallRequest[],
    stop: { cutOff: boolean; declined?: string },
    max: number,
    usage: { inputTokens?: number; outputTokens?: number },
    input: ChatInput,
  ): ChatTurn {
    if (stop.cutOff) throw new ModelProviderError(copy.cutOff(this.where(), max));
    if (stop.declined) throw new ModelProviderError(copy.declined(this.where(), stop.declined));
    if (!calls.length && !text.trim()) throw new ModelProviderError(copy.noText(this.where()));
    const sent = input.messages
      .map((m) =>
        m.role === "tool" ? m.results.map((r) => r.text).join("") : "text" in m ? m.text : "",
      )
      .join("");
    return {
      text,
      calls,
      usage: {
        inputTokens: usage.inputTokens ?? estimateTokens(input.system + sent),
        outputTokens: usage.outputTokens ?? estimateTokens(text + JSON.stringify(calls)),
      },
    };
  }

  abstract complete(
    input: CompleteInput,
  ): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }>;
}

/** A tool call's input as the provider sent it: an object, or JSON text of one; else empty. */
export function toolInput(v: unknown): Record<string, unknown> {
  if (typeof v === "string") {
    try {
      return toolInput(JSON.parse(v));
    } catch {
      return {};
    }
  }
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

export const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
