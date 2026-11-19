import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readChangeFiles } from "@maycombhq/naysayer";
import { loadTask, readChangeTasks } from "../src/index.js";
import { CHANGE, speckitRoot } from "./helpers.js";

/**
 * ADR 0201 decisions 3 and 4. A task line may end `(after <task id>[, <task id>])`, the last
 * bracket on the line, after `(story …)` when both are there: readChangeTasks reads it into
 * `after` and leaves it out of the title. A task under a repo no manifest lists is refused with
 * what to do next. The invented Forge repos; no network.
 */

const TASKS = [
  "# Tasks",
  "",
  "## forge-orders",
  "",
  "- [ ] t1 Publish the shipped event",
  "- [x] t2 [P] Name the topic in the config (story s1-ship) (after t1)",
  "",
  "## forge-ledger",
  "",
  "- [ ] t3 Read the shipped event (after T1, t2)",
  "- [ ] t4 Say why (after all) it is late",
  "",
].join("\n");

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("readChangeTasks reads (after …)", () => {
  it("into after, out of the title, with the story bracket and [P] as before", async () => {
    dir = await mkdtemp(join(tmpdir(), "atticus-waves-"));
    await writeFile(join(dir, "tasks.md"), TASKS);
    const tasks = readChangeTasks(await readChangeFiles(dir));
    expect(tasks).toEqual([
      {
        id: "t1",
        repo: "forge-orders",
        title: "Publish the shipped event",
        stories: [],
        line: 5,
        done: false,
      },
      {
        id: "t2",
        repo: "forge-orders",
        title: "[P] Name the topic in the config",
        stories: ["s1-ship"],
        line: 6,
        done: true,
        parallel: true,
        after: ["t1"],
      },
      {
        id: "t3",
        repo: "forge-ledger",
        title: "Read the shipped event",
        stories: [],
        line: 10,
        done: false,
        after: ["t1", "t2"],
      },
      // Only the last bracket on the line is read: one in the middle is the task's own words.
      {
        id: "t4",
        repo: "forge-ledger",
        title: "Say why (after all) it is late",
        stories: [],
        line: 11,
        done: false,
      },
    ]);
  });
});

describe("where (after …) may sit, and what is only a task's words", () => {
  const read = async (lines: string[]) => {
    dir = await mkdtemp(join(tmpdir(), "atticus-waves-"));
    await writeFile(join(dir, "tasks.md"), ["## forge-orders", ...lines, ""].join("\n"));
    return readChangeTasks(await readChangeFiles(dir)).map((t) => ({
      id: t.id,
      title: t.title,
      stories: t.stories,
      ...(t.after ? { after: t.after } : {}),
    }));
  };

  it("is read wherever it sits among the line's last brackets", async () => {
    expect(
      await read([
        "- [ ] t1 Publish the event",
        "- [ ] t2 Name the topic",
        "- [ ] t3 Read the event (after t1) (story s1-ship)",
        "- [ ] t4 Show the date (story s1-ship) (after t1 and t2).",
        "- [ ] t5 Keep the date (after t1, t2, and t3)",
      ]),
    ).toEqual([
      { id: "t1", title: "Publish the event", stories: [] },
      { id: "t2", title: "Name the topic", stories: [] },
      { id: "t3", title: "Read the event", stories: ["s1-ship"], after: ["t1"] },
      { id: "t4", title: "Show the date", stories: ["s1-ship"], after: ["t1", "t2"] },
      { id: "t5", title: "Keep the date", stories: [], after: ["t1", "t2", "t3"] },
    ]);
  });

  it("leaves a title that only ends in (after <words>) alone; an id tasks.md lacks is still a wave", async () => {
    expect(
      await read([
        "- [ ] t1 Publish the event",
        "- [ ] t2 Tell the depot (after lunch)",
        "- [ ] t3 Tell the carrier (after t1 and lunch)",
        // Shaped like a task id (it has a digit), so run-ready says tasks.md doesn't have it.
        "- [ ] t4 Read the event (after t9)",
      ]),
    ).toEqual([
      { id: "t1", title: "Publish the event", stories: [] },
      { id: "t2", title: "Tell the depot (after lunch)", stories: [] },
      { id: "t3", title: "Tell the carrier (after t1 and lunch)", stories: [] },
      { id: "t4", title: "Read the event", stories: [], after: ["t9"] },
    ]);
  });
});

describe("a task under a repo no manifest lists", () => {
  it("is refused with the command that adds the repo, or the heading to fix", async () => {
    const { root } = await speckitRoot({ repos: ["forge-ledger"] });
    dir = root;
    await mkdir(join(root, "openspec/changes", CHANGE), { recursive: true });
    await appendFile(
      join(root, "openspec/changes", CHANGE, "tasks.md"),
      "\n## forge-storefront\n\n- [ ] 9.1 Start the storefront\n",
    );
    await expect(loadTask(root, CHANGE, "9.1", { needApprovedDesign: false })).rejects.toThrow(
      "Task 9.1 is under forge-storefront, which no repos.manifest.yaml lists. If the repo is new, create it on your Git host, then add it: atticus repo add <its clone URL> --id forge-storefront. If the name is a slip, fix the heading in tasks.md.",
    );
  }, 180_000);
});
