import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import {
  changesDirOf,
  orgPackDirOf,
  listQuestions,
  nextOwnersOf,
  ownersOfRole,
  type ChangeLifecycle,
  type CustomRole,
  type QuestionRole,
} from "@maycombhq/core";
import {
  changeReport,
  changeStore,
  handoffName,
  loadChangePolicy,
  stageCompletion,
  stageWorkDone,
  type ChangeReport,
  type StageCompletion,
} from "@maycombhq/changes";
import { readChangeRepos } from "@maycombhq/workspace";
import { changeSteps, readNextState, type NextState, type NextStep } from "./next-commands.js";

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
  /**
   * not-started when the stage has no loop file yet; else the loop's own state. Beta.27 review:
   * as the lifecycle reads it (stageCompletion): `person` when a person wrote the planning files
   * the stage writes, `skipped` when the change passed the stage without it running.
   */
  state: string;
  /** With `person`: the files a person wrote, change-folder-relative. */
  files?: string[];
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
 * lead, who also has Build. People are the change's owners of that role (none named: empty),
 * read as Your changes reads them: any case, `tech-lead` for the team lead, roles.yaml's custom
 * roles.
 */
export function waitsOnOf(
  c: Pick<ChangeLifecycle, "state" | "owners" | "handoffs">,
  storiesDone: boolean,
  custom: readonly CustomRole[] = [],
): WaitsOn | undefined {
  const live = c.handoffs.find((h) => h.state === "open" || h.state === "changes-requested");
  if (live) {
    const n = nextOwnersOf(live.phase, c.owners, custom);
    if (n) {
      const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
      const named = n.people.filter((p) => live.reviewers.some((r) => same(handle(r), p)));
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
  return { role, people: ownersOfRole(role, c.owners, custom), because: "phase", phase: c.state };
}

/** The next steps that are the gate's own: raising its hand-off, or merging the one raised. */
const GATE_STEPS = new Set(["handoff", "small-handoff", "merge"]);
/**
 * Beta.27 review: in the release phase, go/no-go is decided over the release PRs (ADR 0184), so
 * raising them, merging them and the release step itself are the gate's own steps too.
 */
const RELEASE_GATE_STEPS = new Set(["release", "release-prs", "release-prs-merge"]);

/**
 * Beta.27: At a glance's one sentence agrees with its next step. `change status` says "Ready to
 * raise" once nothing in the phase's checks blocks; a step that comes first (a question that
 * waits, its stage to run again, a seed to accept) isn't one of those checks, so beta.26 said
 * "Ready to raise "Plan ready"" over "Answer 1 question, then run the stories stage again".
 * While the next step is anything but the gate's own, the sentence says it isn't ready yet.
 * Beta.27 review: readiness is the report's `ready`, never a match on its sentence's words.
 * "The step below" is At a glance's, which shows it under the sentence; every other page and
 * `change status` (`where: "page"`) say the step's own words: "…yet: first, <why>".
 */
export function glanceNextStep(
  report: Pick<ChangeReport, "nextStep" | "ready" | "type" | "phase">,
  next: (Pick<NextStep, "step"> & Partial<Pick<NextStep, "why">>) | undefined,
  where: "glance" | "page" = "glance",
): string {
  if (!report.ready || !report.phase || glanceReady(report, next)) return report.nextStep;
  const not = `Not ready to raise "${handoffName(report.type, report.phase)}" yet`;
  const why = next?.why?.trim();
  if (where === "page" && why) return `${not}: first, ${lowerFirst(why)}`;
  return `${not}: the step below comes first.`;
}

/** A sentence's first word lower-cased to follow "first,"; an acronym (SNOW, PR) is kept. */
const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s);

/**
 * Beta.27 review: the phase's hand-off can be raised now: nothing in its checks blocks (the
 * report's `ready`) and no other step comes first (the change's next step is the gate's own).
 */
export function glanceReady(
  report: Pick<ChangeReport, "ready" | "phase">,
  next: Pick<NextStep, "step"> | undefined,
): boolean {
  if (!report.ready || !report.phase) return false;
  if (!next || GATE_STEPS.has(next.step)) return true;
  return report.phase === "release" && RELEASE_GATE_STEPS.has(next.step);
}

/**
 * Beta.27 review: the one next-step sentence every page says of a change (At a glance, All
 * changes, the brief's Gate, Across, Release), and whether its hand-off can be raised now. Pass
 * `state` when saying it of many changes, so the metarepo is read once; `where: "page"` for any
 * page but At a glance (and `change status`), which says the step itself, not "the step below".
 */
export async function changeNextStep(
  root: string,
  id: string,
  report: Pick<ChangeReport, "nextStep" | "ready" | "type" | "phase">,
  state?: NextState,
  where: "glance" | "page" = "glance",
): Promise<{
  nextStep: string;
  /**
   * Beta.27 review, final round: on a page, the same sentence in the app's words (no command to
   * type), when the step's reason made it say one.
   */
  nextStepApp?: string;
  ready: boolean;
  stepFirst: boolean;
  next?: NextStep;
}> {
  const s = state ?? (await readNextState(root).catch(() => undefined));
  const own = s?.changes.find((c) => c.id === id);
  const next = own ? changeSteps(own)[0] : undefined;
  const ready = glanceReady(report, next);
  const nextStep = glanceNextStep(report, next, where);
  const stepFirst = report.ready && !ready;
  let nextStepApp: string | undefined;
  if (where === "page" && stepFirst && next?.why) {
    const { commandShapes, stepInAppWords } = await import("./step-app-words.js");
    nextStepApp = glanceNextStep(
      report,
      { ...next, why: stepInAppWords(next.why, await commandShapes()) },
      where,
    );
  }
  return {
    nextStep,
    ...(nextStepApp ? { nextStepApp } : {}),
    ready,
    // Nothing in the gate's checks blocks, yet another step comes first.
    stepFirst,
    ...(next ? { next } : {}),
  };
}

async function stageProgress(
  dir: string,
  stage: StageName,
  open: Set<string>,
  done: StageCompletion | undefined,
) {
  const text = await readFile(join(dir, "stage", `${stage}.yaml`), "utf8").catch(() => undefined);
  if (!text) {
    // Beta.27 review: the lifecycle's own reading, so At a glance never says "to come" of a
    // stage the change skipped, or of stories a person wrote.
    const state = done && done.state !== "unknown" ? done.state : "not-started";
    return {
      stage,
      state,
      ...(done?.files?.length ? { files: done.files } : {}),
      drafts: 0,
      rounds: 0,
      openQuestions: 0,
      asked: [],
    };
  }
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
  const lifecycle = await changeStore(root)
    .read(id)
    .catch(() => undefined);
  const { policy } = await loadChangePolicy(orgPackDirOf(root));
  const completion = await stageCompletion(
    { root, policy },
    { id, ...(lifecycle ? { state: lifecycle.state } : {}) },
  ).catch(() => [] as StageCompletion[]);
  const stages = [];
  for (const s of STAGES)
    stages.push(
      await stageProgress(
        dir,
        s,
        open,
        completion.find((x) => x.stage === s),
      ),
    );
  const ofChange = new Set<string>([
    ...questions.filter((q) => q.repo === id).map((q) => q.id),
    ...stages.flatMap((s) => s.asked),
  ]);
  // ADR 0181 part 4: each open question of the change by the role that owns it.
  const { stageQuestions, roleWithStage, personsRoles, customRoles } =
    await import("./change-roles.js");
  const raisedBy = await stageQuestions(root, id);
  const byRole: Partial<Record<QuestionRole, number>> = {};
  for (const q of questions) {
    if (!ofChange.has(q.id)) continue;
    const r = roleWithStage(q, raisedBy);
    if (r) byRole[r] = (byRole[r] ?? 0) + 1;
  }
  // This change's own next step, whatever else waits elsewhere in the metarepo.
  const said = await changeNextStep(root, id, report, await readNextState(root));
  const next = said.next;
  const repos = await readChangeRepos(root, id).catch(() => undefined);
  const waitsOn = lifecycle
    ? waitsOnOf(
        lifecycle,
        stageWorkDone(stages.find((s) => s.stage === "stories")?.state ?? ""),
        await customRoles(root),
      )
    : undefined;
  return {
    id,
    state: report.state,
    ...(next ? { next } : {}),
    nextStep: said.nextStep,
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
