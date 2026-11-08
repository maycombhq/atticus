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
const T2 = COPY.runNext;

export type OnboardingData = Api.OnboardingViewT;

/** Seventh UX walk: the kinds of step the app can take in place (step-action.tsx). */
export type StepKind =
  | "new-change"
  | "handoff"
  | "task"
  | "brief"
  | "answer"
  | "merge"
  | "release"
  | "findings"
  /** Ninth UX walk: a knowledge gap holds the gate; answered on the change's page. */
  | "gap";

/** The kind of step `atticus next` names (its `step`), where the app can take it in place. */
export function kindOfStep(step: string | undefined): StepKind | undefined {
  switch (step) {
    case "new-change":
    case "brief":
    case "answer":
    case "merge":
    case "release":
    case "task":
    case "findings": // Eighth UX walk: blocking findings hold the hand-off; resolved first.
      return step;
    case "handoff":
    case "small-handoff":
      return "handoff";
    case "tasks":
      return "task";
    case "release-prs":
    case "release-prs-merge":
      return "release";
    default:
      return undefined;
  }
}

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
  /**
   * Eighth UX walk: a line under the step about something that doesn't hold it, with where to
   * see to it (Home: the map questions still open while a change is followed).
   */
  aside?: { text: string; link: { href: string; label: string } };
  after?: { command: string; why: string; slash?: Slash }[];
  /** Onboarding has nothing left to do: this step only says so. */
  done?: boolean;
  /** Seventh UX walk: the kind of step, so the page shows its in-app action before the command. */
  kind?: StepKind;
  /** The change the step is about, for its action (Raise hand-off, the Task board). */
  change?: string;
  /** The hand-off PR a merge step waits on (manual:// on a manual Git host: never a link). */
  pr?: string;
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
  kind: "handoff" as const,
  change: id,
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
    kind: "task",
    change,
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
  // Ninth UX walk: a knowledge gap or a blocking finding is resolved on the change's page (Run
  // next said "In a terminal… No slash command does this step yet"); the command stays folded.
  const first = others[0];
  if (first)
    return {
      ...status,
      why: W.why.stageBlocked(page, first.message),
      ...(first.code === "open-gap"
        ? { kind: "gap" as const, change: c.id }
        : first.code === "blocking-finding"
          ? { kind: "findings" as const, change: c.id }
          : {}),
    };
  const why = W.why.stageDone(page, cockpit.nextStep);
  // Seventh UX walk: the PR the change waits on, as its cockpit's next step names it.
  if (cockpit.next?.step === "merge")
    return {
      command: cockpit.next.command,
      why,
      kind: "merge",
      change: c.id,
      ...(cockpit.next.pr ? { pr: cockpit.next.pr } : {}),
    };
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
  if (at === page) {
    const own = changeStep(c, tasks);
    // Seventh UX walk: where the change's own next step (its state and gate) is another, that
    // one: its questions, its hand-off with every task ticked, the PR it waits on.
    return cockpit?.next && cockpit.id === c.id && cockpit.next.command !== own.command
      ? cockpitStep(c, cockpit.next)
      : own;
  }
  // ADR 0113: every planning page shows a small change's one step.
  const planning = (s: Stage) => s === "feature" || s === "architecture" || s === "stories";
  if (c.fastPath && planning(at) && planning(page)) return changeStep(c, tasks);
  // Ninth UX walk: on Tasks (no stage loop of its own), the stage the change is at is done (it
  // said "at the stories stage" with the stories done): the change's step is that stage's gate,
  // as the stage's own page says.
  const atOwn = cockpit?.stages.find((s) => s.stage === at);
  if (page === "tasks" && cockpit?.id === c.id && atOwn?.state === "done" && !c.fastPath)
    return gateStep(at, c, cockpit);
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
  /** Open questions; undefined while they haven't loaded (or failed): never read as none. */
  openQuestions: number | undefined,
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
  if (openQuestions === undefined || openQuestions > 0)
    return {
      command: "atticus questions list --state open",
      why: openQuestions === undefined ? W.why.answerUnknown : W.why.answer(openQuestions),
      slash: metarepo("/atticus-answer"),
      link: { href: "#/questions", label: W.stepAnswerLink },
    };
  return { command: "atticus next", why: W.why.onboarded, link: trustLink, done: true };
}

/** True when onboarding has nothing left to do. */
export function onboarded(
  v: OnboardingData,
  openQuestions: number | undefined,
  trust?: Api.TrustViewT,
): boolean {
  return onboardingStep(v, openQuestions, trust).done === true;
}

/**
 * Seventh UX walk: a change's own next step as its cockpit gives it (`atticus next`'s, which
 * follows the change's state and gate), with the in-app action its kind has.
 */
export function cockpitStep(c: ChangeRow, next: NonNullable<Api.ChangeCockpitT["next"]>): Step {
  const kind = kindOfStep(next.step);
  return {
    command: next.command,
    why: next.why,
    ...(next.slash ? { slash: metarepo(next.slash) } : {}),
    ...(kind ? { kind } : {}),
    change: c.id,
    ...(next.pr ? { pr: next.pr } : {}),
  };
}

/**
 * Eighth UX walk: Home's onboarding is done once every repo is read and its facts verified. The
 * map questions still open don't hold it (they never block a change): Home says how many beside
 * the change's step.
 */
export function reposOnboarded(v: OnboardingData, trust?: Api.TrustViewT): boolean {
  return onboarded(v, 0, trust);
}

/**
 * The dashboard's one step: onboarding first (the repos read and verified), then the first change
 * in flight, then a new one. With that change's cockpit, its own next step (seventh UX walk: Home
 * said "at the feature stage" while the change waited on its hand-off PR). Open map questions are
 * a line under the step, linking to Questions (eighth UX walk: Home stayed on "4 questions are
 * waiting" for a whole change, even at release-ready).
 */
export function dashboardStep(
  v: OnboardingData,
  /** Open map questions (not a change's); undefined while they haven't loaded. */
  openQuestions: number | undefined,
  changes: ChangeRow[],
  trust?: Api.TrustViewT,
  cockpit?: Api.ChangeCockpitT,
): Step {
  if (!reposOnboarded(v, trust)) {
    const s = onboardingStep(v, openQuestions, trust);
    return s.link ? s : { ...s, link: { href: "#/onboarding", label: W.openOnboarding } };
  }
  const aside = openQuestions
    ? {
        aside: {
          text: T2.mapQuestions(openQuestions),
          link: { href: "#/questions", label: T2.mapQuestionsLink },
        },
      }
    : {};
  const c = changes.find(inFlight);
  if (!c)
    return {
      command: 'atticus change new "<title>" --type <type>',
      why: W.why.newChange,
      kind: "new-change",
      ...aside,
    };
  const stage = stageOf(c.state);
  const screen = STAGE_SCREEN[stage];
  const link = screen
    ? { link: { href: href(screen.id, c.id), label: W.goStage(screen.label) } }
    : {};
  if (cockpit?.id === c.id && cockpit.next)
    return { ...cockpitStep(c, cockpit.next), ...link, ...aside };
  return {
    ...changeStep(c),
    why: W.why.change(c.id, W.stage[stage]),
    ...link,
    ...aside,
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
