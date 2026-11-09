import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Api } from "@maycombhq/core";
import type { QuestionView } from "../src/screens/Questions.js";
import { all, mount, text } from "./support/hooks.js";

/**
 * Eighth UX walk (next steps): Raise hand-off says what holds it, blocking findings are the step
 * before it, a finished run goes back to its change, Questions opened for a change shows that
 * change's questions, the words of a few lines, and Home's pending count after Accept the
 * catalog. Invented Forge data only (CLAUDE.md rule 3); no network (rule 5).
 */
vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
let status: { state: "loading" } | { state: "ready"; data: { blockers: { message: string }[] } } = {
  state: "loading",
};
let changeRepos: string[] = [];
let reloads = 0;
vi.mock("../src/api/client.js", async () => ({
  ...(await vi.importActual<object>("../src/api/client.js")),
  useApi: (path: string | undefined) =>
    path?.endsWith("/status")
      ? { ...status, reload: () => {} }
      : path?.startsWith("/api/propose")
        ? {
            state: "ready",
            data: {
              scope: "work",
              files: [{ path: "catalog/baseline.yaml", status: "??" }],
              branch: "propose/work/2026-11-08-ada",
              title: "Changes made in the Atticus app",
            },
            reload: () => void reloads++,
          }
        : path?.startsWith("/api/changes/")
          ? { state: "ready", data: { repos: changeRepos }, reload: () => {} }
          : { state: "loading", reload: () => {} },
  useLiveEvents: () => undefined,
  useReloadOnFiles: () => undefined,
}));
const { COPY } = await import("../src/copy.js");
const { HandoffHere, StepAction, hasAction } = await import("../src/screens/work/step-action.js");
const { RaiseHandoff } = await import("../src/screens/know/Phase.js");
const { kindOfStep } = await import("../src/screens/work/next.js");
const { afterRun, roundOf, RunDetail } = await import("../src/screens/runs/Runs.js");
const Q = await import("../src/screens/Questions.js");
const { TaskRunLine } = await import("../src/screens/Changes.js");
const { PendingProposals, workChanged } = await import("../src/app/propose.js");
const { OpenWorkspace } = await import("../src/screens/work/Cockpit.js");

const C = COPY.cockpit;
const R = COPY.runNext;
const RU = COPY.runs;
const html = (el: ReactElement) => renderToStaticMarkup(el);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");

const raiseButton = (tree: unknown) =>
  all(tree).find((e) => e.type === RaiseHandoff)!.props as { blockers: number; held?: boolean };

describe("Raise hand-off says what holds it", () => {
  it("waits while what blocks the gate is read, never enabled for a moment", () => {
    status = { state: "loading" };
    const m = mount(HandoffHere as never, { change: "lock-card" } as never);
    expect(text(m.tree)).toContain(C.raiseChecking);
    expect(text(m.tree)).not.toContain(C.raiseHere);
    expect(raiseButton(m.tree).held).toBe(true);
  });

  it("names the blockers instead of saying Raise it here", () => {
    status = {
      state: "ready",
      data: {
        blockers: [
          { message: "Blocking finding conform-a on the conform gate (round 2): no call." },
          { message: "Blocking finding conform-b on the conform gate (round 2): no route." },
        ],
      },
    };
    const m = mount(HandoffHere as never, { change: "lock-card" } as never);
    const words = text(m.tree);
    expect(words).toContain(C.raiseHeld(2));
    expect(words).toContain("conform-a");
    expect(words).not.toContain(C.raiseHere);
    expect(raiseButton(m.tree)).toMatchObject({ blockers: 2, held: false });
    status = { state: "ready", data: { blockers: [] } };
    expect(text(mount(HandoffHere as never, { change: "lock-card" } as never).tree)).toContain(
      C.raiseHere,
    );
  });

  it("held, the button says why where it is seen, not only in its tooltip", () => {
    const m = mount(RaiseHandoff as never, { change: "lock-card", blockers: 3 } as never);
    const button = all(m.tree).find((e) => e.type === "button")!;
    expect(button.props.disabled).toBe(true);
    expect(button.props["aria-describedby"]).toBeTruthy();
    expect(text(m.tree)).toContain(COPY.phase.blockedBy(3));
    const held = mount(
      RaiseHandoff as never,
      { change: "lock-card", blockers: 0, held: true } as never,
    );
    expect(all(held.tree).find((e) => e.type === "button")!.props.disabled).toBe(true);
    expect(text(held.tree)).not.toContain(COPY.phase.blockedBy(0));
  });

  it("blocking findings are a step of their own, resolved on the change's page", () => {
    expect(kindOfStep("findings")).toBe("findings");
    const step = {
      kind: "findings" as const,
      command: "atticus change status lock-card",
      change: "lock-card",
    };
    expect(hasAction(step)).toBe(true);
    const out = html(<>{StepAction(step)}</>);
    expect(out).toContain('href="#/changes/lock-card"');
    expect(out).toContain(esc(R.resolveFindings));
  });
});

