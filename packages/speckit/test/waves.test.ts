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
