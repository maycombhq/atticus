import type { AssistantId, Runtime } from "@maycombhq/core";
import { ASSISTANT_FORMATS } from "./assistants.js";
import { PROBE_STALE_DAYS, type ProbeResult } from "./probe.js";

/**
 * The tier of ADR 0124 §4: at which tier this organisation's assistant reads a repo. Measured by
 * `atticus probe` where a person ran it (probe.ts, addendum A-probe), else read from what
 * runtime.yaml says (the assistants allowed, the default first, and the editors). Without a
 * measurement it claims only what the registry and runtime.yaml show:
 *
 * 1. Agentic: the assistant opens files and runs commands itself (Claude Code, Cursor, Gemini CLI,
 *    Windsurf, an AGENTS.md tool, Copilot in VS Code agent mode with the generated prompt files).
 *    `/atticus-map <repo>` reads a repo in one session.
 * 2. Chat with a token limit and no file tools (Copilot Chat through `vscode.lm`): hand-off
 *    batches that fit the limit. Atticus can't see from runtime.yaml whether an organisation
 *    turned Copilot's agent mode off, so without a probe this is said as Copilot's fallback.
 * 3. Copy-paste only (Copilot in IntelliJ, a web chat): the same batches, printed to paste.
 *
 * Each allowed assistant has its measured tier, else the one runtime.yaml implies; the lowest
 * tier is said, a measured one first at the same tier, then the default, then runtime.yaml's order.
 */

export type Tier = 1 | 2 | 3;