type Item = Api.RunListItem;
const run = (id: string, over: Partial<Item> = {}): Item => ({
  schemaVersion: 6,
  runId: id,
  change: "lock-card",
  agent: "complete-critic",
  runtime: "hand-off",
  state: "validated",
  startedAt: "2026-11-08T19:00:00Z",
  contextManifestSha256: "0".repeat(64),
  errors: [],
  attempt: 1,
  answered: true,
  handedBack: 0,
  ...over,
});
const transcript = (r: Item, rounds = [r]): Api.RunTranscript => ({
  run: r,
  prompt: "Write the findings.",
  handedBack: [],
  rounds: rounds.map((x) => ({
    runId: x.runId,
    attempt: x.attempt,
    state: x.state,
    startedAt: x.startedAt,
  })),
});

describe("a finished chain of runs goes on to its change", () => {
  const last = run("run-20261108190014-0002");
  const changes = new Set(["lock-card"]);

  it("to the run that waits next, while one does", () => {
    const waiting = run("run-20261108190014-0003", { state: "waiting", answered: false });
    expect(afterRun(transcript(last), [last, waiting], changes)).toEqual({
      href: "#/runs?run=run-20261108190014-0003",
      label: RU.toNextRun,
    });
  });

  it("else to the change's At a glance, or the Task board for a task's run", () => {
    expect(afterRun(transcript(last), [last], changes)).toEqual({
      href: "#/cockpit?change=lock-card",
      label: RU.toGlance("lock-card"),
    });
    const task = run("run-20261108192251-0001", {
      agent: "task-runner",
      taskRun: {
        task: "3.1",
        repo: "forge-teller-app",
        level: "ai",
        state: "pr-open",
        branch: "task/lock-card/3.1",
        worktree: "workspace/forge-teller-app",
        notes: [],
      },
    });
    expect(afterRun(transcript(task), [task], changes)).toEqual({
      href: "#/tasks?change=lock-card",
      label: RU.toTaskBoard("3.1"),
    });
  });

  it("nothing for a run still waiting, or one that isn't a change's", () => {
    expect(afterRun(transcript(run("run-1-0001", { state: "waiting" })), [], changes)).toBe(
      undefined,
    );
    expect(afterRun(transcript(run("run-1-0002", { change: "knowledge-scan" })), [], changes)).toBe(
      undefined,
    );
  });

  it("numbers a step's rounds in order, though both recorded attempt 1", () => {
    const one = run("run-20261108190014-0001");
    const two = run("run-20261108190721-0001");
    const t = transcript(two, [one, two]);
    expect(roundOf(t)).toBe(2);
    const out = html(<RunDetail of={{ state: "ready", data: t }} />);
    expect(out).toContain(RU.round(1));
    expect(out).toContain(RU.round(2));
  });
});

const question = (id: string, command: string, rerun: string, repo: string) =>
  ({
    schemaVersion: 4,
    id,
    askedBy: { step: "feature", command, at: "2026-11-08T15:43:28.661Z" },
    repo,
    question: `Question ${id}?`,
    options: [],
    evidence: [],
    scope: { level: "repo", id: repo },
    state: "open",
    rerun,
  }) as QuestionView;

