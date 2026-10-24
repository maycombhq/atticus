import type { AssistantId, Runtime } from "@maycombhq/core";
import { ASSISTANT_FORMATS } from "./assistants.js";

/**
 * The capability probe of ADR 0124 §4: at which tier this organisation's assistant reads a repo,
 * from what runtime.yaml says (the assistants allowed, the default first, and the editors). It
 * claims only what the registry and runtime.yaml show:
 *
 * 1. Agentic: the assistant opens files and runs commands itself (Claude Code, Cursor, Gemini CLI,
 *    Windsurf, an AGENTS.md tool, Copilot in VS Code agent mode with the generated prompt files).
 *    `/atticus-map <repo>` reads a repo in one session.
 * 2. Chat with a token limit and no file tools (Copilot Chat through `vscode.lm`): hand-off
 *    batches that fit the limit. Atticus can't see from here whether an organisation turned
 *    Copilot's agent mode off, so this is said as Copilot's fallback, not chosen.
 * 3. Copy-paste only (Copilot in IntelliJ, a web chat): the same batches, printed to paste.
 */

export type Tier = 1 | 2 | 3;

export interface TierReport {
  tier: Tier | "off";
  /** The assistant that reads at this tier. */
  assistant?: AssistantId;
  /** How the first read of a repo runs, in one or two sentences. */
  how: string;
  /** Where the tier can't be used: the next one down. */
  fallback?: string;
  /** Atticus reads the batches through the configured model itself (model mode). */
  model?: string;
  /** The model's limit runtime.yaml gives (`adapters.model.settings.maxInput`). */
  maxTokens?: number;
}

/** Agent tools: they open files and run commands in every editor they run in. */
const AGENT_TOOLS: ReadonlySet<AssistantId> = new Set([
  "claude-code",
  "cursor",
  "gemini-cli",
  "windsurf",
  "agents-md",
]);

type RuntimeLike = Pick<Runtime, "ai" | "assistants" | "editors" | "modes" | "adapters">;

const agentic = (rt: RuntimeLike, id: AssistantId) =>
  AGENT_TOOLS.has(id) || (id === "copilot" && rt.editors.includes("vscode"));

export function assistantTier(rt: RuntimeLike): TierReport {
  const model = rt.adapters.model;
  const maxInput = model?.settings.maxInput;
  const extra = {
    ...(rt.modes.allowed.includes("model") && model && model.type !== "mock"
      ? {
          model: `Atticus can also read the batches through ${model.type} itself: atticus map <repo> --mode model.`,
        }
      : {}),
    ...(typeof maxInput === "number" ? { maxTokens: maxInput } : {}),
  };
  if (rt.ai === "off")
    return { tier: "off", how: "AI is off here (runtime.yaml): a person writes the map." };
  const order = [
    rt.assistants.default,
    ...rt.assistants.allowed.filter((a) => a !== rt.assistants.default),
  ];
  const pick = order.find((a) => agentic(rt, a));
  if (pick === "copilot")
    return {
      tier: 1,
      assistant: pick,
      how: "Copilot in VS Code agent mode opens files and runs commands with the generated prompt files: /atticus-map <repo> reads a repo in one session, looping with atticus verify.",
      fallback:
        "Where Copilot's agent mode is off, Copilot Chat reads in batches that fit its model (tier 2): atticus map <repo> --handoff --max-tokens <its limit>, the way the Atticus extension runs a step.",
      ...extra,
    };
  if (pick)
    return {
      tier: 1,
      assistant: pick,
      how: `${ASSISTANT_FORMATS[pick].name} opens files and runs commands itself: /atticus-map <repo> reads a repo in one session, looping with atticus verify.`,
      ...extra,
    };
  return {
    tier: 3,
    assistant: rt.assistants.default,
    how: "Copilot in IntelliJ has no Atticus prompt files to run: atticus map <repo> --copy prints each batch's prompt to paste into the chat, and reads the answer back.",
    ...extra,
  };
}

/** The tier, how the first read runs, the fallback and model mode, and where to see its cost. */
export function tierLine(t: TierReport): string {
  return [
    `${tierWords(t)}: ${t.how}`,
    t.fallback,
    t.model,
    t.tier === "off" ? undefined : "atticus map <repo> --estimate says what the first read costs.",
  ]
    .filter(Boolean)
    .join(" ");
}

/** The tier in a few words, for a line of doctor or init. */
export function tierWords(t: TierReport): string {
  return t.tier === "off"
    ? "AI is off"
    : t.tier === 1
      ? "agentic (tier 1)"
      : t.tier === 2
        ? "batched hand-off (tier 2)"
        : "copy-paste (tier 3)";
}
