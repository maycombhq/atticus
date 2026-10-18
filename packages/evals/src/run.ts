import { rm } from "node:fs/promises";
import { MockRuntime, ReplayRuntime, RuntimeError, type AiRuntime } from "@maycombhq/ai";
import { readRecordings, tempDir } from "./fixtures.js";
import { allPass } from "./graders.js";
import { passesLiveBar, summarise } from "./report.js";
import type { CaseResult, EvalCase, EvalMode, EvalReport, RunContext } from "./types.js";

/**
 * Running cases. Mock mode answers with each case's reference answer (the hand-written answer
 * of its recording), so it tests the harness, the agent's parser and the graders; replay mode
 * answers only for the exact prompt a recording was made for, so it also proves the prompt
 * hasn't changed. Live mode uses the runtime the caller builds from runtime.yaml (a person runs
 * it with a configured provider; never in tests or CI). Each case runs `runs` times.
 */

export interface RunEvalsOptions {
  cases: readonly EvalCase[];
  mode: EvalMode;
  /** Runs per case. Default 1 (5 for live, for the 4-of-5 bar). */
  runs?: number;
  /** Live mode: the runtime for an agent (built by the caller from runtime.yaml). */
  liveRuntime?: (agent: string) => AiRuntime | Promise<AiRuntime>;
  repoRoot: string;
  now?: () => Date;
  /** Only these agents. */
  agents?: string[];
  /** Keep temporary folders (for debugging a case). */
  keep?: boolean;
  onResult?: (r: CaseResult) => void;
}

function runIdOf(now: Date, mode: EvalMode): string {
  return `eval-${now
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14)}-${mode}`;
}

export class EvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalError";
  }
}

async function runtimeFor(c: EvalCase, o: RunEvalsOptions, now: () => Date): Promise<AiRuntime> {
  if (o.mode === "mock") {
    const answers = c.reference ?? {};
    return new MockRuntime(
      (req) => {
        const a = answers[req.agent.id];
        if (a === undefined)
          throw new RuntimeError(`case ${c.id} has no mock answer for agent ${req.agent.id}`);
        return a;
      },
      { now },
    );
  }
  if (o.mode === "replay")
    return new ReplayRuntime(c.recordings ? readRecordings(c.recordings) : [], { now });
  if (!o.liveRuntime) throw new EvalError("Live mode needs a runtime built from runtime.yaml.");
  return o.liveRuntime(c.agent);
}

export async function runEvals(o: RunEvalsOptions): Promise<EvalReport> {
  const now = o.now ?? (() => new Date());
  const started = now();
  const runs = o.runs ?? (o.mode === "live" ? 5 : 1);
  const skipped: EvalReport["skipped"] = [];
  const results: CaseResult[] = [];
  const temps: string[] = [];
  for (const c of o.cases) {
    if (o.agents?.length && !o.agents.includes(c.agent)) continue;
    if (!c.modes.includes(o.mode)) {
      skipped.push({
        case: c.id,
        agent: c.agent,
        reason: `runs in ${c.modes.join(", ")} mode only`,
      });
      continue;
    }
    if (o.mode === "replay" && !c.recordings) {
      skipped.push({ case: c.id, agent: c.agent, reason: "it has no recordings" });
      continue;
    }
    for (let n = 1; n <= runs; n++) {
      const ctx: RunContext = {
        mode: o.mode,
        runtime: await runtimeFor(c, o, now),
        now: started,
        repoRoot: o.repoRoot,
        tmp: async () => {
          const d = await tempDir(c.id);
          temps.push(d);
          return d;
        },
      };
      const outcome = await c.run(ctx);
      const grades =
        outcome.state === "ran"
          ? await c.grade(outcome, ctx)
          : [
              {
                grader: "ran",
                kind: "structural" as const,
                pass: false,
                score: 0,
                notes: [outcome.error ?? outcome.state],
              },
            ];
      const r: CaseResult = {
        case: c.id,
        agent: c.agent,
        run: n,
        mode: o.mode,
        pass: outcome.state === "ran" && allPass(grades),
        state: outcome.state,
        grades,
        ...(outcome.promptSha256 ? { promptSha256: outcome.promptSha256 } : {}),
        discarded: outcome.discarded.length,
        ...(outcome.error ? { error: outcome.error } : {}),
        aiGraded: c.aiGraded,
      };
      results.push(r);
      o.onResult?.(r);
    }
  }
  if (!o.keep)
    for (const d of temps) await rm(d, { recursive: true, force: true }).catch(() => undefined);
  const finished = now();
  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  return {
    schemaVersion: 1,
    runId: runIdOf(started, o.mode),
    mode: o.mode,
    startedAt: iso(started),
    finishedAt: iso(finished),
    runs,
    agents: summarise(results),
    results,
    skipped,
    ...(o.mode === "live"
      ? { liveBar: passesLiveBar(results, { runs, min: Math.min(runs, 4) }) }
      : {}),
  };
}
