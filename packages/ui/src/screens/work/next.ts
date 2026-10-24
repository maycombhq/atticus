import type { Api } from "@maycombhq/core";
import { COPY } from "../../copy.js";

const T = COPY.nextStep;

/**
 * What to run next, worked out from files the API returns (plan 4.5, principle 8). The app
 * never runs a step: each page shows the command, and the slash command for Copilot Chat
 * where `atticus assistant-files` writes one (ADR 0086: /atticus-survey, -answer, -feature,
 * -stories and the others). `atticus next` works out the same from the files on the command
 * line. Pure functions, so tests can check every case.
 */

const W = COPY.work;

export type OnboardingData = Api.OnboardingViewT;

export interface ChangeRow {
  id: string;
  title: string;
  state: string;
  /** ADR 0113: it takes the fast path, one step from brief to tasks. */
  fastPath?: boolean;
  /** Its open findings, as /api/changes counts them: a blocking one marks it blocked on Home. */
  openFindings?: { blocking: number };
}

export interface TaskRow {
  id: string;
  repo: string;
  description: string;
  done: boolean;
}

export interface Slash {
  command: string;
  /** Where to type it: the metarepo, or a code repo by name. */
  where: string;
}

export interface Step {
  command: string;
  why: string;
  slash?: Slash;
  link?: { href: string; label: string };
  after?: { command: string; why: string; slash?: Slash }[];
}

export type Stage = "feature" | "architecture" | "stories" | "tasks" | "release" | "done";

/** The stage a change's state puts it at (plan 4.4: feature, architecture, stories and tasks). */
export function stageOf(state: string): Stage {
  switch (state) {
    case "draft":
    case "define":
    case "returned":
      return "feature";
    case "design":
      return "architecture";
    case "plan":
      return "stories";
    case "build":
    case "qa":
      return "tasks";
    case "released":
    case "archived":
      return "done";
    default:
      return "release";
  }
}

/** The screen each stage is worked on; release is still a page under More. */
export const STAGE_SCREEN: Record<Stage, { id: string; label: string } | undefined> = {
  feature: { id: "feature-design", label: COPY.nav.feature },
  architecture: { id: "architecture", label: COPY.nav.architecture },
  stories: { id: "stories", label: COPY.nav.stories },
  tasks: { id: "task-list", label: COPY.nav.tasks },
  release: { id: "release", label: T.releasePlan },
  done: undefined,
};

export const inFlight = (c: ChangeRow) => stageOf(c.state) !== "done";

const href = (screen: string, change?: string) =>
  `#/${screen}${change ? `?change=${encodeURIComponent(change)}` : ""}`;

const metarepo = (command: string): Slash => ({ command, where: W.slashWhere.metarepo });

const critic = (id: string) => ({
  command: `atticus critic ${id}`,
  why: W.why.critic,
  slash: metarepo(`/atticus-critic ${id}`),
});
const handoff = (id: string) => ({
  command: `atticus change handoff ${id} --approve`,
  why: W.why.handoff,
});

/**
 * The next open task, the way `atticus task run` and `/atticus-task` take it: the slash command
 * loads the task's context in the metarepo (ADR 0113), and `atticus task context` prints it.
 */
export function taskStep(change: string, t: TaskRow): Step {
  return {
    command: `atticus task run ${change} ${t.id}`,
    why: W.why.task(t.id, t.repo),
    slash: metarepo(`/atticus-task ${change} ${t.id}`),
    after: [
      {
        command: `atticus task context ${change} ${t.id}`,
        why: W.taskInRepo(t.repo),
      },
    ],
  };
}

/** The step for a change at its own stage. */
export function changeStep(c: ChangeRow, tasks?: TaskRow[]): Step {
  const stage = stageOf(c.state);
  // ADR 0113: a small change goes from brief to tasks in one step.
  if (c.fastPath && (stage === "feature" || stage === "architecture" || stage === "stories"))
    return {
      command: `atticus change small ${c.id}`,
      why: W.why.small,
      slash: metarepo(`/atticus-small ${c.id}`),
      after: [handoff(c.id)],
    };
  switch (stage) {
    case "feature":
      return {
        command: `atticus change feature ${c.id}`,
        why: W.why.feature,
        slash: metarepo(`/atticus-feature ${c.id}`),
        after: [handoff(c.id)],
      };
    case "architecture":
      return {
        command: `atticus change architecture ${c.id}`,
        why: W.why.architecture,
        slash: metarepo(`/atticus-architecture ${c.id}`),
        after: [handoff(c.id)],
      };
    case "stories":
      return {
        command: `atticus plan stories ${c.id}`,
        why: W.why.stories,
        slash: metarepo(`/atticus-stories ${c.id}`),
        after: [critic(c.id), handoff(c.id)],
      };
    case "tasks": {
      const open = tasks?.find((t) => !t.done);
      if (open) return taskStep(c.id, open);
      return { command: `atticus change status ${c.id}`, why: W.why.later };
    }
    default:
      return {
        command: `atticus change status ${c.id}`,
        why: W.why.later,
        ...(stage === "release" ? { slash: metarepo(`/atticus-release ${c.id}`) } : {}),
      };
  }
}

