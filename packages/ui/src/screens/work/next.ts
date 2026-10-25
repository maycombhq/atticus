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
  /** Onboarding has nothing left to do: this step only says so. */
  done?: boolean;
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
  return ownStep(stage, c, tasks);
}

/** A stage's own step for a change, whatever stage the change's state puts it at. */
function ownStep(stage: Stage, c: ChangeRow, tasks?: TaskRow[]): Step {
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

/** A stage's loop under way (stage/<stage>.yaml): drafting, with the assistant, asking or stopped. */
const UNDER_WAY = new Set(["drafting", "waiting", "questions", "stopped"]);

/**
 * The step of a stage whose loop is done (ADR 0087): the change then waits on its gate. No
 * hand-off PR yet and nothing else in the way: raise it. Its PR open: sync it once merged.
 * Changes asked for on it: hand off again. Anything else (a blocking finding, a file missing):
 * the status says what, with the first reason.
 */
function gateStep(page: Stage, c: ChangeRow, cockpit: Api.ChangeCockpitT): Step {
  const others = cockpit.reasons.filter(
    (r) => r.code !== "no-handoff" && r.code !== "pr-not-merged" && r.code !== "changes-requested",
  );
  const status = { command: `atticus change status ${c.id}` };
  if (others.length) return { ...status, why: W.why.stageBlocked(page, others[0]!.message) };
  const why = W.why.stageDone(page, cockpit.nextStep);
  if (cockpit.reasons.some((r) => r.code === "pr-not-merged"))
    return { command: `atticus change sync ${c.id}`, why };
  if (cockpit.reasons.some((r) => r.code === "no-handoff" || r.code === "changes-requested"))
    return { ...handoff(c.id), why };
  return { ...status, why };
}

/**
 * The step a stage page shows for a change: its own, or a pointer to the page it is at. With the
 * change's cockpit (its stages' loop states and what stops its gate), a stage tab follows its own
 * stage first (a real change, 2026-10-25: Stories said "at the feature stage" with stories done
 * and the change waiting on its hand-off PR): done, the gate; under way, its own command.
 */
export function stageStep(
  page: Stage,
  c: ChangeRow,
  tasks?: TaskRow[],
  cockpit?: Api.ChangeCockpitT,
): Step {
  const own = cockpit?.stages.find((s) => s.stage === page);
  if (cockpit && own && !c.fastPath && stageOf(c.state) !== "done") {
    if (own.state === "done") return gateStep(page, c, cockpit);
    if (UNDER_WAY.has(own.state))
      return { ...ownStep(page, c, tasks), why: W.why.stageUnderWay(page, own.state) };
  }
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
    /** Repos the catalog holds records of (from their verified facts, ADR 0124). */
    scanned: repos.filter((r) => r.lastScan !== null).length,
    records: v.catalog.records,
  };
}

/** The trust states that hold onboarding up: the repo isn't read, verified or written yet. */
const UNREAD: ReadonlySet<Api.TrustRepoT["state"]> = new Set([
  "not-read",
  "unverified",
  "rejected",
  "stale",
  "unwritten",
]);

/** Read a repo with the assistant (ADR 0124), then verify and write its facts. */
export function readStep(repo: string): Step {
  return {
    command: `atticus map ${repo}`,
    why: W.why.read["not-read"](repo),
    slash: metarepo(`/atticus-map ${repo}`),
    after: [{ command: `atticus verify ${repo} --write`, why: W.why.write(repo) }],
  };
}

/**
 * The next onboarding step, the Atticus 2 way (ADR 0124): pick, clone or sync, then each repo
 * read by the assistant and its facts verified and written, then the questions. With the trust
 * view, a repo's step is the one Map › Trust gives it; without, a repo the catalog holds nothing
 * of is read. Once everything is done, the step says so (`done`) and points at Map › Trust.
 */
export function onboardingStep(
  v: OnboardingData,
  openQuestions: number,
  trust?: Api.TrustViewT,
): Step {
  const repos = v.repos;
  if (repos.length === 0)
    return { command: "atticus repos discover <folder>", why: W.why.discover };
  const notCloned = repos.filter((r) => !r.cloned);
  if (notCloned.length)
    return { command: "atticus workspace sync", why: W.why.sync(notCloned.length) };
  const trustLink = { href: "#/trust", label: W.openTrust };
  if (trust) {
    const listed = new Set(repos.map((r) => r.id));
    const r = trust.repos.find((x) => listed.has(x.repo) && UNREAD.has(x.state) && x.next);
    if (r?.next)
      return {
        command: r.next.command,
        why: W.why.read[r.state as keyof typeof W.why.read](r.repo),
        ...(r.next.slash ? { slash: metarepo(r.next.slash) } : {}),
        link: trustLink,
      };
  } else {
    const unread = repos.find((r) => r.lastScan === null);
    if (unread) return { ...readStep(unread.id), link: trustLink };
  }
  if (openQuestions > 0)
    return {
      command: "atticus questions list --state open",
      why: W.why.answer(openQuestions),
      slash: metarepo("/atticus-answer"),
      link: { href: "#/questions", label: W.stepAnswerLink },
    };
  return { command: "atticus next", why: W.why.onboarded, link: trustLink, done: true };
}

/** True when onboarding has nothing left to do. */
export function onboarded(
  v: OnboardingData,
  openQuestions: number,
  trust?: Api.TrustViewT,
): boolean {
  return onboardingStep(v, openQuestions, trust).done === true;
}

/** The dashboard's one step: onboarding first, then the first change in flight, then a new one. */
export function dashboardStep(
  v: OnboardingData,
  openQuestions: number,
  changes: ChangeRow[],
  trust?: Api.TrustViewT,
): Step {
  if (!onboarded(v, openQuestions, trust)) {
    const s = onboardingStep(v, openQuestions, trust);
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

/**
 * The Architecture page's step: the change its address names, by its architecture stage and gate
 * (with its cockpit); else a change at the design stage; else reading a repo again (ADR 0124:
 * the diagram is drawn from the catalog the verified facts fill).
 */
export function architectureStep(
  changes: ChangeRow[],
  picked?: { change: ChangeRow; cockpit?: Api.ChangeCockpitT },
): Step {
  if (picked) return stageStep("architecture", picked.change, undefined, picked.cockpit);
  const c = changes.find((x) => stageOf(x.state) === "architecture");
  if (c) return changeStep(c);
  return {
    command: "atticus map <repo>",
    why: W.why.refresh,
    slash: metarepo("/atticus-map <repo>"),
    after: [{ command: "atticus verify <repo> --write", why: W.why.write("<repo>") }],
  };
}
