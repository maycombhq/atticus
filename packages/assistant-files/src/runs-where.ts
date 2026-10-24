import type { Runtime } from "@maycombhq/core";
import { ASSISTANT_FORMATS } from "./assistants.js";

/**
 * One line for what runs a step here (ADR 0121 item 6), from runtime.yaml: the default mode
 * first, with its assistant or model, then the other modes allowed, then text only. Home, the
 * editors' Next view and `atticus next --json` show it.
 */
export function whatRunsWhere(rt: Runtime): string {
  if (rt.ai === "off") return "AI is off here: people write what agents would draft";
  const assistant = ASSISTANT_FORMATS[rt.assistants.default].name;
  const cfg = rt.adapters.model;
  const model = cfg
    ? [cfg.type, typeof cfg.settings.model === "string" ? cfg.settings.model : ""]
        .filter(Boolean)
        .join(" ")
    : undefined;
  const say = {
    "hand-off": { first: `Hand-off to ${assistant}`, also: `hand-off to ${assistant} allowed` },
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
