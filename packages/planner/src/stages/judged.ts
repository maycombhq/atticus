import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import {
  AgentDefinition,
  judgmentKey,
  makeJudgment,
  RuntimeKind,
  stateDirOf,
  type JudgmentStore,
} from "@maycombhq/core";
import {
  buildContextPack,
  toRunSummary,
  type AiRuntime,
  type Run,
  type SourceInput,
} from "@maycombhq/ai";
import type { RunSummary } from "@maycombhq/core";

/**
 * A model's judgment on a step's retrieval (ADR 0116): the expansion of the input and the rerank
 * of its candidates. Each is one small model call, kept in the judgments store (ADR 0117,
 * judgments/<kind>/<key>.yaml, the key a hash of what was asked, of which index, by which
 * runtime), so the same commit, with the same stored answers, selects the same context (rule 4,
 * as answers are), and a person can override one. In hand-off mode the call is a hand-off of its
 * own, one prompt per round: the step waits on it, the runner answers it, and the step resumed
 * with that run reads it in and goes on.
 */

/** Where the judgments are kept: the judgments store (ADR 0117). */
export type Judgments = JudgmentStore;

/**
 * The hand-off a judgment is waiting on, by its key (ADR 0116 addendum): so a step run again
 * without --resume, as a runner that lost its place would, waits on the same prompt, or reads in
 * its answer, rather than handing a new one off. Local state, kept beside the index (disposable:
 * lost, the judgment is simply asked again).
 */
export interface PendingJudgments {
  get(kind: string, key: string): Promise<string | undefined>;
  set(kind: string, key: string, runId: string | undefined): Promise<void>;
}

export function filePending(root: string): PendingJudgments {
  const file = (kind: string, key: string) =>
    join(stateDirOf(root), ".index", "pending-judgments", kind, `${key}.txt`);
  return {
    get: async (kind, key) =>
      (await readFile(file(kind, key), "utf8").catch(() => undefined))?.trim() || undefined,
    set: async (kind, key, runId) => {
      const f = file(kind, key);
      if (runId === undefined) return void (await rm(f, { force: true }).catch(() => undefined));
      await mkdir(dirname(f), { recursive: true });
      await writeFile(f, `${runId}\n`);
    },
  };
}

export type Judged<T> =
  | { value: T; cached: boolean; run?: string; consumed: boolean; summary?: RunSummary }
  | { waiting: Run; summary: RunSummary }
  | { failed: string; consumed: boolean; summary?: RunSummary };

/** One judgment: from the store, from the run being resumed, or asked now. */
export async function judged<T>(o: {
  kind: string;
  /** What is judged, hashed into the key and kept for a person to read. */
  inputs: Record<string, unknown>;
  agent: string;
  description: string;
  change: string;
  budget: number;
  sources: SourceInput[];
  levels: readonly string[];
  runtime: AiRuntime;
  resume?: string;
  now: Date;
  store: Judgments;
  /** The hand-off each key waits on, so a rerun without --resume picks it up. */
  pending?: PendingJudgments;
  step: string;
  /** Words the answer rests on, for the stored judgment's quotes. */
  quotes?: (v: T) => { of: string; text: string }[];
  /** The answer as T, or why it can't be read. */
  read(text: string): T | { problem: string };
}): Promise<Judged<T>> {
  const key = judgmentKey(o.kind, o.inputs);
  const kept = await o.store.get(o.kind, key).catch(() => undefined);
  if (kept && kept.value !== undefined)
    return { value: kept.value as T, cached: true, consumed: false };
  const done = () => o.pending?.set(o.kind, key, undefined).catch(() => undefined);
  const finish = async (run: Run, consumed: boolean): Promise<Judged<T>> => {
    const summary = toRunSummary(run);
    if (run.state === "waiting" || run.state === "prepared") {
      await o.pending?.set(o.kind, key, run.runId).catch(() => undefined);
      return { waiting: run, summary };
    }
    await done();
    if (!run.output || (run.state !== "validated" && run.state !== "produced"))
      return {
        failed: run.errors.join("; ") || `the ${o.kind} run ended ${run.state}`,
        consumed,
        summary,
      };
    const v = o.read(run.output);
    if (v && typeof v === "object" && "problem" in (v as object))
      return { failed: (v as { problem: string }).problem, consumed, summary };
    await o.store.put(
      makeJudgment({
        kind: o.kind,
        inputs: o.inputs,
        verdict: "answered",
        value: v,
        quotes: o.quotes?.(v as T) ?? [],
        confirmedBy: { by: "ai", run: run.runId },
        at: o.now.toISOString(),
      }),
    );
    return { value: v as T, cached: false, run: run.runId, consumed, summary };
  };
  if (o.resume) {
    const run = await o.runtime.result(o.resume).catch(() => undefined);
    if (run && run.request.agent.id === o.agent) return finish(run, true);
  }
  // Run again without --resume: the hand-off this key waits on, if it is still there.
  const waitingOn = await o.pending?.get(o.kind, key).catch(() => undefined);
  if (waitingOn && waitingOn !== o.resume) {
    const run = await o.runtime.result(waitingOn).catch(() => undefined);
    if (run && run.request.agent.id === o.agent && run.state !== "cancelled") {
      if (run.state !== "failed" || run.output) return finish(run, false);
    }
    await done();
  }
  const agent = AgentDefinition.parse({
    schemaVersion: 1,
    id: o.agent,
    role: "architect",
    description: o.description,
    inputs: ["brief", "catalog-slice"],
    outputArtifact: "proposal",
    tokenBudget: o.budget,
    allowedRuntimes: [...RuntimeKind.options],
  });
  const pack = buildContextPack({
    change: o.change,
    agent: o.agent,
    budget: o.budget,
    sources: o.sources,
    levels: o.levels,
    maxClassification: o.levels.includes("internal") ? "internal" : o.levels.at(-1)!,
    now: o.now,
    step: o.step,
  });
  const prepared = await o.runtime.prepare({
    change: o.change,
    agent,
    pack,
    outputPath: `${o.kind}.yaml`,
    outputIn: "run",
  });
  return finish(await o.runtime.run(prepared.runId), false);
}

/** YAML out of a model's answer: the first fenced block, or the whole text. */
export function yamlOf(text: string): unknown {
  const fenced = /```(?:ya?ml)?\s*\n([\s\S]*?)```/.exec(text);
  try {
    return parse(fenced ? fenced[1]! : text);
  } catch {
    return undefined;
  }
}

export { stringify as yamlText };
