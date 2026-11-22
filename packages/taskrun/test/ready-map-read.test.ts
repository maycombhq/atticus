import { describe, expect, it } from "vitest";
import { planReadyTasks, readsIntoMap, type ReadyInput } from "../src/index.js";

/**
 * The persona check of beta.30: the spec writer wrote "Read the repo into facts: /atticus-map …"
 * as a task, which Run all ready tasks scheduled as a coding task run and conform marked not
 * checkable. Reading a repo into the map is a person's step, never a task run, so such a task is
 * never ready, with why. The invented Forge repos; pure, no files.
 */

const task = (
  id: string,
  repo: string,
  title: string,
  o: Partial<ReadyInput> = {},
): ReadyInput => ({
  id,
  repo,
  title,
  done: false,
  stories: [],
  ...o,
});

/** The repos the estate knows here: the tasks' own, tasks.md's headings and the manifests'. */
const REPOS = new Set(["forge-audit", "forge-svc-04", "forge-deploy", "forge-svc-01"]);
const reads = (t: string) => readsIntoMap(t, REPOS);

describe("a task that reads a repo into the map", () => {
  it("is told by its words, naming a repo the estate knows", () => {
    for (const t of [
      "Read the repo into facts: /atticus-map forge-audit, then atticus verify forge-audit --write",
      "Read forge-svc-04 into the map before its move",
      "Run atticus verify forge-svc-04 --write",
      "Read forge-audit into facts",
      "Read `forge-svc-04` into its facts first",
      "/atticus-map forge-deploy",
      "Run atticus map forge-svc-04",
      // The form the app suggests for a repo not read (ui-api-links).
      "Run atticus map --all --repos forge-svc-04",
      "atticus map --all --repos forge-svc-01,forge-audit",
    ])
      expect(reads(t), t).toBe(true);
  });

  it("is not told by words that only look like it (the reviews)", () => {
    for (const t of [
      "Handle the refund kind on forge.items.settled",
      "Read the settled event and post the entry",
      "Add the map of currencies to the ledger",
      "Read the currency rows into the map of rates before posting",
      "Read the YAML into map entries keyed by id",
      "read the config and put it into the map",
      "Read the settlement file into facts table forge_facts",
      "Document atticus verify usage for ops",
      "Read forge-svc-01 into the map of rates",
      "Run atticus map --help and note the flags",
      "Mention /atticus-map in the runbook",
      // A file, a table, a topic or a version is no repo (the second review).
      "Read config.json into the map",
      "Read settings.yml into the map before startup",
      "Read rates.yaml into the facts table",
      "Read ledger_rows into facts",
      "Read forge.items.settled into the map",
      "Read v1.2 into the facts",
      // Shaped like a repo, but no repo the estate knows.
      "Read forge-rates into the map",
      "Run atticus map forge-rates",
    ])
      expect(reads(t), t).toBe(false);
  });

  it("is never ready, and says it is a person's step; the repo's next task waits for it", () => {
    const plan = planReadyTasks({
      tasks: [
        task(
          "t1",
          "forge-audit",
          "Read the repo into facts: /atticus-map forge-audit, then atticus verify forge-audit --write",
        ),
        task("t2", "forge-audit", "Handle the refund kind on forge.items.settled"),
        task("t3", "forge-svc-01", "Publish each settled refund"),
      ],
      stories: [],
    });
    expect(plan.ready).toEqual(["t3"]);
    expect(plan.tasks.find((t) => t.id === "t1")!.why).toBe(
      "it reads a repo into the map, which a person does (/atticus-map <repo>, then atticus verify <repo> --write), never a task run: once it is read, tick the task in tasks.md, or take it out and say it above the tasks",
    );
    expect(plan.tasks.find((t) => t.id === "t2")!.why).toBe(
      "it waits for task t1 (same repo) to be done first",
    );
    // Ticked, it holds nothing.
    const after = planReadyTasks({
      tasks: [
        task("t1", "forge-audit", "Read forge-audit into the map", { done: true }),
        task("t2", "forge-audit", "Handle the refund kind"),
      ],
      stories: [],
    });
    expect(after.ready).toEqual(["t2"]);
  });
});

describe("the repos it knows", () => {
  it("are the tasks' own and the manifests' repos the ready list is given", () => {
    const tasks = [
      task("t1", "forge-svc-01", "Read forge-deploy into the map before the move"),
      task("t2", "forge-svc-01", "Read forge-rates into the map"),
    ];
    const without = planReadyTasks({ tasks, stories: [] });
    expect(without.ready).toEqual(["t1"]);
    const listed = planReadyTasks({ tasks, stories: [], repos: ["forge-deploy"] });
    expect(listed.tasks.find((t) => t.id === "t1")!.ready).toBe(false);
    // t2 names no repo the estate knows: work, and waits only for t1 in its repo.
    expect(listed.tasks.find((t) => t.id === "t2")!.why).toBe(
      "it waits for task t1 (same repo) to be done first",
    );
  });
});
