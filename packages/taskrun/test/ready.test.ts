import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planReadyTasks, previewTaskRun, runTask, type ReadyInput } from "../src/index.js";
import { CHANGE, git, speckitRoot } from "./helpers.js";

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

describe("waves: what holds a task for ever is named", () => {
  it("names a ring made of (after …) and the order of a repo's tasks", () => {
    // t1 names t2, and t2 comes after t1 in their repo: neither can go first.
    const p = planReadyTasks({
      tasks: [task("t1", "forge-orders", { after: ["t2"] }), task("t2", "forge-orders")],
      stories: [],
    });
    expect(p.ready).toEqual([]);
    expect(p.tasks.map((t) => [t.id, t.why])).toEqual([
      ["t1", "it and task t2 each wait for the other, by (after …) and by their order in tasks.md"],
      ["t2", "it and task t1 each wait for the other, by (after …) and by their order in tasks.md"],
    ]);
    // Across repos too: t3 (after t2), t2 after t1 in its repo, t1 (after t3).
    const three = planReadyTasks({
      tasks: [
        task("t1", "forge-orders", { after: ["t3"] }),
        task("t2", "forge-orders"),
        task("t3", "forge-ledger", { after: ["t2"] }),
      ],
      stories: [],
    });
    expect(three.ready).toEqual([]);
    expect(three.tasks.find((t) => t.id === "t2")?.why).toBe(
      "it and tasks t1, t3 each wait for the other, by (after …) and by their order in tasks.md",
    );
    // [P] tasks of a repo don't wait for each other, so naming one of them is no ring.
    const together = planReadyTasks({
      tasks: [
        task("t1", "forge-orders", { parallel: true, after: ["t2"] }),
        task("t2", "forge-orders", { parallel: true }),
      ],
      stories: [],
    });
    expect(together.ready).toEqual(["t2"]);
  });

  it("says a task id used twice, rather than the last one winning", () => {
    const p = planReadyTasks({
      tasks: [
        task("t1", "forge-orders"),
        task("t1", "forge-ledger"),
        task("t2", "forge-infra", { after: ["t1"] }),
      ],
      stories: [],
    });
    expect(p.ready).toEqual([]);
    expect(p.tasks.map((t) => [t.id, t.repo, t.why])).toEqual([
      ["t1", "forge-orders", "its id t1 is used twice in tasks.md: give each task its own id"],
      ["t1", "forge-ledger", "its id t1 is used twice in tasks.md: give each task its own id"],
      ["t2", "forge-infra", "it waits for task t1 (after) to be done first"],
    ]);
  });
});

describe("atticus task run of a task held by (after …)", () => {
  // ADR 0210 part 7: a task waiting on tasks it names goes ahead when a person runs it, with that
  // as an open item; one whose (after …) can never be met (tasks.md to fix) is still refused.
  it("is refused when tasks.md can never let it run, and goes ahead naming what isn't ticked; a task that only comes later in its repo runs as before", async () => {
    const { root } = await speckitRoot({ repos: ["forge-ledger"] });
    const file = join(root, "openspec/changes", CHANGE, "tasks.md");
    const text = await readFile(file, "utf8");
    await writeFile(
      file,
      text
        .replace(
          "- [ ] 1.1 Add V3__add_daily_limit.sql (story s1-refuse-over-limit)",
          "- [ ] 1.1 Add V3__add_daily_limit.sql (story s1-refuse-over-limit) (after 1.3)",
        )
        .replace(
          "with tests (story s4-velocity-check)",
          "with tests (story s4-velocity-check) (after 7.7)",
        ),
    );
    const held =
      "Task 1.1 isn't ready: it and tasks 1.2, 1.3 each wait for the other, by (after …) and by their order in tasks.md. Fix tasks.md, then run it again.";
    await expect(previewTaskRun(root, CHANGE, "1.1")).rejects.toMatchObject({
      code: "refused",
      message: held,
    });
    await expect(runTask(root, CHANGE, "1.1", { by: "ari", git })).rejects.toMatchObject({
      code: "refused",
      message: held,
    });
    await expect(previewTaskRun(root, CHANGE, "1.3")).rejects.toMatchObject({
      message:
        "Task 1.3 isn't ready: it names task 7.7 in (after …), which tasks.md doesn't have. Fix tasks.md, then run it again.",
    });
    // Held by a named task that isn't ticked: the words say which to tick.
    await writeFile(
      file,
      text.replace(
        "- [ ] 2.1 Expose the remaining limit, with tests (story s2-show-remaining)",
        "- [ ] 2.1 Expose the remaining limit, with tests (story s2-show-remaining) (after 1.1)",
      ),
    );
    expect((await previewTaskRun(root, CHANGE, "2.1")).openItems).toEqual([
      "Open item: task 2.1 runs before what it names in (after …): it waits for task 1.1 (after) to be done first.",
    ]);
    // 1.2 comes after 1.1 in its repo and names nothing: a person may still run it by itself.
    expect((await previewTaskRun(root, CHANGE, "1.2")).task).toBe("1.2");
  }, 180_000);
});
