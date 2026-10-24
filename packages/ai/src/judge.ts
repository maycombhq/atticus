import { parse } from "yaml";
import {
  AgentDefinition,
  judgmentKey,
  makeJudgment,
  quotedIn,
  type Judgment,
  type JudgmentStore,
  type RunSummary,
} from "@maycombhq/core";
import { buildContextPack, type SourceInput } from "./context.js";
import { toRunSummary, type AiRuntime, type Run } from "./runtime.js";

/**
 * The judge step (ADR 0117, C5): a closed question about meaning, asked of the model through
 * the AI runtime like any other step, and kept in the judgments store.
 *
 * - **Closed.** The answer is one word of the kind's verdicts, or "unsure"; never free prose.
 *   Unsure is not a guess: the caller turns it into a question to a person.
 * - **Quoted.** Every quote the judge gives is checked word for word against the text it names;
 *   an answer whose quote isn't there is asked once more, then counts as unsure.
 * - **Vetoed first.** The kind's veto (catalog facts: different ids or fields named, a field not
 *   in the task) runs before the model and overrides it; a vetoed item is never sent.
 * - **Kept.** Each verdict is stored under judgments/<kind>/<key>.yaml, the key a hash of the
 *   item's inputs, with the run that answered. The same inputs read the stored verdict and the
 *   model isn't called; a changed input asks again for its own item only.
 * - **Batched.** All the items of one call go in one prompt (up to `batch`), so a step pays one
 *   model call, not one per item.
 * - **Handed off like any step.** With the hand-off runtime the run waits for the person's
 *   assistant; call judge again with `resume` (the run id) once `atticus handoff done` checked it,
 *   and the verdicts are read in and stored.
 */

export const JUDGE_AGENT = "judge";

/** A kind of judgment: the closed question and its answers. */
export interface JudgeSpec {
  kind: string;
  /** The one closed question, in Atticus's words, asked of each item. */
  ask: string;
  /** The verdicts beside "unsure", e.g. same, narrower, different. */
  verdicts: readonly string[];
  /** What each verdict means, one line each, in the prompt. */
  means: Record<string, string>;
  /** Which texts a verdict other than unsure quotes: every text of the item, or any one. */
  quote: "each" | "one";
  /** A fact that settles an item before the model: the verdict and why, or undefined. */
  veto?: (item: JudgeItem) => { verdict: string; rule: string } | undefined;
}

export interface JudgeItem {
  /** What is judged, as hashed into the key; the same inputs read the same stored verdict. */
  inputs: Record<string, unknown>;
  /** The texts the judge reads and quotes, by name: data, never instructions. */
  texts: Record<string, string>;
  /** Facts from the catalog the judge reads beside the texts, e.g. the task's fields. */
  facts?: string[];
}

export interface Judged {
  key: string;
  /** One of the spec's verdicts, or "unsure". */
  verdict: string;
  /** The stored judgment, when the model answered (or one was on file). */
  judgment?: Judgment;
  /** Who settled it: the veto's rule, the store, or the run. */
  by: "veto" | "stored" | "model";
}

export interface JudgeOptions {
  runtime: AiRuntime;
  store: JudgmentStore;
  /** The change (or repo) the run is filed under in .runs/. */
  change: string;
  now?: Date;
  /** Finish a hand-off: the run id `atticus handoff done` checked. */
  resume?: string;
  /** Items per prompt. Default 25: short pairs fit a small model's room (ADR 0112). */
  batch?: number;
  budget?: number;
  levels?: readonly string[];
}

export interface JudgeResult {
  results: Map<string, Judged>;
  /** A hand-off run waiting for the person's assistant; its items have no result yet. */
  waiting?: { runId: string };
  runs: RunSummary[];
}

const agentDef = (budget: number) =>
  AgentDefinition.parse({
    schemaVersion: 1,
    id: JUDGE_AGENT,
    role: "architect",
    description:
      "Answers one closed question about meaning per item, quoting the words that decide it.",
    inputs: ["documents"],
    outputArtifact: "data",
    tokenBudget: budget,
    allowedRuntimes: ["hand-off", "model", "headless-claude-code", "mock", "replay"],
  });

