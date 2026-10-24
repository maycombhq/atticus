import { registerModelProvider, type ModelProviderFactory } from "@maycombhq/ai";
import { ANTHROPIC_SETTINGS, AnthropicProvider } from "./anthropic.js";
import { BEDROCK_SETTINGS, BedrockProvider } from "./bedrock.js";
import type { ProviderDeps } from "./common.js";
import { OPENAI_SETTINGS, OpenAiCompatibleProvider } from "./openai.js";

export * from "./anthropic.js";
export * from "./bedrock.js";
export * from "./openai.js";
export { BaseProvider, COMMON_SETTINGS, type ProviderDeps } from "./common.js";
export {
  backoffMs,
  DEFAULT_RETRY,
  detailOf,
  mask,
  postJson,
  realClock,
  retryAfterMs,
  type Clock,
  type RetryPolicy,
} from "./http.js";
export { copy } from "./messages.js";
export * from "./network.js";
export * from "./settings.js";
export * from "./sigv4.js";

/**
 * The built-in model providers (ADR 0065), by runtime.yaml `adapters.model.type`:
 * `anthropic`, `openai-compatible`, `azure-openai` (openai-compatible with the Azure flavour)
 * and `bedrock`. `vertex` has no built-in provider yet.
 */
export function builtInModelProviders(
  deps: ProviderDeps = {},
): Record<string, ModelProviderFactory> {
  return {
    anthropic: (s) => new AnthropicProvider(s, deps),
    "openai-compatible": (s) => new OpenAiCompatibleProvider(s, deps),
    "azure-openai": (s) => new OpenAiCompatibleProvider(s, { ...deps, flavour: "azure" }),
    bedrock: (s) => new BedrockProvider(s, deps),
  };
}

/**
 * The settings each built-in provider accepts, by its type (ADR 0121): the app's AI tab shows one
 * field for each. A key is never one: `keyEnv` names the variable that holds it.
 */
export const PROVIDER_SETTINGS: Record<string, readonly string[]> = {
  anthropic: ANTHROPIC_SETTINGS,
  "openai-compatible": OPENAI_SETTINGS,
  "azure-openai": OPENAI_SETTINGS,
  bedrock: BEDROCK_SETTINGS,
};

/** Register the built-in providers with the runtime factory (the CLI does this when it starts). */
export function registerBuiltInModelProviders(deps: ProviderDeps = {}): void {
  for (const [type, make] of Object.entries(builtInModelProviders(deps)))
    registerModelProvider(type, make);
}
