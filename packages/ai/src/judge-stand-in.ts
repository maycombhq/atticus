import { stringify } from "yaml";
import type { RuntimeKind } from "@maycombhq/core";
import { MockRuntime } from "./runtimes.js";
import type { AiRequest } from "./runtime.js";

/**
 * A runtime that stands in for a model when the judge asks (ADR 0117), for tests and the evals
 * only: it reads the items of the judge's prompt and answers each with `answer`, as a recorded
 * verdict would. Its kind is "replay" by default, so steps treat it as a model they may call.
 * Never configured as a runtime: no step builds one from runtime.yaml.
 */

export interface StandInAnswer {
  verdict: string;
  quotes?: { of: string; text: string }[];
  why?: string;
}

export interface StandInItem {
  texts: Record<string, string>;
  facts: string[];
}

/** The items of a judge prompt, in order: their texts and facts. */
export function judgeItemsOf(prompt: string): StandInItem[] {
  const out: StandInItem[] = [];
  for (const m of prompt.matchAll(
    /^item (\d+):\n((?: {2}\w+: ".*"\n?)+)((?: {2}facts:\n(?: {4}- .*\n?)+)?)/gm,
  )) {
    const texts: Record<string, string> = {};
    for (const l of m[2]!.matchAll(/^ {2}(\w+): (".*")$/gm))
      texts[l[1]!] = JSON.parse(l[2]!) as string;
    const facts = [...(m[3] ?? "").matchAll(/^ {4}- (.*)$/gm)].map((f) => f[1]!);
    out[Number(m[1]) - 1] = { texts, facts };
  }
  return out;
}

class StandInRuntime extends MockRuntime {
  constructor(
    respond: (r: AiRequest) => string,
    override readonly kind: RuntimeKind,
    now?: () => Date,
  ) {
    super(respond, now ? { now } : {});
  }
}

/**
 * A stand-in judge: `answer` gives each item's verdict (undefined: unsure). `calls()` counts the
 * prompts it was sent, each a batch.
 */
export function judgeStandIn(
  answer: (item: StandInItem) => StandInAnswer | undefined,
  o: { kind?: RuntimeKind; now?: () => Date } = {},
): { runtime: MockRuntime; calls: () => number; prompts: string[] } {
  const prompts: string[] = [];
  const runtime = new StandInRuntime(
    (r) => {
      prompts.push(r.pack.prompt);
      const rows = judgeItemsOf(r.pack.prompt).map((it, i) => {
        const a = it ? answer(it) : undefined;
        return {
          item: i + 1,
          verdict: a?.verdict ?? "unsure",
          quotes: a?.quotes ?? [],
          ...(a?.why ? { why: a.why } : {}),
        };
      });
      return stringify({ judgments: rows });
    },
    o.kind ?? "replay",
    o.now,
  );
  return { runtime, calls: () => prompts.length, prompts };
}

/** A stand-in that answers from recorded verdicts, keyed by the item's texts as JSON. */
export function recordedJudge(
  byTexts: Map<string, StandInAnswer>,
  o: { kind?: RuntimeKind; now?: () => Date } = {},
) {
  return judgeStandIn((it) => byTexts.get(JSON.stringify(it.texts)), o);
}
