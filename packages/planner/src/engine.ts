import {
  estimateTokens,
  fitBudget,
  wrapData,
  type AiRuntime,
  type SourceInput,
} from "@maycombhq/ai";
import type { RunRetrieval, RunSummary } from "@maycombhq/core";
import {
  contextToolBox,
  openIndex,
  type ContextInput,
  type ContextSelection,
  type GraphNodeRow,
  type SelectOptions,
} from "@maycombhq/index";
import type { ContextGap } from "./gaps.js";
import { expandFor, expansionInput } from "./stages/expand.js";
import { fileJudgments, retrievalOf } from "@maycombhq/core";
import type { Judgments } from "./stages/judged.js";
import { rerankFor } from "./stages/rerank.js";

/**
 * The context engine in the steps (ADR 0107 point 3): a step that used to send a whole list
 * (every knowledge item, the whole estate, every pattern or process) asks the index for what
 * its input needs, fitted to the room its budget leaves. Behind an option: `engine: false`
 * sends the whole lists as before. What the engine left out goes in the step's result.
 */

export type ContextStep = "needs" | "feature" | "architecture" | "stories";

/**
 * Which steps use the engine when nothing says otherwise: the steps whose recall on the eval
 * (packages/evals, context-bench) is at least the whole list's (ADR 0107 point 6).
 */
export const ENGINE_DEFAULT: Record<ContextStep, boolean> = {
  needs: true,
  feature: true,
  architecture: true,
  stories: true,
};

export interface ContextOptions {
  /** Select with the context engine (true) or send the whole lists (false). Default: ENGINE_DEFAULT. */
  engine?: boolean;
  /** Tokens for the selected context (atticus ... --context-tokens n). Default: the room the step's budget leaves. */
  tokens?: number;
  /**
   * The model's expansion of the input before the selection (ADR 0116). Default: the org pack's
   * runtime.yaml retrieval.expansion (on unless it says off, ADR 0116's addendum).
   */
  expand?: boolean;
  /** The model's rerank of the candidates when they don't fit. Default: retrieval.rerank (off unless on). */
  rerank?: boolean;
}

/**
 * What a step's model call needs to also expand and rerank its retrieval (ADR 0116): its
 * runtime (a hand-off waits on each, one prompt per round), the run it was resumed with, its
 * clock, the classification levels, and the org pack's switches.
 */
export interface RetrievalAi {
  runtime: AiRuntime;
  resume?: string;
  now: Date;
  levels: readonly string[];
  /** runtime.yaml's retrieval switches (retrievalOf); left out, its defaults. */
  settings?: { expansion?: boolean; rerank?: boolean };
  store?: Judgments;
  /** The step's name for the packs, e.g. "change feature add-x". */
  step: string;
}

/**
 * The engine's selection with the model's help where it is on (ADR 0116): the expansion first
 * (its terms, ids and names join the input), then the selection, then, when what was found
 * doesn't fit, the rerank, and the selection again in the model's order. Either call may be a
 * hand-off the step waits on. Without AI, or with both off, it is the engine's selection.
 */
export async function retrieve(
  root: string,
  change: string,
  input: ContextInput,
  select: (
    input: ContextInput,
    order?: SelectOptions["order"],
  ) => Promise<{ selection?: ContextSelection; note?: string }>,
  context: ContextOptions | undefined,
  ai: RetrievalAi | undefined,
): Promise<
  | {
      selection?: ContextSelection;
      note?: string;
      retrieval: RunRetrieval;
      consumed: boolean;
      input: ContextInput;
    }
  | { waiting: { runId: string }; summary: RunSummary }
> {
  const retrieval: RunRetrieval = {};
  let consumed = false;
  let resume = ai?.resume;
  const store = ai?.store ?? fileJudgments(root);
  const notes: string[] = [];
  let used = input;
  const defaults = retrievalOf(undefined);
  if (ai && (context?.expand ?? ai.settings?.expansion ?? defaults.expansion)) {
    const e = await expandFor(root, change, input, {
      runtime: ai.runtime,
      ...(resume ? { resume } : {}),
      now: ai.now,
      store,
      levels: ai.levels,
      step: ai.step,
    });
    if ("waiting" in e) return { waiting: { runId: e.waiting.runId }, summary: e.summary };
    if (e.consumed) {
      consumed = true;
      resume = undefined;
    }
    if ("note" in e) notes.push(e.note);
    else {
      retrieval.expansion = e.record;
      used = { ...input, expansion: expansionInput(e.expansion) };
    }
  }
  let got = await select(used);
  if (
    ai &&
    got.selection &&
    got.selection.leftOut.length > 0 &&
    (context?.rerank ?? ai.settings?.rerank ?? defaults.rerank)
  ) {
    const r = await rerankFor(root, change, used, got.selection, {
      runtime: ai.runtime,
      ...(resume ? { resume } : {}),
      now: ai.now,
      store,
      levels: ai.levels,
      step: ai.step,
    });
    if ("waiting" in r) return { waiting: { runId: r.waiting.runId }, summary: r.summary };
    if (r.consumed) consumed = true;
    if ("note" in r) notes.push(r.note);
    else {
      retrieval.rerank = r.record;
      if (r.order.used) got = await select(used, { shown: r.order.shown, refs: r.order.refs });
    }
  }
  if (got.selection) retrieval.meaning = got.selection.meaning;
  return {
    ...got,
    ...(notes.length || got.note ? { note: [got.note, ...notes].filter(Boolean).join("; ") } : {}),
    retrieval,
    consumed,
    input: used,
  };
}