describe("Questions opened for a change", () => {
  const map = question(
    "q-b4c786e258b1",
    "atticus verify forge-proxy-core-v1 --write",
    "atticus verify forge-proxy-core-v1 --write",
    "forge-proxy-core-v1",
  );
  const mine = question(
    "q-c1a79cc23ea0",
    "atticus change feature lock-card",
    "atticus change feature lock-card",
    "lock-card",
  );
  // A stage files a question under the repo it is about: the step still names the change.
  const filed = question(
    "q-5f2da0f98cb3",
    "atticus plan stories lock-card",
    "atticus plan stories lock-card",
    "forge-teller-app",
  );

  it("shows the questions its steps asked, by the hand-off's rule", () => {
    expect(Q.namesChange("atticus critic lock-card", "lock-card")).toBe(true);
    expect(Q.namesChange("atticus verify lock-card --write", "lock-card")).toBe(false);
    expect(Q.changeOfHash("#/questions?change=lock-card")).toBe("lock-card");
    expect(Q.changeOfHash("#/questions")).toBeUndefined();
    const list = {
      state: "ready" as const,
      data: { questions: [map, mine, filed], problems: [], counts: undefined },
    };
    const scoped = Q.scopeToChange(list, "lock-card");
    expect(scoped.state === "ready" && scoped.data.questions.map((q) => q.id)).toEqual([
      "q-c1a79cc23ea0",
      "q-5f2da0f98cb3",
    ]);
    expect(Q.scopeToChange(list, undefined)).toBe(list);
    expect([map, mine, filed].filter(Q.isMapQuestion)).toEqual([map]);
  });

  it("says so in a change's words, with a way to every question", () => {
    const out = html(<Q.QuestionsIntro change="lock-card" />);
    expect(out).toContain(esc(COPY.questions.changeIntro("lock-card")));
    expect(out).toContain(esc(COPY.questions.onlyChange("lock-card")));
    expect(out).toContain(`<a href="#/questions">${COPY.questions.showAll}</a>`);
    // ADR 0189: plain words ("Apply puts it in the map" was jargon).
    expect(out).not.toContain("Apply uses it");
    expect(html(<Q.QuestionsIntro />)).toContain("Apply uses it");
  });
});

describe("words and states", () => {
  it("counts one question that waits", () => {
    expect(C.questions(1)).toBe("1 question waits for a person");
    expect(C.questions(2)).toBe("2 questions wait for a person");
  });

  it("says Or in a terminal everywhere a command is the other way", () => {
    expect(COPY.questions.orCommandLine).toBe("Or in a terminal:");
    expect(COPY.design.startOneFromA).toBe("Or in a terminal: ");
    const all = JSON.stringify(COPY);
    expect(all).not.toContain("Or on the command line:");
    expect(all).not.toContain("Or from the command line");
    expect(COPY.commandCenter.noChangeInFlight).not.toContain("atticus change new");
    expect(COPY.changes.pickAChangeOn).not.toMatch(/atticus change new|with $/);
    expect(C.noRepos).not.toContain("atticus workspace open");
  });

  it("says a merged task PR is merged, from the tasks view", () => {
    const t = {
      task: "3.1",
      repo: "forge-teller-app",
      level: "ai",
      state: "pr-open",
      branch: "task/lock-card/3.1",
      worktree: "workspace/forge-teller-app",
      notes: [],
    };
    expect(html(<TaskRunLine of={t} pr="merged" />)).toContain("Task 3.1: PR merged");
    expect(html(<TaskRunLine of={t} pr="closed" />)).toContain("Task 3.1: PR closed");
    expect(html(<TaskRunLine of={t} />)).toContain("Task 3.1: PR open");
  });

  it("makes the change's branches here when no repo has one", () => {
    changeRepos = ["forge-card-vault", "forge-teller-app"];
    const m = mount(OpenWorkspace as never, { change: "lock-card" } as never);
    const v = all(m.tree).find((e) => typeof e.props.children === "function" && "of" in e.props)!;
    const inner = (v.props.children as (d: unknown) => unknown)({});
    expect(text(inner)).toContain(C.openWorkspace(2));
    expect(all(inner).find((e) => typeof e.props.text === "string")?.props.text).toBe(
      "atticus workspace open lock-card --repos forge-card-vault,forge-teller-app",
    );
    changeRepos = [];
    const none = mount(OpenWorkspace as never, { change: "lock-card" } as never);
    const v2 = all(none.tree).find(
      (e) => typeof e.props.children === "function" && "of" in e.props,
    )!;
    const inner2 = (v2.props.children as (d: unknown) => unknown)({});
    expect(text(inner2)).toContain(C.noReposToOpen);
    expect(all(inner2).some((e) => e.type === "button")).toBe(false);
  });

  it("reads the pending proposals again after Accept the catalog", () => {
    reloads = 0;
    mount(PendingProposals as never, {} as never);
    workChanged();
    expect(reloads).toBeGreaterThan(0);
  });
});
