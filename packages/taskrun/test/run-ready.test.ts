import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockGitHost } from "@maycombhq/adapters";
import { MockRuntime } from "@maycombhq/ai";
import {
  planReadyTasks,
  readTaskRun,
  readyTasksOf,
  runReadyTasks,
  type CommandRunner,
} from "../src/index.js";
import { CHANGE, git, sh, speckitRoot } from "./helpers.js";

/**
 * ADR 0181 part 4: Run all ready tasks. Every task whose dependencies are done runs, in the
 * cross-repo order, one task run each, and the batch stops on the first that needs a person.
 * The invented Forge change add-transfer-limit: s2 and s3 (forge-portal-bff) depend on s1
 * (forge-ledger). Local bare remotes and a mock model and Git host; no network.
 */

const T = 180_000;
const NOW = new Date("2026-10-21T09:00:00Z");
const now = () => NOW;

const STORIES = [
  { id: "s1-refuse-over-limit", dependsOn: [] },
  { id: "s2-show-remaining", dependsOn: ["s1-refuse-over-limit"] },
  { id: "s3-audit-refusals", dependsOn: ["s1-refuse-over-limit"] },
  { id: "s4-velocity-check", dependsOn: [] },
];
const TASKS = [
  { id: "1.1", repo: "forge-ledger", done: false, stories: ["s1-refuse-over-limit"] },
  { id: "1.2", repo: "forge-ledger", done: false, stories: ["s1-refuse-over-limit"] },
  { id: "1.3", repo: "forge-ledger", done: false, stories: ["s4-velocity-check"] },
  { id: "2.1", repo: "forge-portal-bff", done: false, stories: ["s2-show-remaining"] },
  { id: "2.2", repo: "forge-portal-bff", done: false, stories: ["s3-audit-refusals"] },
];

describe("which tasks are ready (pure)", () => {
  it("is every task whose stories' dependencies are done, in tasks.md order by default", () => {
    const p = planReadyTasks({ tasks: TASKS, stories: STORIES });
    // Ninth UX walk: a task waits for the earlier not-done tasks of its own repo, so 1.2 is
    // drafted from a base with 1.1's code in it.
    expect(p.ready).toEqual(["1.1"]);
    expect(p.tasks.find((t) => t.id === "1.2")).toEqual({
      id: "1.2",
      repo: "forge-ledger",
      ready: false,
      waitsFor: ["1.1"],
      sameRepo: ["1.1"],
      why: "it waits for task 1.1 (same repo) to be done first",
    });
    expect(p.tasks.find((t) => t.id === "2.1")).toEqual({
      id: "2.1",
      repo: "forge-portal-bff",
      ready: false,
      waitsFor: ["1.1", "1.2"],
      why: "it waits for tasks 1.1, 1.2 to be done first",
    });
    expect(p.tasks.find((t) => t.id === "2.2")?.why).toBe(
      "it waits for tasks 1.1, 1.2, 2.1 (same repo) to be done first",
    );
  });

  it("lets tasks.md's [P] tasks of a repo go together, after the tasks before them", () => {
    const tasks = [
      { ...TASKS[0]! },
      { ...TASKS[1]!, parallel: true },
      { ...TASKS[2]!, parallel: true },
    ];
    expect(planReadyTasks({ tasks, stories: STORIES }).ready).toEqual(["1.1"]);
    const after = planReadyTasks({
      tasks: [{ ...tasks[0]!, done: true }, ...tasks.slice(1)],
      stories: STORIES,
    });
    expect(after.ready).toEqual(["1.2", "1.3"]);
    const allP = planReadyTasks({
      tasks: tasks.map((t) => ({ ...t, parallel: true })),
      stories: STORIES,
    });
    expect(allP.ready).toEqual(["1.1", "1.2", "1.3"]);
  });

  it("follows the deployment plan's order of the repos", () => {
    const done = TASKS.map((t) =>
      t.repo === "forge-ledger" && t.id !== "1.3" ? { ...t, done: true } : t,
    );
    const p = planReadyTasks({
      tasks: done,
      stories: STORIES,
      repoOrder: ["forge-portal-bff", "forge-ledger"],
    });
    expect(p.ready).toEqual(["2.1", "1.3"]);
    // Done tasks are left out of the list; 2.2 waits for 2.1, before it in its repo.
    expect(p.tasks.map((t) => t.id)).toEqual(["2.1", "2.2", "1.3"]);
  });

  it("leaves out a task already run until its PR settles, and runs a failed one again", () => {
    const p = planReadyTasks({
      tasks: [
        { ...TASKS[0]!, state: "pr-open" },
        { ...TASKS[1]!, state: "failed", parallel: true },
        { ...TASKS[2]!, state: "pr-open", prSettled: "closed", parallel: true },
        { ...TASKS[3]!, done: false, stories: [], state: "waiting" },
      ],
      stories: STORIES,
    });
    expect(p.ready).toEqual([]);
    expect(p.tasks[0]!.why).toBe("its PR is open on the Git host");
    expect(p.tasks[1]!.why).toBe("it waits for task 1.1 (same repo) to be done first");
    expect(p.tasks[3]!.why).toBe("it is with your assistant: Done on its run carries on");
    const merged = planReadyTasks({
      tasks: [
        { ...TASKS[0]!, done: true },
        { ...TASKS[1]!, state: "failed", parallel: true },
        { ...TASKS[2]!, state: "pr-open", prSettled: "closed", parallel: true },
      ],
      stories: STORIES,
    });
    expect(merged.ready).toEqual(["1.2", "1.3"]);
  });
});

