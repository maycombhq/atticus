import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import type { Task } from "../src/screens/Changes.js";
import { CockpitView } from "../src/screens/work/Cockpit.js";
import {
  isManualLink,
  runIsTheStep,
  TaskRunState,
  taskNext,
  taskRunsOnly,
} from "../src/screens/know/task-pr.js";

/**
 * Sixth UX walk: Build had no step after a task's Done. The Task board says where each task's
 * Run with AI stands, links its run and offers its PR on the person's click; At a glance doesn't
 * send the person back to a task that is drafted.
 */
const T = COPY.phase;
const C = COPY.cockpit;
const CHANGE = "show-an-account-s-status";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");

const task = (id: string, taskRun?: Task["taskRun"], run?: string): Task => ({
  id,
  repo: "forge-ledger-core",
  description: `Step ${id}`,
  done: false,
  branch: `task/${CHANGE}/${id}`,
  ...(run ? { run } : {}),
  ...(taskRun ? { taskRun } : {}),
});
const built = (id: string) =>
  task(
    id,
    {
      state: "built",
      level: "draft",
      branch: `task/${CHANGE}/${id}`,
      commit: "0123456789abcdef0123456789abcdef01234567",
      notes: [],
    },
    "run-20261108140003-0001",
  );

describe("a task that has run, on the Task board", () => {
  it("drafted and built: says so, links its run and offers Raise the task's PR", () => {
    const html = renderToStaticMarkup(<TaskRunState change={CHANGE} task={built("1.1")} />);
    expect(html).toContain(T.taskState.built!);
    expect(html).toContain('href="#/runs?run=run-20261108140003-0001"');
    expect(html).toContain(esc(T.taskBuilt(`task/${CHANGE}/1.1`, "0123456")));
    expect(html).toContain(esc(T.raiseTaskPr));
    expect(html).toContain(esc(T.raiseTaskPrWhy));
  });

  it("unverified: says why Atticus won't open its PR and what to do, with no Raise", () => {
    const t = task("1.1", {
      state: "unverified",
      level: "draft",
      branch: `task/${CHANGE}/1.1`,
      commit: "abc",
      notes: [],
    });
    const html = renderToStaticMarkup(<TaskRunState change={CHANGE} task={t} />);
    expect(html).toContain(T.taskState.unverified!);
    expect(html).toContain(
      esc(T.taskUnverified("forge-ledger-core", `task/${CHANGE}/1.1`, `change/${CHANGE}`)),
    );
    expect(html).not.toContain(esc(T.raiseTaskPr));
  });

  it("PR raised on a manual Git host: points to Manual steps, never a manual:// link", () => {
    const t = task("1.1", {
      state: "pr-open",
      level: "draft",
      branch: "b",
      pr: { number: 3, url: "manual://git-host/forge-ledger-core/pull/3" },
      notes: [],
    });
    const html = renderToStaticMarkup(<TaskRunState change={CHANGE} task={t} />);
    expect(html).toContain(T.taskState["pr-open"]!);
    expect(html).toContain('href="#/todo"');
    expect(html).not.toContain("manual://");
    const real = renderToStaticMarkup(
      <TaskRunState
        change={CHANGE}
        task={task("1.1", {
          state: "pr-open",
          level: "draft",
          branch: "b",
          pr: { number: 3, url: "https://git.example.com/forge/pull/3" },
          notes: [],
        })}
      />,
    );
    expect(real).toContain('href="https://git.example.com/forge/pull/3"');
    expect(real).toContain(T.taskPrNumber(3));
  });

  it("a task that never ran, or is ticked done, says nothing more", () => {
    expect(renderToStaticMarkup(<TaskRunState change={CHANGE} task={task("1.2")} />)).toBe("");
    expect(
      renderToStaticMarkup(<TaskRunState change={CHANGE} task={{ ...built("1.1"), done: true }} />),
    ).toBe("");
  });

  it("Run with AI is the step only before a run, or after one that stopped", () => {
    expect(runIsTheStep(task("1.2"))).toBe(true);
    expect(runIsTheStep(built("1.1"))).toBe(false);
    expect(
      runIsTheStep(task("1.3", { state: "needs-person", level: "draft", branch: "b", notes: [] })),
    ).toBe(true);
    expect(isManualLink("manual://git-host/x/pull/1")).toBe(true);
    expect(isManualLink("https://git.example.com/x/pull/1")).toBe(false);
  });

  it("AI task runs counts the task runs only, not the critics' and stages' runs", () => {
    const runs = [
      { agent: "safe-critic" },
      { agent: "story-writer-flows" },
      { agent: "task-runner" },
      { agent: "task-runner-fix", taskRun: {} },
    ];
    expect(taskRunsOnly(runs).map((r) => r.agent)).toEqual(["task-runner", "task-runner-fix"]);
  });
});

