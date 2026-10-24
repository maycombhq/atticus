import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { changesDirOf, listQuestions } from "@maycombhq/core";
import { changeReport } from "@maycombhq/changes";
import { readChangeRepos } from "@maycombhq/workspace";
import { changeSteps, readNextState, type NextStep } from "./next-commands.js";

/**
 * The change cockpit (WP7.1): one page per change with what a person needs to follow it. Its
 * state and the next step with its slash command, what blocks it, each stage's progress (drafts,
 * critic rounds, open questions), the risk, and each repo's change branch and base (ADR 0123).
 * Composed from what `atticus change status`, `atticus next` and the stage files already say:
 * files only, nothing worked out again.
 */

export const STAGES = ["feature", "architecture", "stories"] as const;
export type StageName = (typeof STAGES)[number];

export interface StageProgress {
  stage: StageName;
  /** not-started when the stage has no loop file yet; else the loop's own state. */
  state: string;
  drafts: number;
  rounds: number;
  /** Questions it raised that nobody has answered yet. */
  openQuestions: number;
}

export interface Cockpit {
  id: string;
  state: string;
  next?: NextStep;
  nextStep: string;
  reasons: { code: string; message: string }[];
  risk: { level: string; score: number };
  stages: StageProgress[];
  openQuestions: number;
  repos: { id: string; branch: string; base: string; pr?: string }[];
}

async function stageProgress(dir: string, stage: StageName, open: Set<string>) {
  const text = await readFile(join(dir, "stage", `${stage}.yaml`), "utf8").catch(() => undefined);
  if (!text) return { stage, state: "not-started", drafts: 0, rounds: 0, openQuestions: 0 };
  const y = (parse(text) ?? {}) as {
    state?: unknown;
    iteration?: unknown;
    critic?: unknown;
    questions?: unknown;
  };
  const asked = Array.isArray(y.questions) ? y.questions.filter((q) => typeof q === "string") : [];
  return {
    stage,
    state: typeof y.state === "string" ? y.state : "unknown",
    drafts: typeof y.iteration === "number" ? y.iteration : 0,
    rounds: Array.isArray(y.critic) ? y.critic.length : 0,
    openQuestions: asked.filter((q) => open.has(q)).length,
  };
}

export async function cockpit(root: string, id: string): Promise<Cockpit> {
  const report = await changeReport(root, id);
  const dir = join(changesDirOf(root), id);
  const { questions } = await listQuestions(root, { state: "open" }).catch(() => ({
    questions: [],
  }));
  const open = new Set<string>(questions.filter((q) => q.repo === id).map((q) => q.id));
  const stages = [];
  for (const s of STAGES) stages.push(await stageProgress(dir, s, open));
  // This change's own next step, whatever else waits elsewhere in the metarepo.
  const state = (await readNextState(root)).changes.find((c) => c.id === id);
  const next = state ? changeSteps(state)[0] : undefined;
  const repos = await readChangeRepos(root, id).catch(() => undefined);
  return {
    id,
    state: report.state,
    ...(next ? { next } : {}),
    nextStep: report.nextStep,
    reasons: report.reasons,
    risk: { level: report.risk.level, score: report.risk.score },
    stages,
    openQuestions: open.size,
    repos: (repos?.repos ?? []).map((r) => ({
      id: r.id,
      branch: r.branch,
      base: r.base,
      ...(r.pr?.url ? { pr: r.pr.url } : {}),
    })),
  };
}
