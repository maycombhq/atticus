import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import {
  changesDirOf,
  listQuestions,
  nextOwnersOf,
  type ChangeLifecycle,
  type QuestionRole,
} from "@maycombhq/core";
import { changeReport, changeStore } from "@maycombhq/changes";
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
  /** Where the stages' work is against the state, in one sentence (B-change, C4 2.25.0). */
  work?: string;
  stages: StageProgress[];
  openQuestions: number;
  /** ADR 0181 part 4: the open questions by the role that owns them. */
  openQuestionsByRole: Partial<Record<QuestionRole, number>>;
  /** ADR 0181 part 4: the person's roles on the change (change.yaml owners), when a person is given. */
  yourRoles?: QuestionRole[];
  repos: { id: string; branch: string; base: string; pr?: string }[];
  /** ADR 0191: who the change waits on now, by role and name. */
  waitsOn?: WaitsOn;
}

export interface WaitsOn {
  role: string;
  people: string[];
  because: "handoff" | "phase";
  phase: string;
}

const handle = (p: string) => p.trim().replace(/^@/, "");

/**
 * ADR 0191: who a change waits on. An open hand-off waits on its reviewers of the next role (the
 * architect for Define's); otherwise the phase's own role: the product owner in Define, the
 * architect in Design, the business analyst in Plan until the stories are done, then the tech
 * lead, who also has Build. People are the change's owners of that role (none named: empty).
 */
export function waitsOnOf(
  c: Pick<ChangeLifecycle, "state" | "owners" | "handoffs">,
  storiesDone: boolean,
): WaitsOn | undefined {
  const live = c.handoffs.find((h) => h.state === "open" || h.state === "changes-requested");
  if (live) {
    const n = nextOwnersOf(live.phase, c.owners);
    if (n) {
      const named = live.reviewers.map(handle).filter((p) => n.people.includes(p));
      return {
        role: n.role,
        people: named.length ? named : n.people,
        because: "handoff",
        phase: live.phase,
      };
    }
  }
  const role =
    c.state === "define" || c.state === "draft" || c.state === "returned"
      ? "product-owner"
      : c.state === "design"
        ? "architect"
        : c.state === "plan"
          ? storiesDone
            ? "team-lead"
            : "business-analyst"
          : c.state === "build" || c.state === "qa" || c.state === "release-ready"
            ? "team-lead"
            : undefined;
  if (!role) return undefined;
  const people = [...new Set((c.owners[role] ?? []).map(handle))].filter((p) => !p.includes("/"));
  return { role, people, because: "phase", phase: c.state };
}

async function stageProgress(dir: string, stage: StageName, open: Set<string>) {
  const text = await readFile(join(dir, "stage", `${stage}.yaml`), "utf8").catch(() => undefined);
  if (!text)
    return { stage, state: "not-started", drafts: 0, rounds: 0, openQuestions: 0, asked: [] };
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
    /** The open questions it raised. */
    asked: asked.filter((q) => open.has(q)),
  };
}

export async function cockpit(
  root: string,
  id: string,
  o: { user?: string } = {},
): Promise<Cockpit> {
  const report = await changeReport(root, id);
  const dir = join(changesDirOf(root), id);
  const { questions } = await listQuestions(root, { state: "open" }).catch(() => ({
    questions: [],
  }));
  // Every open question: a stage files the questions it raises under the repo they are about,
  // so the change's own are those filed under it plus those its stages raised.
  const open = new Set<string>(questions.map((q) => q.id));
  const stages = [];
  for (const s of STAGES) stages.push(await stageProgress(dir, s, open));
  const ofChange = new Set<string>([
    ...questions.filter((q) => q.repo === id).map((q) => q.id),
    ...stages.flatMap((s) => s.asked),
  ]);
  // ADR 0181 part 4: each open question of the change by the role that owns it.
  const { stageQuestions, roleWithStage, personsRoles } = await import("./change-roles.js");
  const raisedBy = await stageQuestions(root, id);
  const byRole: Partial<Record<QuestionRole, number>> = {};
  for (const q of questions) {
    if (!ofChange.has(q.id)) continue;
    const r = roleWithStage(q, raisedBy);
    if (r) byRole[r] = (byRole[r] ?? 0) + 1;
  }
  // This change's own next step, whatever else waits elsewhere in the metarepo.
  const state = (await readNextState(root)).changes.find((c) => c.id === id);
  const next = state ? changeSteps(state)[0] : undefined;
  const repos = await readChangeRepos(root, id).catch(() => undefined);
  const lifecycle = await changeStore(root)
    .read(id)
    .catch(() => undefined);
  const waitsOn = lifecycle
    ? waitsOnOf(lifecycle, stages.find((s) => s.stage === "stories")?.state === "done")
    : undefined;
  return {
    id,
    state: report.state,
    ...(next ? { next } : {}),
    nextStep: report.nextStep,
    reasons: report.reasons,
    risk: { level: report.risk.level, score: report.risk.score },
    ...(report.progress ? { work: report.progress.summary } : {}),
    stages: stages.map(({ asked: _asked, ...rest }) => rest),
    openQuestions: ofChange.size,
    openQuestionsByRole: byRole,
    ...(o.user !== undefined ? { yourRoles: await personsRoles(root, id, o.user) } : {}),
    ...(waitsOn ? { waitsOn } : {}),
    repos: (repos?.repos ?? []).map((r) => ({
      id: r.id,
      branch: r.branch,
      base: r.base,
      ...(r.pr?.url ? { pr: r.pr.url } : {}),
    })),
  };
}