/** The step a stage page shows for a change: its own, or a pointer to the page it is at. */
export function stageStep(page: Stage, c: ChangeRow, tasks?: TaskRow[]): Step {
  const at = stageOf(c.state);
  if (at === page) return changeStep(c, tasks);
  // ADR 0113: every planning page shows a small change's one step.
  const planning = (s: Stage) => s === "feature" || s === "architecture" || s === "stories";
  if (c.fastPath && planning(at) && planning(page)) return changeStep(c, tasks);
  const screen = STAGE_SCREEN[at];
  return {
    command: `atticus change status ${c.id}`,
    why: W.stageIs(W.stage[at]),
    ...(screen ? { link: { href: href(screen.id, c.id), label: W.goStage(screen.label) } } : {}),
  };
}

/**
 * The change a change's tab is about: the one its address names, picked in All changes (the
 * product owner, 2026-10-24). None when the address names none, or one not in the list: the tab
 * then says to pick one there.
 */
export function pickChange(list: ChangeRow[], wanted: string | undefined): ChangeRow | undefined {
  return wanted === undefined ? undefined : list.find((c) => c.id === wanted);
}

/** How far onboarding has got, for the dashboard and the step list. */
export function onboardingProgress(v: OnboardingData) {
  const repos = v.repos;
  return {
    listed: repos.length,
    cloned: repos.filter((r) => r.cloned).length,
    settings: repos.filter((r) => r.scanSettings.present).length,
    scanned: repos.filter((r) => r.lastScan !== null).length,
    records: v.catalog.records,
  };
}

/**
 * The next onboarding step, in the order of the steps: pick, clone or sync, survey, scan,
 * answer, review. Undefined never: once everything is done, the review is what is left.
 */
export function onboardingStep(v: OnboardingData, openQuestions: number): Step {
  const repos = v.repos;
  if (repos.length === 0)
    return { command: "atticus repos discover <folder>", why: W.why.discover };
  const notCloned = repos.filter((r) => !r.cloned);
  if (notCloned.length)
    return { command: "atticus workspace sync", why: W.why.sync(notCloned.length) };
  const unsurveyed = repos.find((r) => !r.scanSettings.present);
  if (unsurveyed)
    return {
      command: `atticus scan survey ${unsurveyed.id}`,
      why: W.why.survey(unsurveyed.id),
      slash: metarepo(`/atticus-survey ${unsurveyed.id}`),
    };
  if (v.catalog.records === 0 || repos.some((r) => r.lastScan === null))
    return { command: "atticus scan", why: W.why.scan };
  if (openQuestions > 0)
    return {
      command: "atticus questions list --state open",
      why: W.why.answer(openQuestions),
      slash: metarepo("/atticus-answer"),
      link: { href: "#/questions", label: W.stepAnswerLink },
    };
  const first = repos[0]!;
  return { command: `atticus scan review ${first.id}`, why: W.why.review(first.id) };
}

/** True when onboarding has nothing left but the review. */
export function onboarded(v: OnboardingData, openQuestions: number): boolean {
  return onboardingStep(v, openQuestions).command.startsWith("atticus scan review");
}

/** The dashboard's one step: onboarding first, then the first change in flight, then a new one. */
export function dashboardStep(
  v: OnboardingData,
  openQuestions: number,
  changes: ChangeRow[],
): Step {
  if (!onboarded(v, openQuestions)) {
    const s = onboardingStep(v, openQuestions);
    return s.link ? s : { ...s, link: { href: "#/onboarding", label: W.openOnboarding } };
  }
  const c = changes.find(inFlight);
  if (!c) return { command: 'atticus change new "<title>" --type <type>', why: W.why.newChange };
  const stage = stageOf(c.state);
  const screen = STAGE_SCREEN[stage];
  return {
    ...changeStep(c),
    why: W.why.change(c.id, W.stage[stage]),
    ...(screen ? { link: { href: href(screen.id, c.id), label: W.goStage(screen.label) } } : {}),
  };
}

/** The Architecture page's step: a change at the design stage, else a fresh scan. */
export function architectureStep(changes: ChangeRow[]): Step {
  const c = changes.find((x) => stageOf(x.state) === "architecture");
  if (c) return changeStep(c);
  return { command: "atticus scan", why: W.why.refresh };
}