const COCKPIT: Api.ChangeCockpitT = {
  id: CHANGE,
  state: "build",
  nextStep: 'Ready to raise "Raise PR".',
  next: {
    step: "task",
    command: `atticus task run ${CHANGE} 1.1`,
    slash: `/atticus-task ${CHANGE} 1.1`,
    why: `Task 1.1 of ${CHANGE} in forge-ledger-core is the first one not done.`,
  },
  reasons: [],
  risk: { level: "medium", score: 4 },
  stages: [],
  openQuestions: 0,
  repos: [],
};

describe("At a glance's next step after a task's draft", () => {
  it("finds the drafted task, and the first one not run yet", () => {
    const tasks = [built("1.1"), task("1.2"), task("1.3")];
    const n = taskNext(COCKPIT.next!.command, tasks)!;
    expect(n.task.id).toBe("1.1");
    expect(n.then?.id).toBe("1.2");
    expect(taskNext(COCKPIT.next!.command, [task("1.1"), task("1.2")])).toBeUndefined();
    expect(taskNext(`atticus change handoff ${CHANGE} --approve`, tasks)).toBeUndefined();
  });

  it("says the PR is the step, offers it, and gives the next task's command instead of 1.1's", () => {
    const html = renderToStaticMarkup(
      <CockpitView c={COCKPIT} tasks={[built("1.1"), task("1.2"), task("1.3")]} />,
    );
    expect(html).toContain(esc(C.taskDrafted("1.1")));
    expect(html).toContain(esc(T.raiseTaskPr));
    expect(html).toContain(esc(C.thenTask("1.2")));
    expect(html).toContain(`atticus task run ${CHANGE} 1.2`);
    expect(html).not.toContain(`atticus task run ${CHANGE} 1.1`);
    expect(html).not.toContain("is the first one not done");
  });

  it("is unchanged while the named task hasn't run", () => {
    const html = renderToStaticMarkup(<CockpitView c={COCKPIT} tasks={[task("1.1")]} />);
    expect(html).toContain(`atticus task run ${CHANGE} 1.1`);
    expect(html).not.toContain(esc(T.raiseTaskPr));
  });

  it("a hand-off next step has Raise hand-off beside its command", () => {
    const html = renderToStaticMarkup(
      <CockpitView
        c={{
          ...COCKPIT,
          state: "define",
          next: {
            step: "handoff",
            command: `atticus change handoff ${CHANGE} --approve`,
            why: "The define gate passes: raise its hand-off.",
          },
        }}
      />,
    );
    expect(html).toContain(T.raiseHandOff);
    expect(html).toContain(esc(C.raiseHere));
  });

  it("a repo's PR on a manual Git host points to Manual steps, not a manual:// link", () => {
    const html = renderToStaticMarkup(
      <CockpitView
        c={{
          ...COCKPIT,
          repos: [
            {
              id: "forge-gq",
              branch: `change/${CHANGE}`,
              base: "main",
              pr: "manual://git-host/forge/forge-gq/pull/2",
            },
          ],
        }}
      />,
    );
    expect(html).toContain('href="#/todo"');
    expect(html).not.toContain("manual://");
  });
});
