import type { AiRuntime } from "@maycombhq/ai";

/**
 * The eval harness's shapes. A **case** is one input to one agent with expectations; a
 * **run** feeds it through a runtime (mock, replay or live) and the agent's own parser, and
 * **graders** score the outcome: exact or structural comparison with hand-written ground
 * truth, rubric checks on the wording, and evidence bounds (every quote really in the file,
 * every cited id really in the input).
 */

export type EvalMode = "mock" | "replay" | "live";

export interface RunContext {
  mode: EvalMode;
  runtime: AiRuntime;
  now: Date;
  /** The Atticus checkout's root (fixtures/ and packages/ are under it). */
  repoRoot: string;
  /** A fresh temporary folder for this run. */
  tmp: () => Promise<string>;
}

export interface CaseOutcome {
  state: "ran" | "failed" | "waiting";
  /** What the runtime returned, when it returned something. */
  output?: string;
  promptSha256?: string;
  /** What the agent's parser kept, in a suite-specific shape the graders read. */
  kept: unknown[];
  /** What the parser threw away, with why. */
  discarded: { reason: string; [k: string]: unknown }[];
  /** Anything else a grader needs (counts, the story bar, quarantined sources). */
  extra?: Record<string, unknown>;
  error?: string;
}

export type GraderKind = "exact" | "structural" | "rubric" | "evidence";

export interface Grade {
  grader: string;
  kind: GraderKind;
  pass: boolean;
  /** 0..1: the share of the grader's items that passed. */
  score: number;
  notes: string[];
}

export interface EvalCase {
  id: string;
  agent: string;
  description: string;
  /** Where the case's inputs and ground truth come from (fixture paths). */
  source: string;
  /** Modes the case can run in (replay needs a recording; adversarial cases are mock only). */
  modes: EvalMode[];
  /** True when passing depends on a model's answer: the live bar (4 of 5 runs) applies. */
  aiGraded: boolean;
  tags: string[];
  /** The answer the mock runtime gives, by agent id. */
  reference?: Record<string, string>;
  /** Recordings for the replay runtime. */
  recordings?: string;
  run(ctx: RunContext): Promise<CaseOutcome>;
  grade(outcome: CaseOutcome, ctx: RunContext): Promise<Grade[]>;
}

export interface CaseResult {
  case: string;
  agent: string;
  run: number;
  mode: EvalMode;
  pass: boolean;
  state: CaseOutcome["state"];
  grades: Grade[];
  promptSha256?: string;
  discarded: number;
  error?: string;
  aiGraded: boolean;
}

export interface AgentSummary {
  agent: string;
  cases: number;
  /** Case runs that passed / all case runs. */
  passed: number;
  runs: number;
  passRate: number;
}

export interface EvalReport {
  schemaVersion: 1;
  runId: string;
  mode: EvalMode;
  startedAt: string;
  finishedAt: string;
  /** Runs per case. */
  runs: number;
  agents: AgentSummary[];
  results: CaseResult[];
  /** Cases left out: not runnable in this mode, or their fixtures are missing. */
  skipped: { case: string; agent: string; reason: string }[];
  liveBar?: LiveBar;
}

export interface LiveBar {
  runs: number;
  min: number;
  pass: boolean;
  cases: { case: string; agent: string; runs: number; passed: number; ok: boolean }[];
}
