import {
  BaseProvider,
  COMMON_SETTINGS,
  num,
  type CompleteInput,
  type ProviderDeps,
} from "./common.js";
import type { Where } from "./messages.js";
import { readKey, SettingsReader, type RawSettings } from "./settings.js";

const SETTINGS = [...COMMON_SETTINGS, "baseUrl", "keyEnv", "auth", "anthropicVersion"] as const;

/**
 * Anthropic's Messages API (`POST {baseUrl}/v1/messages`), direct or through a gateway that
 * speaks it. The key comes from the environment variable named in `keyEnv`, sent as
 * `x-api-key` (or `Authorization: Bearer` with `auth: bearer`, for gateways that want that).
 */
export class AnthropicProvider extends BaseProvider {
  readonly model: string;
  readonly #key: string;
  private readonly base: URL;
  private readonly keyEnv: string;
  private readonly auth: "x-api-key" | "bearer";
  private readonly version: string;

  constructor(settings: RawSettings, deps: ProviderDeps = {}) {
    const s = new SettingsReader("anthropic", settings, SETTINGS);
    super(s, deps);
    this.model = s.str("model", { required: true, example: "claude-opus-5-5" });
    this.base = s.url("baseUrl", {
      fallback: "https://api.anthropic.com",
      example: "https://api.anthropic.com",
    });
    this.keyEnv = s.keyEnv({ required: true })!;
    this.auth = s.oneOf("auth", ["x-api-key", "bearer"] as const, "x-api-key");
    this.version = s.str("anthropicVersion") ?? "2023-06-01";
    this.#key = readKey("anthropic", this.keyEnv, this.env);
  }

  /** Where requests go (exported for tests and `atticus doctor`-style checks). */
  get url(): string {
    return `${this.base.href.replace(/\/+$/, "")}/v1/messages`;
  }

  protected where(): Where {
    return { provider: "Anthropic", host: this.base.host, model: this.model, keyEnv: this.keyEnv };
  }

  protected secrets(): string[] {
    return [this.#key];
  }

  async complete(input: CompleteInput) {
    const max = this.tokensFor(input);
    const res = (await this.post({
      url: this.url,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "anthropic-version": this.version,
        ...(this.auth === "bearer"
          ? { authorization: `Bearer ${this.#key}` }
          : { "x-api-key": this.#key }),
      },
      body: {
        model: this.model,
        max_tokens: max,
        system: input.system,
        messages: [{ role: "user", content: input.prompt }],
      },
      ...(input.signal ? { signal: input.signal } : {}),
    })) as {
      content?: { type?: string; text?: string }[];
      stop_reason?: string;
      usage?: Record<string, unknown>;
    };
    const text = (res.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("");
    const u = res.usage ?? {};
    const input_ =
      num(u.input_tokens) === undefined
        ? undefined
        : num(u.input_tokens)! +
          (num(u.cache_creation_input_tokens) ?? 0) +
          (num(u.cache_read_input_tokens) ?? 0);
    return this.finish(
      text,
      {
        cutOff: res.stop_reason === "max_tokens",
        ...(res.stop_reason === "refusal" ? { declined: "refusal" } : {}),
      },
      max,
      {
        ...(input_ !== undefined ? { inputTokens: input_ } : {}),
        ...(num(u.output_tokens) !== undefined ? { outputTokens: num(u.output_tokens)! } : {}),
      },
      input,
    );
  }
}
