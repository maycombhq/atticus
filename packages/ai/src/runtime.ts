import {
  currentSignal,
  RUN_SCHEMA_VERSION,
  type AgentDefinition,
  type RunState,
  type RunRetrieval,
  type RunSummary,
  type RunTools,
  type RuntimeKind,
} from "@maycombhq/core";
import { sha256, type ContextPack } from "./context.js";

/**
 * The runtime interface (contract C5): prepare → run → result. Implemented by the hand-off,
 * model, headless Claude Code, mock and recorded-replay runtimes. Every runtime refuses an
 * agent that doesn't allow it.
 */
export interface AiRequest {
  change: string;
  agent: AgentDefinition;
  pack: ContextPack;
  /** Change-folder-relative path the output is written to, e.g. "stories.md". */
  outputPath: string;
  /**
   * Where `outputPath` is relative to. "change" (the default) is the change folder; "run" is the
   * run's own folder (`.runs/<change>/<runId>/`), for a hand-off answer that a command reads back
   * and that must not land among the change's files (the story writer's prose would collide with
   * the `stories.md` the plan writes).
   */
  outputIn?: "change" | "run";
  /** How the pack's context was retrieved, when a model helped (ADR 0116): kept in the run record. */
  retrieval?: RunRetrieval;
  /**
   * A stage's draft checks itself before it is handed in (ADR 0087 addendum, W3a): the command
   * that runs the stage's checks on a file (the file's path goes after it), and how many checks a
   * draft may have before it is handed in as it is. The model runtime offers it as a tool.
   */
  selfCheck?: { command: string; limit: number };
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface Run {
  runId: string;
  request: AiRequest;
  runtime: RuntimeKind;
  state: RunState;
  attempt: number;
  startedAt: string;
  finishedAt?: string;
  output?: string;
  usage?: Usage;
  errors: string[];
  /** The tools the model was offered, every call it made and what it got back (ADR 0107). */
  tools?: RunTools;
}

export interface AiRuntime {
  readonly kind: RuntimeKind;
  prepare(request: AiRequest): Promise<Run>;
  /** Start or perform the run. Hand-off returns in "waiting"; the others finish. */
  run(runId: string, signal?: AbortSignal): Promise<Run>;
  result(runId: string): Promise<Run>;
}

/** Allowed hand-off transitions; anything else is a bug and throws. */
const NEXT: Record<RunState, RunState[]> = {
  prepared: ["waiting", "produced", "failed", "cancelled"],
  waiting: ["produced", "failed", "cancelled"],
  produced: ["validated", "failed"],
  validated: [],
  failed: ["prepared"],
  cancelled: [],
};

export function transition(run: Run, to: RunState, now: Date, patch: Partial<Run> = {}): Run {
  if (!NEXT[run.state].includes(to)) throw new Error(`a run can't go from ${run.state} to ${to}`);
  const done = to === "validated" || to === "failed" || to === "cancelled";
  return { ...run, ...patch, state: to, ...(done ? { finishedAt: now.toISOString() } : {}) };
}

export class RuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeError";
  }
}

export function checkAllowed(kind: RuntimeKind, agent: AgentDefinition): void {
  if (!agent.allowedRuntimes.includes(kind)) {
    throw new RuntimeError(
      `agent ${agent.id} may not run on the ${kind} runtime (allowed: ${agent.allowedRuntimes.join(", ")})`,
    );
  }
  if (agent.tokenBudget <= 0) throw new RuntimeError(`agent ${agent.id} has no token budget`);
}

/** Make a run id: deterministic when a counter is supplied (tests), unique otherwise. */
export function makeRunId(now: Date, seq?: number): string {
  const stamp = now
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
  const tail =
    seq !== undefined ? String(seq).padStart(4, "0") : Math.random().toString(36).slice(2, 8);
  return `run-${stamp}-${tail}`;
}

/** The summary that goes into review/; full packs and transcripts stay in .runs/. */
export function toRunSummary(run: Run): RunSummary {
  return {
    schemaVersion: RUN_SCHEMA_VERSION,
    runId: run.runId,
    change: run.request.change,
    agent: run.request.agent.id,
    runtime: run.runtime,
    state: run.state,
    startedAt: run.startedAt,
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    ...(run.state === "validated" || run.state === "produced"
      ? { output: run.request.outputPath }
      : {}),
    ...(run.usage ? { usage: run.usage } : {}),
    contextManifestSha256: sha256(JSON.stringify(run.request.pack.manifest)),
    errors: run.errors,
    attempt: run.attempt,
    ...(run.tools ? { tools: run.tools } : {}),
    ...(run.request.retrieval ? { retrieval: run.request.retrieval } : {}),
  };
}

/**
 * Shared base for runtimes that finish in one call (mock, replay, model): keeps runs in
 * memory, enforces the agent's allowed runtimes and token budget, and validates output.
 */
export abstract class OneShotRuntime implements AiRuntime {
  abstract readonly kind: RuntimeKind;
  protected runs = new Map<string, Run>();
  private seq = 0;

  constructor(
    protected readonly opts: {
      now?: () => Date;
      /** Check the output (e.g. openspec validate); returns problems, empty when fine. */
      validate?: (output: string, request: AiRequest) => Promise<string[]>;
    } = {},
  ) {}

  protected now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  protected abstract produce(
    run: Run,
    signal?: AbortSignal,
  ): Promise<{ output: string; usage: Usage; tools?: RunTools }>;

  /** Keep a finished run where Model runs reads it (the model runtime, given a root). */
  protected async keep(_run: Run): Promise<void> {}

  async prepare(request: AiRequest): Promise<Run> {
    checkAllowed(this.kind, request.agent);
    if (request.pack.manifest.totalTokens > request.agent.tokenBudget) {
      throw new RuntimeError(
        `context pack (${request.pack.manifest.totalTokens} tokens) is over agent ${request.agent.id}'s budget of ${request.agent.tokenBudget}`,
      );
    }
    const now = this.now();
    const run: Run = {
      runId: makeRunId(now, ++this.seq),
      request,
      runtime: this.kind,
      state: "prepared",
      attempt: 1,
      startedAt: now.toISOString(),
      errors: [],
    };
    this.runs.set(run.runId, run);
    return run;
  }

  async run(runId: string, given?: AbortSignal): Promise<Run> {
    // A run started inside a job the app can cancel stops with it (ADR 0119).
    const signal = given ?? currentSignal();
    let run = this.get(runId);
    if (signal?.aborted) {
      run = transition(run, "cancelled", this.now());
      this.runs.set(runId, run);
      return run;
    }
    try {
      const { output, usage, tools } = await this.produce(run, signal);
      run = transition(run, "produced", this.now(), { output, usage, ...(tools ? { tools } : {}) });
      const problems = (await this.opts.validate?.(output, run.request)) ?? [];
      run =
        problems.length === 0
          ? transition(run, "validated", this.now())
          : transition(run, "failed", this.now(), { errors: problems });
    } catch (e) {
      const tools = (e as { tools?: RunTools }).tools;
      run = transition(run, signal?.aborted ? "cancelled" : "failed", this.now(), {
        errors: [(e as Error).message],
        ...(tools ? { tools } : {}),
      });
    }
    this.runs.set(runId, run);
    await this.keep(run).catch(() => undefined);
    return run;
  }

  async result(runId: string): Promise<Run> {
    return this.get(runId);
  }

  protected get(runId: string): Run {
    const r = this.runs.get(runId);
    if (!r) throw new RuntimeError(`no run ${runId}`);
    return r;
  }
}