export interface TierReport {
  tier: Tier | "off";
  /** The assistant that reads at this tier. */
  assistant?: AssistantId;
  /** Where the tier comes from: measured by atticus probe, or read from runtime.yaml. */
  source: "probe" | "runtime.yaml";
  /** How it was measured, when it was. */
  measured?: {
    /** The day, YYYY-MM-DD. */
    at: string;
    days: number;
    /** Older than PROBE_STALE_DAYS: still used, said to be worth measuring again. */
    stale: boolean;
    answered: ProbeResult["answered"];
    read: boolean;
    write: boolean;
    run: boolean;
  };
  /** How the first read of a repo runs, in one or two sentences. */
  how: string;
  /** Where the tier can't be used: the next one down. */
  fallback?: string;
  /** What is missing for this tier to run well (a limit no one stated). */
  note?: string;
  /** Atticus reads the batches through the configured model itself (model mode). */
  model?: string;
  /** The model's limit: as stated when it was measured, else runtime.yaml's `maxInput`. */
  maxTokens?: number;
  maxTokensFrom?: "probe" | "runtime.yaml";
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

const DAY = 24 * 60 * 60 * 1000;

export interface TierOptions {
  /** The results `atticus probe` measured here (readProbes). */
  probes?: readonly ProbeResult[];
  now?: Date;
}

export function assistantTier(rt: RuntimeLike, o: TierOptions = {}): TierReport {
  const model = rt.adapters.model;
  const maxInput = model?.settings.maxInput;
  const modelLine =
    rt.modes.allowed.includes("model") && model && model.type !== "mock"
      ? {
          model: `Atticus can also read the batches through ${model.type} itself: atticus map <repo> --mode model.`,
        }
      : {};
  const fromRuntime =
    typeof maxInput === "number"
      ? { maxTokens: maxInput, maxTokensFrom: "runtime.yaml" as const }
      : {};
  if (rt.ai === "off")
    return {
      tier: "off",
      source: "runtime.yaml",
      how: "AI is off here (runtime.yaml): a person writes the map.",
    };
  const order = [
    rt.assistants.default,
    ...rt.assistants.allowed.filter((a) => a !== rt.assistants.default),
  ];
  const probes = new Map((o.probes ?? []).map((p) => [p.assistant, p]));
  const tierOf = (id: AssistantId): Tier => probes.get(id)?.tier ?? (agentic(rt, id) ? 1 : 3);
  let pick = order[0]!;
  for (const id of order.slice(1))
    if (
      tierOf(id) < tierOf(pick) ||
      (tierOf(id) === tierOf(pick) && probes.has(id) && !probes.has(pick))
    )
      pick = id;
  const m = probes.get(pick);
  if (m) return measuredTier(pick, m, { ...modelLine, ...fromRuntime }, o.now ?? new Date());

  const extra = { source: "runtime.yaml" as const, ...modelLine, ...fromRuntime };
  if (tierOf(pick) === 1 && pick === "copilot")
    return {
      tier: 1,
      assistant: pick,
      how: "Copilot in VS Code agent mode opens files and runs commands with the generated prompt files: /atticus-map <repo> reads a repo in one session, looping with atticus verify.",
      fallback:
        "Where Copilot's agent mode is off, Copilot Chat reads in batches that fit its model (tier 2): atticus map <repo> --handoff --max-tokens <its limit>, the way the Atticus extension runs a step.",
      ...extra,
    };
  if (tierOf(pick) === 1)
    return {
      tier: 1,
      assistant: pick,
      how: `${ASSISTANT_FORMATS[pick].name} opens files and runs commands itself: /atticus-map <repo> reads a repo in one session, looping with atticus verify.`,
      ...extra,
    };
  return {
    tier: 3,
    assistant: pick,
    how: "Copilot in IntelliJ has no Atticus prompt files to run: atticus map <repo> --copy prints each batch's prompt to paste into the chat, and reads the answer back.",
    ...extra,
  };
}

/** The tier a probe measured, and how the first read runs at it. */
function measuredTier(
  id: AssistantId,
  m: ProbeResult,
  extra: Pick<TierReport, "model" | "maxTokens" | "maxTokensFrom">,
  now: Date,
): TierReport {
  const name = ASSISTANT_FORMATS[id].name;
  const days = Math.max(0, Math.floor((now.getTime() - Date.parse(m.measured)) / DAY));
  const limit =
    m.maxTokens !== undefined
      ? { maxTokens: m.maxTokens, maxTokensFrom: "probe" as const }
      : extra.maxTokens !== undefined
        ? { maxTokens: extra.maxTokens, maxTokensFrom: extra.maxTokensFrom! }
        : {};
  const flag = ` --max-tokens ${limit.maxTokens ?? "<its limit>"}`;
  const how =
    m.tier === 1
      ? `${name} opened a file, wrote one and ran a command itself: /atticus-map <repo> reads a repo in one session, looping with atticus verify.`
      : m.tier === 2
        ? `${name} opened and wrote a file but didn't run a command: you run atticus map <repo> --handoff${flag}, it reads each batch's prompt file and writes the answer file, and atticus map <repo> --next takes the answer.`
        : `${name} ${m.read ? "opened a file but couldn't write one" : "couldn't open a file here"}: atticus map <repo> --copy${limit.maxTokens !== undefined ? flag : ""} prints each batch's prompt to paste into the chat, and reads the answer back.`;
  return {
    tier: m.tier,
    assistant: id,
    source: "probe",
    measured: {
      at: m.measured.slice(0, 10),
      days,
      stale: days > PROBE_STALE_DAYS,
      answered: m.answered,
      read: m.read,
      write: m.write,
      run: m.run,
    },
    how,
    ...(m.tier !== 1 && limit.maxTokens === undefined
      ? {
          note: "No model limit was stated: atticus probe --max-tokens <n> measures again with it, or give --max-tokens <n> on each atticus map.",
        }
      : {}),
    ...(extra.model ? { model: extra.model } : {}),
    ...limit,
  };
}

/** Where the tier comes from, in a few words: "measured on <day>" or "from runtime.yaml". */
export function tierSource(t: TierReport): string {
  return t.source === "probe" && t.measured ? `measured on ${t.measured.at}` : "from runtime.yaml";
}

/** The tier, where it comes from, how the first read runs, and where to see its cost. */
export function tierLine(t: TierReport): string {
  return [
    `${tierWords(t)}, ${tierSource(t)}: ${t.how}`,
    t.fallback,
    t.note,
    t.model,
    t.tier === "off"
      ? undefined
      : t.measured?.stale
        ? `That was ${t.measured.days} days ago: atticus probe measures it again.`
        : t.source === "runtime.yaml"
          ? "atticus probe measures it with your assistant."
          : undefined,
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