/** What a step's context was: for the step's result, so a person sees what was left out. */
export interface ContextReport {
  engine: boolean;
  /** Tokens the selection had. */
  budget?: number;
  /** Tokens it used. */
  tokens?: number;
  picked: { id: string; kind: string; level: "full" | "line"; score: number }[];
  /** What didn't fit, by score; why, when a model's rerank judged it not needed (ADR 0116). */
  leftOut: { id: string; kind: string; score: number; why?: string }[];
  /** Names the input uses that the index has nothing for. */
  unknown: string[];
  /** The unknown names as the step's gaps: where the change names them, and the question each became (ADR 0107 point 5). */
  gaps?: ContextGap[];
  /** Unknown names a repo's code names, with the line: not gaps (ADR 0116 addendum, ADR 0118). */
  inCode?: { name: string; at: string }[];
  /** The repos whose code was searched for the unknown names. */
  searched?: string[];
  version?: string;
  /** Whether similarity in meaning ranked too, or why not (ADR 0116). */
  meaning?: string;
  /** The model's expansion and rerank, when they helped (ADR 0116). */
  retrieval?: RunRetrieval;
  /** Why the engine wasn't used, when it was asked for and couldn't be. */
  note?: string;
}

export const wholeLists = (): ContextReport => ({
  engine: false,
  picked: [],
  leftOut: [],
  unknown: [],
});

/** The step's own instructions as the pack counts them (always kept, never wrapped). */
export const instructionSource = (text: string): SourceInput => ({
  id: "instructions",
  kind: "instruction",
  origin: "atticus",
  text,
  classification: "public",
  trusted: true,
});

export function useEngine(step: ContextStep, o?: ContextOptions): boolean {
  return o?.engine ?? ENGINE_DEFAULT[step];
}

/** Tokens a pack's sources take once wrapped, as buildContextPack counts them. */
export function sourceTokens(sources: SourceInput[]): number {
  return sources.reduce((n, s) => n + estimateTokens(s.trusted ? s.text : wrapData(s, s.text)), 0);
}

/**
 * The room for the selected context: the budget (fitted to the model's limit, ADR 0112) less
 * what else goes in the pack, less a reserve for what a later draft adds (the findings to fix,
 * the previous answer).
 */
export function roomFor(budget: number, others: SourceInput[], o?: ContextOptions): number {
  const b = fitBudget(budget);
  const room = Math.max(0, b - sourceTokens(others) - Math.min(4000, Math.floor(b / 10)));
  return o?.tokens !== undefined ? Math.min(o.tokens, room) : room;
}

/**
 * The context tools of a metarepo (ADR 0107 addendum) as a tool box for the model runtime:
 * search, show, walk and show_code, each call against the index and the workspace checkout.
 */
export const contextToolsFor = (root: string) => contextToolBox(root, () => openIndex(root));

/** Select a step's context from the index. Undefined (with why) when the index can't be read. */
export async function selectFor(
  root: string,
  input: ContextInput,
  o: SelectOptions,
): Promise<{ selection?: ContextSelection; note?: string }> {
  let ix;
  try {
    ix = await openIndex(root);
  } catch (e) {
    return {
      note: `the index couldn't be read (${(e as Error).message.split("\n")[0]}); sent the whole lists`,
    };
  }
  try {
    return { selection: await ix.select(input, o) };
  } finally {
    ix.close();
  }
}

export function reportOf(s: ContextSelection, budget: number): ContextReport {
  return {
    engine: true,
    budget,
    tokens: s.tokens,
    picked: s.picked.map((p) => ({ id: p.id, kind: p.kind, level: p.level, score: p.score })),
    leftOut: s.leftOut,
    unknown: s.unknown,
    version: s.version,
    meaning: s.meaning,
  };
}

/**
 * The selection as one source, the way a step sent its list before: a heading, the picked
 * records (full first, then one line each), and the ids left out for room.
 */
export function oneSource(
  s: ContextSelection,
  o: {
    id: string;
    origin: string;
    heading?: string;
    kind: SourceInput["kind"];
    priority: number;
    only?: (p: { kind: string }) => boolean;
    empty?: string;
  },
): SourceInput {
  const keep = (k: string) => !o.only || o.only({ kind: k });
  const parts: string[] = [];
  const full = new Map(s.sources.filter((x) => x.id !== "ctx-lines").map((x) => [x.id, x.text]));
  const lines = (s.sources.find((x) => x.id === "ctx-lines")?.text ?? "").split("\n").slice(1);
  let li = 0;
  let fi = 0;
  const fullTexts = [...full.values()];
  for (const p of s.picked) {
    if (p.level === "full") {
      const t = fullTexts[fi++];
      if (t !== undefined && keep(p.kind)) parts.push(t);
    } else {
      const t = lines[li++];
      if (t !== undefined && keep(p.kind)) parts.push(t);
    }
  }
  const left = s.leftOut.filter((l) => keep(l.kind)).map((l) => l.id);
  const text = [
    ...(o.heading ? [o.heading, ""] : []),
    ...(parts.length ? parts : [o.empty ?? "Nothing in the index matches."]),
    ...(left.length
      ? [
          "",
          `Also there, left out for room (name one by id if you need it): ${left.slice(0, 40).join(", ")}${left.length > 40 ? ` and ${left.length - 40} more` : ""}.`,
        ]
      : []),
  ].join("\n");
  return {
    id: o.id,
    kind: o.kind,
    origin: o.origin,
    text,
    classification: "internal",
    priority: o.priority,
  };
}

/** The selection's sources as SourceInputs, each with the index's priority under `base`. */
export function asSources(s: ContextSelection, kind: SourceInput["kind"]): SourceInput[] {
  return s.sources.map((x) => ({
    id: x.id,
    kind: x.id === "ctx-lines" ? "catalog" : kind,
    origin: x.origin,
    text: x.text,
    classification: x.classification,
    priority: x.priority,
  }));
}

export type { GraphNodeRow };
