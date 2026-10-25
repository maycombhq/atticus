import type { AssistantId, Runtime } from "@maycombhq/core";
import { ASSISTANT_FORMATS } from "./assistants.js";
import type { ProbeResult } from "./probe.js";

/**
 * The assistant `atticus probe` measured here (ADR 0124 addendum A-probe): the newest measurement
 * of one runtime.yaml allows. Undefined when none was measured; then the default runs a step.
 * `atticus next`, Home and Set up all say this one.
 */
export function probedAssistant(
  rt: Pick<Runtime, "assistants">,
  probes: readonly ProbeResult[] = [],
): AssistantId | undefined {
  return [...probes]
    .filter((p) => rt.assistants.allowed.includes(p.assistant))
    .sort((a, b) => b.measured.localeCompare(a.measured))[0]?.assistant;
}

const TIER_WORDS: Record<1 | 2 | 3, string> = {
  1: "agentic (tier 1)",
  2: "batched hand-off (tier 2)",
  3: "copy-paste (tier 3)",
};

/**
 * One line for what runs a step here (ADR 0121 item 6), from runtime.yaml: the default mode
 * first, with its assistant or model, then the other modes allowed, then text only. Home, the
 * editors' Next view and `atticus next --json` show it. With the probes on file here, the
 * assistant a step is handed to is the one `atticus probe` measured, with its tier (2026-10-25:
 * Home said Copilot, runtime.yaml's default, while the probe had measured Claude Code).
 */
export function whatRunsWhere(rt: Runtime, o: { probes?: readonly ProbeResult[] } = {}): string {
  if (rt.ai === "off") return "AI is off here: people write what agents would draft";
  const probedId = probedAssistant(rt, o.probes);
  const probe = probedId ? o.probes?.find((p) => p.assistant === probedId) : undefined;
  const assistant = ASSISTANT_FORMATS[probe?.assistant ?? rt.assistants.default].name;
  const measured = probe ? `, ${TIER_WORDS[probe.tier]} as atticus probe measured it` : "";
  const cfg = rt.adapters.model;
  const model = cfg
    ? [cfg.type, typeof cfg.settings.model === "string" ? cfg.settings.model : ""]
        .filter(Boolean)
        .join(" ")
    : undefined;
  const say = {
    "hand-off": {
      first: `Hand-off to ${assistant}${measured}`,
      also: `hand-off to ${assistant} allowed`,
    },
    model: {
      first: model
        ? `Model mode: ${model}`
        : "Model mode, but no model provider is set up (Set up › AI)",
      also: model ? `model mode allowed: ${model}` : undefined,
    },
    "headless-claude-code": {
      first: "Headless Claude Code",
      also: "headless Claude Code allowed",
    },
  } as const;
  const parts: string[] = [say[rt.modes.default].first];
  for (const m of rt.modes.allowed) {
    const also = m === rt.modes.default ? undefined : say[m].also;
    if (also) parts.push(also);
  }
  if (rt.ai === "text-only") parts.push("text only: no pictures sent");
  return parts.join(" · ");
}
