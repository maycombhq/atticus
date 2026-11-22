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

describe("a task that reads a repo into the map", () => {
  it("is told by its words", () => {
    expect(
      readsIntoMap(
        "Read the repo into facts: /atticus-map forge-audit, then atticus verify forge-audit --write",
      ),
    ).toBe(true);
    expect(readsIntoMap("Read forge-svc-04 into the map before its move")).toBe(true);
    expect(readsIntoMap("Run atticus verify forge-svc-04 --write")).toBe(true);
    expect(readsIntoMap("Handle the refund kind on forge.items.settled")).toBe(false);
    expect(readsIntoMap("Read the settled event and post the entry")).toBe(false);
    expect(readsIntoMap("Add the map of currencies to the ledger")).toBe(false);
    expect(readsIntoMap("Read forge-audit into facts")).toBe(true);
    expect(readsIntoMap("Read `forge-svc-04` into its facts first")).toBe(true);
    expect(readsIntoMap("/atticus-map forge-deploy")).toBe(true);
    expect(readsIntoMap("Run atticus map forge-svc-04")).toBe(true);
  });

  it("is not told by words that only look like it (the review)", () => {
    for (const t of [
      "Read the currency rows into the map of rates before posting",
      "Read the YAML into map entries keyed by id",
      "read the config and put it into the map",
      "Read the settlement file into facts table forge_facts",
      "Document atticus verify usage for ops",
      "Read forge-rates into the map of rates",
      "Run atticus map --help and note the flags",
      "Mention /atticus-map in the runbook",
    ])
      expect(readsIntoMap(t), t).toBe(false);
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