/** The judge's instructions for a spec, in Atticus's words. */
export function judgeInstructions(spec: JudgeSpec): string {
  const answers = [...spec.verdicts, "unsure"];
  return [
    `For each item below, answer one question: ${spec.ask}`,
    "",
    "Answer with one of these words, nothing else:",
    ...spec.verdicts.map((v) => `- ${v}: ${spec.means[v] ?? ""}`),
    "- unsure: the texts don't settle it. Say unsure rather than guess; a person decides.",
    "",
    spec.quote === "each"
      ? "Unless you answer unsure, quote the words of each text that decide it, copied exactly."
      : "Unless you answer unsure, quote the words that decide it, copied exactly from one text.",
    "A quote that isn't word for word in the text it names is refused.",
    "",
    "Reply with YAML only:",
    "judgments:",
    "  - item: 1",
    `    verdict: ${answers.join(" | ")}`,
    "    quotes:",
    '      - { of: <the name of the text, e.g. "new">, text: "<the exact words>" }',
    "    why: <one sentence>",
  ].join("\n");
}

const itemsText = (items: JudgeItem[]) =>
  items
    .map((it, i) =>
      [
        `item ${i + 1}:`,
        ...Object.entries(it.texts).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`),
        ...(it.facts?.length ? ["  facts:", ...it.facts.map((f) => `    - ${f}`)] : []),
      ].join("\n"),
    )
    .join("\n");

interface Answer {
  item: number;
  verdict: string;
  quotes: { of: string; text: string }[];
  why?: string;
}

function readAnswers(text: string): Answer[] {
  let data: unknown;
  try {
    data = parse(text.replace(/^\s*```(?:ya?ml)?\s*\n/, "").replace(/\n```\s*$/, ""));
  } catch {
    return [];
  }
  const list = (data as { judgments?: unknown })?.judgments;
  if (!Array.isArray(list)) return [];
  const out: Answer[] = [];
  for (const raw of list) {
    const r = raw as Record<string, unknown>;
    const item = Number(r?.item);
    if (!Number.isInteger(item) || typeof r.verdict !== "string") continue;
    const quotes = Array.isArray(r.quotes)
      ? r.quotes
          .map((q) => q as Record<string, unknown>)
          .filter((q) => typeof q?.of === "string" && typeof q?.text === "string")
          .map((q) => ({ of: String(q.of), text: String(q.text) }))
      : [];
    out.push({
      item,
      verdict: r.verdict.trim().toLowerCase(),
      quotes,
      ...(typeof r.why === "string" && r.why.trim() ? { why: r.why.trim() } : {}),
    });
  }
  return out;
}

/** Why an answer can't be kept, or undefined when its verdict and quotes check out. */
export function answerProblem(
  spec: JudgeSpec,
  item: JudgeItem,
  a: Answer | undefined,
): string | undefined {
  if (!a) return "no answer for this item";
  if (a.verdict === "unsure") return undefined;
  if (!spec.verdicts.includes(a.verdict))
    return `"${a.verdict}" isn't one of ${[...spec.verdicts, "unsure"].join(", ")}`;
  for (const q of a.quotes) {
    const t = item.texts[q.of];
    if (t === undefined) return `a quote names ${q.of}, which isn't one of the item's texts`;
    if (!quotedIn(t, q.text)) return `"${q.text}" isn't word for word in ${q.of}`;
  }
  const quoted = new Set(a.quotes.map((q) => q.of));
  if (spec.quote === "each" && Object.keys(item.texts).some((k) => !quoted.has(k)))
    return "quote the words of each text that decide it";
  if (spec.quote === "one" && quoted.size === 0) return "quote the words that decide it";
  return undefined;
}

export async function judge(
  spec: JudgeSpec,
  items: JudgeItem[],
  o: JudgeOptions,
): Promise<JudgeResult> {
  const results = new Map<string, Judged>();
  const runs: RunSummary[] = [];
  const now = o.now ?? new Date();
  const at = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const open: { key: string; item: JudgeItem }[] = [];
  for (const item of items) {
    const key = judgmentKey(spec.kind, item.inputs);
    if (results.has(key) || open.some((x) => x.key === key)) continue;
    const v = spec.veto?.(item);
    if (v) {
      results.set(key, { key, verdict: v.verdict, by: "veto" });
      continue;
    }
    const stored = await o.store.get(spec.kind, key);
    if (stored && typeof stored.verdict === "string") {
      results.set(key, { key, verdict: stored.verdict, judgment: stored, by: "stored" });
      continue;
    }
    open.push({ key, item });
  }
  const budget = o.budget ?? 12_000;
  const levels = o.levels ?? ["public", "internal", "confidential", "restricted"];
  const size = Math.max(1, o.batch ?? 25);
  let resume = o.resume;

  const ask = async (batch: { key: string; item: JudgeItem }[], fix?: Map<number, string>) => {
    const sources: SourceInput[] = [
      {
        id: "instructions",
        kind: "instruction",
        origin: "atticus (ADR 0117)",
        text:
          judgeInstructions(spec) +
          (fix?.size
            ? `\n\nYour last answer for these items was refused; answer them again:\n${[...fix].map(([n, p]) => `- item ${n}: ${p}`).join("\n")}`
            : ""),
        classification: "public",
        trusted: true,
      },
      {
        id: "items",
        kind: "document",
        origin: `judge ${spec.kind}`,
        text: itemsText(batch.map((b) => b.item)),
        classification: levels.includes("internal") ? "internal" : levels[0]!,
        priority: 100,
      },
    ];
    const pack = buildContextPack({
      change: o.change,
      agent: JUDGE_AGENT,
      budget,
      sources,
      levels,
      maxClassification: levels.includes("internal") ? "internal" : levels[0]!,
      now,
      required: ["items"],
      step: `judge ${spec.kind}`,
    });
    let run: Run;
    if (resume) {
      run = await o.runtime.result(resume);
      resume = undefined;
    } else {
      const prepared = await o.runtime.prepare({
        change: o.change,
        agent: agentDef(budget),
        pack,
        outputPath: "judgments.yaml",
        outputIn: "run",
      });
      run = await o.runtime.run(prepared.runId);
    }
    runs.push(toRunSummary(run));
    return run;
  };

  for (let s = 0; s < open.length; s += size) {
    let batch = open.slice(s, s + size);
    let fix: Map<number, string> | undefined;
    for (let attempt = 1; attempt <= 2 && batch.length; attempt++) {
      const run = await ask(batch, fix);
      if (run.state === "waiting" || run.state === "prepared")
        return { results, waiting: { runId: run.runId }, runs };
      const answers = run.output ? readAnswers(run.output) : [];
      const again: typeof batch = [];
      fix = new Map();
      for (const [n, b] of batch.entries()) {
        const a = answers.find((x) => x.item === n + 1);
        const problem = run.state === "failed" ? "the run failed" : answerProblem(spec, b.item, a);
        if (problem && attempt === 1) {
          again.push(b);
          fix.set(again.length, problem);
          continue;
        }
        const verdict = problem ? "unsure" : a!.verdict;
        const j = await o.store.put(
          makeJudgment({
            kind: spec.kind,
            inputs: b.item.inputs,
            verdict,
            quotes: problem ? [] : a!.quotes,
            ...(problem ? { why: `Refused twice: ${problem}.` } : a!.why ? { why: a!.why } : {}),
            confirmedBy: { by: "ai", run: run.runId },
            at,
          }),
        );
        results.set(b.key, {
          key: b.key,
          verdict: typeof j.verdict === "string" ? j.verdict : verdict,
          judgment: j,
          by: "model",
        });
      }
      batch = again;
    }
  }
  return { results, runs };
}

/**
 * Whether a step may ask the judge on its own: the runtime calls a model directly. Not the
 * hand-off runtime (another round would cost the person a prompt; ADR 0117 §3) and not the
 * mock one (it answers nothing of its own).
 */
export const judgesDirectly = (runtime: AiRuntime | undefined): runtime is AiRuntime =>
  !!runtime && runtime.kind !== "hand-off" && runtime.kind !== "mock";

export interface SettleOptions extends Omit<JudgeOptions, "runtime"> {
  /** The step's runtime; the judge is asked only when it calls a model directly. */
  runtime?: AiRuntime | undefined;
}

/**
 * The verdicts a step can have without spending a person's prompt (ADR 0117): the veto, a
 * judgment on file, and the judge where the runtime calls a model directly. An item with no
 * verdict is open: the caller shows it to a person as unchecked or asks them, and never falls
 * back to a word rule as if it were a judgment.
 */
export async function settle(
  spec: JudgeSpec,
  items: JudgeItem[],
  o: SettleOptions,
): Promise<Map<string, Judged>> {
  if (judgesDirectly(o.runtime))
    return (await judge(spec, items, { ...o, runtime: o.runtime })).results;
  const out = new Map<string, Judged>();
  for (const item of items) {
    const key = judgmentKey(spec.kind, item.inputs);
    if (out.has(key)) continue;
    const v = spec.veto?.(item);
    if (v) {
      out.set(key, { key, verdict: v.verdict, by: "veto" });
      continue;
    }
    const stored = await o.store.get(spec.kind, key);
    if (stored && typeof stored.verdict === "string")
      out.set(key, { key, verdict: stored.verdict, judgment: stored, by: "stored" });
  }
  return out;
}

/** An item's verdict from settle's results, or undefined while it is open. */
export const verdictOf = (
  results: Map<string, Judged>,
  spec: JudgeSpec,
  inputs: Record<string, unknown>,
): Judged | undefined => results.get(judgmentKey(spec.kind, inputs));
