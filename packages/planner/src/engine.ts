import { estimateTokens, wrapData, type SourceInput } from "@maycombhq/ai";
import {
  contextToolBox,
  openIndex,
  type ContextInput,
  type ContextSelection,
  type GraphNodeRow,
  type SelectOptions,
} from "@maycombhq/index";
import type { ContextGap } from "./gaps.js";

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
}

/** What a step's context was: for the step's result, so a person sees what was left out. */
export interface ContextReport {
  engine: boolean;
  /** Tokens the selection had. */
  budget?: number;
  /** Tokens it used. */
  tokens?: number;
  picked: { id: string; kind: string; level: "full" | "line"; score: number }[];
  leftOut: { id: string; kind: string; score: number }[];
  /** Names the input uses that the index has nothing for. */
  unknown: string[];
  /** The unknown names as the step's gaps: where the change names them, and the question each became (ADR 0107 point 5). */
  gaps?: ContextGap[];
  version?: string;
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
 * The room for the selected context: the budget less what else goes in the pack, less a
 * reserve for what a later draft adds (the findings to fix, the previous answer).
 */
export function roomFor(budget: number, others: SourceInput[], o?: ContextOptions): number {
  const room = Math.max(0, budget - sourceTokens(others) - Math.min(4000, Math.floor(budget / 10)));
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
    return { selection: ix.selectContext(input, o) };
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