/** Mark every task of the fixture's forge-ledger [P] (Spec Kit's marker), so they go together. */
async function parallelLedger(root: string): Promise<void> {
  const p = join(root, "openspec/changes", CHANGE, "tasks.md");
  const text = await readFile(p, "utf8");
  await writeFile(p, text.replace(/^- \[ \] (1\.\d) /gm, "- [ ] $1 [P] "));
}

const FILE = "src/main/java/forge/ledger/TransferLimits.java";
const answer = (task: string) =>
  `Task ${task}.\n\n=== file: ${FILE}\npackage forge.ledger;\n\nclass TransferLimits {\n  // task ${task}\n}\n=== end file\n`;
const passing: CommandRunner = async () => ({ exitCode: 0, stdout: "BUILD OK", stderr: "" });

describe("Run all ready tasks (ADR 0181 part 4, ADR 0036)", () => {
  it(
    "drafts each ready task on its own task branch, in order, and leaves the rest waiting",
    async () => {
      const { root, remotes } = await speckitRoot({ repos: ["forge-ledger"] });
      expect((await readyTasksOf(root, CHANGE)).ready).toEqual(["1.1"]);
      await parallelLedger(root);
      const ready = await readyTasksOf(root, CHANGE);
      expect(ready.ready).toEqual(["1.1", "1.2", "1.3"]);
      const runtime = new MockRuntime(
        (r) => answer(/task (\d\.\d)/.exec(r.pack.prompt)?.[1] ?? "?"),
        { now },
      );
      const seen: string[] = [];
      const r = await runReadyTasks(root, CHANGE, {
        level: "draft",
        by: "ari",
        runtime,
        git,
        now,
        commands: passing,
        progress: (_d, _t, m) => seen.push(m),
      });
      expect(r.planned).toEqual(["1.1", "1.2", "1.3"]);
      expect(r.stopped).toBeUndefined();
      expect(
        r.ran.map((x) => ("record" in x ? [x.task, x.record.state] : [x.task, x.refused])),
      ).toEqual([
        ["1.1", "built"],
        ["1.2", "built"],
        ["1.3", "built"],
      ]);
      expect(seen).toEqual([
        "Task 1.1 on forge-ledger",
        "Task 1.2 on forge-ledger",
        "Task 1.3 on forge-ledger",
        "Done",
      ]);
      // Each on its own task branch; nothing pushed: the remote has only main.
      for (const t of ["1.1", "1.2", "1.3"])
        expect((await readTaskRun(root, CHANGE, t))?.branch).toBe(`task/${CHANGE}/${t}`);
      expect(sh(remotes["forge-ledger"]!, "branch", "--format=%(refname:short)")).toBe("main");
      // tasks.md isn't ticked by a draft: ticking stays a merge's or a person's.
      expect(await readFile(join(root, "openspec/changes", CHANGE, "tasks.md"), "utf8")).toContain(
        "- [ ] 1.1",
      );
    },
    T,
  );

  it(
    "stops on the first task that needs a person, and runs nothing after it",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      const runtime = new MockRuntime(() => answer("x"), { now });
      const failing: CommandRunner = async () => ({
        exitCode: 1,
        stdout: "",
        stderr: `${FILE}:1: error: does not compile`,
      });
      const r = await runReadyTasks(root, CHANGE, {
        level: "draft",
        by: "ari",
        runtime,
        git,
        now,
        commands: failing,
      });
      expect(r.ran.map((x) => x.task)).toEqual(["1.1"]);
      expect(r.stopped?.task).toBe("1.1");
      expect(await readTaskRun(root, CHANGE, "1.2")).toBeUndefined();
      // The task that needs a person isn't ready again until a person picks it up, and the
      // tasks after it in its repo wait for it.
      expect((await readyTasksOf(root, CHANGE)).ready).toEqual([]);
    },
    T,
  );

  it(
    "previews each ready task in a dry run and does nothing",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      await parallelLedger(root);
      const r = await runReadyTasks(root, CHANGE, {
        level: "pr",
        by: "ari",
        dryRun: true,
        gitHost: new MockGitHost(),
        git,
        now,
      });
      expect(r.ran).toEqual([]);
      expect(
        r.previews?.map((p) => ("refused" in p ? p.refused : [p.task, p.level, p.branch])),
      ).toEqual([
        ["1.1", "pr", `task/${CHANGE}/1.1`],
        ["1.2", "pr", `task/${CHANGE}/1.2`],
        ["1.3", "pr", `task/${CHANGE}/1.3`],
      ]);
      expect(await readTaskRun(root, CHANGE, "1.1")).toBeUndefined();
    },
    T,
  );

  it(
    "at the pr level, raises each PR into the change branch only with the person's approval",
    async () => {
      const { root, remotes } = await speckitRoot({ repos: ["forge-ledger"] });
      await parallelLedger(root);
      const host = new MockGitHost([{ repo: "forge-ledger" }]);
      const runtime = new MockRuntime(
        (r) => answer(/task (\d\.\d)/.exec(r.pack.prompt)?.[1] ?? "?"),
        { now },
      );
      const base = { level: "pr" as const, by: "ari", runtime, git, now, commands: passing };
      // Without the approval the task run refuses before anything is done, and the batch stops.
      const no = await runReadyTasks(root, CHANGE, { ...base, gitHost: host });
      expect(no.ran).toEqual([
        { task: "1.1", repo: "forge-ledger", refused: expect.stringMatching(/--approve/) },
      ]);
      expect(no.stopped?.task).toBe("1.1");
      expect(host.journal.filter((j) => j.method === "createPullRequest")).toEqual([]);
      const yes = await runReadyTasks(root, CHANGE, {
        ...base,
        gitHost: host,
        only: ["1.1", "1.3"],
        approval: { by: "ari", at: NOW.toISOString(), ref: "Run all ready tasks" },
      });
      expect(yes.stopped).toBeUndefined();
      expect(yes.ran.map((x) => ("record" in x ? [x.task, x.record.state] : x))).toEqual([
        ["1.1", "pr-open"],
        ["1.3", "pr-open"],
      ]);
      const prs = host.journal.filter((j) => j.method === "createPullRequest");
      expect(prs.map((j) => (j.args[0] as { head: string }).head)).toEqual([
        `task/${CHANGE}/1.1`,
        `task/${CHANGE}/1.3`,
      ]);
      expect(prs.every((j) => (j.args[0] as { base: string }).base === `change/${CHANGE}`)).toBe(
        true,
      );
      // Nothing merged, nothing on main.
      expect(host.journal.some((j) => /merge/i.test(j.method))).toBe(false);
      expect(sh(remotes["forge-ledger"]!, "log", "-1", "--format=%s", "main")).toBe("initial");
    },
    T,
  );
});
