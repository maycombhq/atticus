import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { COPY } from "../src/copy.js";
import type { Task } from "../src/screens/Changes.js";
import { TaskTick } from "../src/screens/know/task-pr.js";
import { TaskList } from "../src/screens/work/Stage.js";

/**
 * Seventh UX walk (API 2.72.0): a person ticks or unticks a task in tasks.md from the Task board,
 * and a task Atticus ticked because its PR merged says so.
 */
const T = COPY.phase;
const W = COPY.work;
const CHANGE = "show-an-account-s-status";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");

const task = (done: boolean, ticked?: string): Pick<Task, "id" | "done" | "taskRun"> => ({
  id: "1.1",
  done,
  ...(ticked
    ? {
        taskRun: {
          state: "pr-open",
          level: "pr",
          branch: `task/${CHANGE}/1.1`,
          ticked,
          notes: [],
        },
      }
    : {}),
});

describe("ticking a task on the Task board", () => {
  it("offers Mark done, labelled with the task, for a task not done", () => {
    const html = renderToStaticMarkup(<TaskTick change={CHANGE} task={task(false)} />);
    expect(html).toContain(esc(T.tickTask));
    expect(html).toContain(`aria-label="${esc(T.tickTaskLabel("1.1"))}"`);
    expect(html).not.toContain(esc(T.tickedByMerge));
  });

  it("offers Mark not done for a task a person ticked, without saying Atticus did", () => {
    const html = renderToStaticMarkup(<TaskTick change={CHANGE} task={task(true)} />);
    expect(html).toContain(esc(T.untickTask));
    expect(html).toContain(`aria-label="${esc(T.untickTaskLabel("1.1"))}"`);
    expect(html).not.toContain(esc(T.tickedByMerge));
  });

  it("says Atticus ticked it when its PR merged, and still lets a person untick it", () => {
    const html = renderToStaticMarkup(
      <TaskTick change={CHANGE} task={task(true, "2026-11-08T14:00:00Z")} />,
    );
    expect(html).toContain(esc(T.tickedByMerge));
    expect(html).toContain(esc(T.untickTask));
  });

  it("doesn't say Atticus ticked a task a person has since unticked", () => {
    const html = renderToStaticMarkup(
      <TaskTick change={CHANGE} task={task(false, "2026-11-08T14:00:00Z")} />,
    );
    expect(html).not.toContain(esc(T.tickedByMerge));
    expect(html).toContain(esc(T.tickTask));
  });
});

describe("a task on the Task list", () => {
  it("opens its row on the Task board, and keeps the terminal commands below", () => {
    const html = renderToStaticMarkup(
      <TaskList
        change={CHANGE}
        tasks={[{ id: "1.1", repo: "forge-ledger-core", description: "Step 1.1", done: false }]}
      />,
    );
    expect(html).toContain(`href="#/tasks?change=${CHANGE}&amp;task=1.1"`);
    expect(html).toContain(`aria-label="${esc(W.openOnBoardLabel("1.1"))}"`);
    expect(html).toContain(esc(W.runOnBoard));
    expect(html).toContain(esc(W.fromTerminal));
    expect(html.indexOf(esc(W.openOnBoard))).toBeLessThan(html.indexOf(esc(W.fromTerminal)));
  });
});
