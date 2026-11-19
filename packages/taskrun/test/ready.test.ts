import { describe, expect, it } from "vitest";
import { planReadyTasks, type ReadyInput } from "../src/index.js";

/**
 * ADR 0201 decision 3, waves: a task that says `(after <task id>)` in tasks.md is held, across
 * repos, until each task it names is ticked. An id that names no task, and tasks that name each
 * other, are never ready. The invented Forge repos; pure, no files.
 */

const task = (id: string, repo: string, o: Partial<ReadyInput> = {}): ReadyInput => ({
  id,
  repo,
  done: false,
  stories: [],
  ...o,
});

describe("waves: (after …) across repos", () => {
  // Wave 1: the event's publisher and the infrastructure. Wave 2: its reader, in a third repo.
  const waves = (done: string[] = []) => [
    task("t1", "forge-orders", { done: done.includes("t1") }),
    task("t2", "forge-infra", { done: done.includes("t2") }),
    task("t3", "forge-ledger", { after: ["t1", "t2"] }),
  ];

  it("holds the second wave until every task it names is ticked", () => {
    const first = planReadyTasks({ tasks: waves(), stories: [] });
    expect(first.ready).toEqual(["t1", "t2"]);
    expect(first.tasks.find((t) => t.id === "t3")).toEqual({
      id: "t3",
      repo: "forge-ledger",
      ready: false,
      waitsFor: ["t1", "t2"],
      why: "it waits for tasks t1, t2 (after) to be done first",
    });
    const half = planReadyTasks({ tasks: waves(["t1"]), stories: [] });
    expect(half.ready).toEqual(["t2"]);
    expect(half.tasks.find((t) => t.id === "t3")?.why).toBe(
      "it waits for task t2 (after) to be done first",
    );
    expect(planReadyTasks({ tasks: waves(["t1", "t2"]), stories: [] }).ready).toEqual(["t3"]);
  });

  it("puts a task after every task it names in the run order, whatever the repos' order", () => {
    const p = planReadyTasks({
      tasks: waves(),
      stories: [],
      repoOrder: ["forge-ledger", "forge-infra", "forge-orders"],
    });
    expect(p.tasks.map((t) => t.id)).toEqual(["t2", "t1", "t3"]);
    expect(p.ready).toEqual(["t2", "t1"]);
  });

  it("names the story and same-repo tasks it waits for as before, then the (after) ones", () => {
    const p = planReadyTasks({
      tasks: [
        task("t1", "forge-orders"),
        task("t2", "forge-ledger"),
        task("t3", "forge-ledger", { after: ["t1", "t2"] }),
      ],
      stories: [],
    });
    expect(p.tasks.find((t) => t.id === "t3")).toEqual({
      id: "t3",
      repo: "forge-ledger",
      ready: false,
      waitsFor: ["t1", "t2"],
      sameRepo: ["t2"],
      why: "it waits for tasks t2 (same repo), t1 (after) to be done first",
    });
  });

  it("is never ready when it names a task tasks.md doesn't have", () => {
    const p = planReadyTasks({
      tasks: [
        task("t1", "forge-orders", { done: true }),
        task("t3", "forge-ledger", { after: ["t1", "t9"] }),
      ],
      stories: [],
    });
    expect(p.ready).toEqual([]);
    expect(p.tasks[0]!.why).toBe("it names task t9 in (after …), which tasks.md doesn't have");
  });

  it("is never ready when it and another task each wait for the other", () => {
    const p = planReadyTasks({
      tasks: [
        task("t1", "forge-orders"),
        task("t4", "forge-ledger", { after: ["t5"] }),
        task("t5", "forge-infra", { after: ["t4"] }),
      ],
      stories: [],
    });
    expect(p.ready).toEqual(["t1"]);
    expect(p.tasks.find((t) => t.id === "t4")?.why).toBe(
      "it and task t5 each wait for the other in (after …)",
    );
    expect(p.tasks.find((t) => t.id === "t5")?.why).toBe(
      "it and task t4 each wait for the other in (after …)",
    );
    // A longer ring is named whole, and a task outside it that names one of them only waits.
    const ring = planReadyTasks({
      tasks: [
        task("a", "forge-orders", { after: ["c"] }),
        task("b", "forge-ledger", { after: ["a"] }),
        task("c", "forge-infra", { after: ["b"] }),
        task("d", "forge-web", { after: ["c"] }),
      ],
      stories: [],
    });
    expect(ring.ready).toEqual([]);
    expect(ring.tasks.find((t) => t.id === "a")?.why).toBe(
      "it and tasks b, c each wait for the other in (after …)",
    );
    expect(ring.tasks.find((t) => t.id === "d")?.why).toBe(
      "it waits for task c (after) to be done first",
    );
  });

  it("leaves [P] as it was: the [P] tasks of a repo go together, after what is before them", () => {
    const tasks = [
      task("t1", "forge-orders"),
      task("t2", "forge-orders", { parallel: true }),
      task("t3", "forge-orders", { parallel: true }),
      task("t4", "forge-ledger", { parallel: true, after: ["t2"] }),
    ];
    expect(planReadyTasks({ tasks, stories: [] }).ready).toEqual(["t1"]);
    const next = planReadyTasks({
      tasks: [{ ...tasks[0]!, done: true }, ...tasks.slice(1)],
      stories: [],
    });
    expect(next.ready).toEqual(["t2", "t3"]);
    expect(next.tasks.find((t) => t.id === "t4")?.why).toBe(
      "it waits for task t2 (after) to be done first",
    );
  });
});
