import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileStepStore, MockGitHost, recordStep } from "@maycombhq/adapters";
import { MockRuntime } from "@maycombhq/ai";
import { setTaskDone } from "@maycombhq/speckit";
import { readTaskRun, runTask, settleTaskPr, TaskRunError } from "../src/index.js";
import { CHANGE, git, sh, speckitRoot, worktree } from "./helpers.js";

/**
 * Seventh UX walk (tasks and manual steps): a task's PR as the person recorded it on a manual
 * Git host, the task ticked in tasks.md once its PR merged, and a task branch cut from the change
 * branch as the host has it (with the tasks merged before it).
 */

const T = 180_000;
const now = () => new Date("2026-11-08T09:00:00Z");
const APPROVAL = { by: "dev", at: "2026-11-08T09:00:00Z", ref: "task (seventh UX walk)" };
const ok = async () => ({ exitCode: 0, stdout: "BUILD OK", stderr: "" });
const LIMITS = "src/main/java/forge/ledger/TransferLimits.java";
const RULES = "src/main/java/forge/ledger/LimitRules.java";

const answer = (file: string, body: string) =>
  new MockRuntime(() => `Done.\n\n=== file: ${file}\n${body}\n=== end file\n`, { now });

async function manualRoot() {
  const r = await speckitRoot({ repos: ["forge-ledger"] });
  const rt = join(r.root, "org-pack/runtime.yaml");
  const text = await readFile(rt, "utf8");
  await writeFile(rt, text.replace("gitHost: { type: mock }", "gitHost: { type: manual }"));
  return r;
}

const tasksMd = (root: string) =>
  readFile(join(root, "openspec/changes", CHANGE, "tasks.md"), "utf8");

describe("a task's PR on a manual Git host, and its tick", () => {
  it(
    "takes the recorded number and link into task-run.yaml, and ticks the task once it merged",
    async () => {
      const { root } = await manualRoot();
      const r = await runTask(root, CHANGE, "1.2", {
        level: "pr",
        by: "dev",
        approval: APPROVAL,
        runtime: answer(LIMITS, "class TransferLimits {}"),
        git,
        now,
        commands: ok,
      });
      expect(r.pr).toEqual({ number: 1, url: "manual://git-host/forge-ledger/pull/1" });
      const store = fileStepStore(root);
      const open = (await store.list({ action: "open-pull-request" }))[0]!;
      await recordStep(store, open.id, {
        by: "dev",
        values: { url: "https://git.forge.example/forge/forge-ledger/pull/7", number: "7" },
      });
      expect(await settleTaskPr(root, CHANGE, "1.2", { now })).toEqual({ state: "open" });
      expect((await readTaskRun(root, CHANGE, "1.2"))?.pr).toEqual({
        number: 7,
        url: "https://git.forge.example/forge/forge-ledger/pull/7",
      });
      expect(await tasksMd(root)).toContain("- [ ] 1.2 Check the limit");

      const report = (await store.list({ action: "report-pull-request" }))[0]!;
      expect(report.id).toBe("report-pr-task-add-transfer-limit-1-2");
      await recordStep(store, report.id, {
        by: "dev",
        values: { approvers: "tia", checksPassing: "yes", merged: "yes" },
      });
      expect(await settleTaskPr(root, CHANGE, "1.2", { now })).toEqual({
        state: "merged",
        ticked: true,
      });
      const md = await tasksMd(root);
      expect(md).toContain("- [x] 1.2 Check the limit");
      expect(md).toContain("- [ ] 1.1 Add V3__add_daily_limit.sql");
      const rec = await readTaskRun(root, CHANGE, "1.2");
      expect(rec?.ticked).toBe("2026-11-08T09:00:00Z");
      expect(rec?.notes.at(-1)).toBe(
        "Ticked 1.2 in tasks.md: PR #7 merged on the Git host. The tick rides the change's build hand-off.",
      );
      // A person who unticks it keeps it unticked: Atticus ticks a task once.
      expect(await setTaskDone(root, CHANGE, "1.2", false)).toBe(true);
      expect(await settleTaskPr(root, CHANGE, "1.2", { now })).toEqual({ state: "merged" });
      expect(await tasksMd(root)).toContain("- [ ] 1.2 Check the limit");
    },
    T,
  );

  it("ticks and unticks one line of tasks.md and leaves the rest as it is", async () => {
    const { root } = await speckitRoot({ repos: ["forge-ledger"], open: false });
    const path = join(root, "openspec/changes", CHANGE, "tasks.md");
    const before = (await readFile(path, "utf8")).replace(/\n/g, "\r\n");
    await writeFile(path, before);
    expect(await setTaskDone(root, CHANGE, "2.1", true)).toBe(true);
    expect(await setTaskDone(root, CHANGE, "2.1", true)).toBe(false);
    const after = await readFile(path, "utf8");
    expect(after).toBe(before.replace("- [ ] 2.1 Expose", "- [x] 2.1 Expose"));
    expect(await setTaskDone(root, CHANGE, "2.1", false)).toBe(true);
    expect(await readFile(path, "utf8")).toBe(before);
    expect(await setTaskDone(root, CHANGE, "9.9", true)).toBe(false);
  });
});

describe("a task branch is cut from the change branch as the Git host has it", () => {
  /** Merge the task's branch into the change branch on the bare remote, as a host's merge does. */
  async function mergeOnHost(remote: string, task: string) {
    const c = await mkdtemp(join(tmpdir(), "atticus-host-"));
    sh(c, "clone", "-q", remote, "w");
    const w = join(c, "w");
    sh(w, "checkout", "-q", `change/${CHANGE}`);
    sh(w, "merge", "-q", "--no-ff", "-m", `Merge task ${task}`, `origin/task/${CHANGE}/${task}`);
    sh(w, "push", "-q", "origin", `change/${CHANGE}`);
  }

  it(
    "fast-forwards the local change branch to the merged one first, so the next task has its code",
    async () => {
      const { root, remotes } = await speckitRoot({ repos: ["forge-ledger"] });
      const host = new MockGitHost([{ repo: "forge-ledger" }]);
      const first = await runTask(root, CHANGE, "1.2", {
        level: "pr",
        by: "dev",
        approval: APPROVAL,
        runtime: answer(LIMITS, "class TransferLimits {}"),
        git,
        gitHost: host,
        now,
        commands: ok,
      });
      expect(first.state).toBe("pr-open");
      await mergeOnHost(remotes["forge-ledger"]!, "1.2");
      const next = await runTask(root, CHANGE, "1.3", {
        level: "draft",
        by: "dev",
        runtime: answer(RULES, "class LimitRules {}"),
        git,
        now,
        commands: ok,
      });
      expect(next.state).toBe("built");
      // 1.2's file is in 1.3's worktree, and the change worktree moved on too.
      const wt = join(root, next.worktree);
      await expect(readFile(join(wt, LIMITS), "utf8")).resolves.toContain("TransferLimits");
      await expect(
        readFile(join(worktree(root, "forge-ledger"), LIMITS), "utf8"),
      ).resolves.toContain("TransferLimits");
      expect(next.notes.join(" ")).toContain(
        `Brought change/${CHANGE} in forge-ledger up to the Git host's first (the tasks merged into it there).`,
      );
    },
    T,
  );

  /** Squash-merge the task's branch into the change branch on the bare remote, as a host may. */
  async function squashOnHost(remote: string, task: string) {
    const c = await mkdtemp(join(tmpdir(), "atticus-host-"));
    sh(c, "clone", "-q", remote, "w");
    const w = join(c, "w");
    sh(w, "checkout", "-q", `change/${CHANGE}`);
    sh(w, "merge", "-q", "--squash", `origin/task/${CHANGE}/${task}`);
    sh(w, "commit", "-q", "-m", `Task ${task} (squashed)`);
    sh(w, "push", "-q", "origin", `change/${CHANGE}`);
  }

  it(
    "review round 44: with squash merges, every later task still catches up (hand-downs the host has)",
    async () => {
      const { root, remotes } = await speckitRoot({ repos: ["forge-ledger"] });
      const remote = remotes["forge-ledger"]!;
      const host = new MockGitHost([{ repo: "forge-ledger" }]);
      const pr = (task: string, file: string, body: string) =>
        runTask(root, CHANGE, task, {
          level: "pr",
          by: "dev",
          approval: APPROVAL,
          runtime: answer(file, body),
          git,
          gitHost: host,
          now,
          commands: ok,
        });
      expect((await pr("1.2", LIMITS, "class TransferLimits {}")).state).toBe("pr-open");
      await squashOnHost(remote, "1.2");
      expect((await pr("1.3", RULES, "class LimitRules {}")).state).toBe("pr-open");
      await squashOnHost(remote, "1.3");
      const third = await runTask(root, CHANGE, "1.1", {
        level: "draft",
        by: "dev",
        runtime: answer("src/main/resources/db/migration/V3__add_daily_limit.sql", "-- limit"),
        git,
        now,
        commands: ok,
      });
      expect(third.state).toBe("built");
      // The third task starts from both squashed tasks, and the local change branch is the host's
      // plus only the third task's hand-down: nothing was pushed over the host's.
      const wt = join(root, third.worktree);
      await expect(readFile(join(wt, LIMITS), "utf8")).resolves.toContain("TransferLimits");
      await expect(readFile(join(wt, RULES), "utf8")).resolves.toContain("LimitRules");
      const cw = worktree(root, "forge-ledger");
      const onHost = sh(cw, "rev-parse", `origin/change/${CHANGE}`);
      expect(sh(cw, "rev-parse", "HEAD~1")).toBe(onHost);
      expect(sh(cw, "log", "-1", "--format=%s")).toMatch(/^Hand down task 1\.1 of /);
      expect(sh(remote, "rev-parse", `change/${CHANGE}`)).toBe(onHost);
      expect(third.notes.join(" ")).toContain(
        `Brought change/${CHANGE} in forge-ledger up to the Git host's first`,
      );
    },
    T,
  );

  it(
    "review round 44: still refuses when a local hand-down's files differ from the host's",
    async () => {
      const { root, remotes } = await speckitRoot({ repos: ["forge-ledger"] });
      const host = new MockGitHost([{ repo: "forge-ledger" }]);
      await runTask(root, CHANGE, "1.2", {
        level: "pr",
        by: "dev",
        approval: APPROVAL,
        runtime: answer(LIMITS, "class TransferLimits {}"),
        git,
        gitHost: host,
        now,
        commands: ok,
      });
      await squashOnHost(remotes["forge-ledger"]!, "1.2");
      // Task 1.3 handed down and drafted, never raised: its hand-down isn't on the host; then
      // something else merges there.
      const cw = worktree(root, "forge-ledger");
      await runTask(root, CHANGE, "1.3", {
        level: "draft",
        by: "dev",
        runtime: answer(RULES, "class LimitRules {}"),
        git,
        now,
        commands: ok,
      });
      const c = await mkdtemp(join(tmpdir(), "atticus-host-"));
      sh(c, "clone", "-q", remotes["forge-ledger"]!, "w");
      const w = join(c, "w");
      sh(w, "checkout", "-q", `change/${CHANGE}`);
      sh(w, "commit", "-q", "--allow-empty", "-m", "Another task merged");
      sh(w, "push", "-q", "origin", `change/${CHANGE}`);
      const local = sh(cw, "rev-parse", "HEAD");
      const err = await runTask(root, CHANGE, "1.1", {
        level: "draft",
        by: "dev",
        runtime: answer("src/main/resources/db/migration/V3__add_daily_limit.sql", "-- limit"),
        git,
        now,
        commands: ok,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TaskRunError);
      expect((err as Error).message).toMatch(/has commits the Git host's hasn't/);
      expect(sh(cw, "rev-parse", "HEAD")).toBe(local);
    },
    T,
  );

  it(
    "refuses, never rewriting it, when the local change branch has commits the host's hasn't",
    async () => {
      const { root, remotes } = await speckitRoot({ repos: ["forge-ledger"] });
      const host = new MockGitHost([{ repo: "forge-ledger" }]);
      await runTask(root, CHANGE, "1.2", {
        level: "pr",
        by: "dev",
        approval: APPROVAL,
        runtime: answer(LIMITS, "class TransferLimits {}"),
        git,
        gitHost: host,
        now,
        commands: ok,
      });
      await mergeOnHost(remotes["forge-ledger"]!, "1.2");
      const cw = worktree(root, "forge-ledger");
      sh(cw, "commit", "-q", "--allow-empty", "-m", "A local commit");
      const local = sh(cw, "rev-parse", "HEAD");
      const err = await runTask(root, CHANGE, "1.3", {
        level: "draft",
        by: "dev",
        runtime: answer(RULES, "class LimitRules {}"),
        git,
        now,
        commands: ok,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TaskRunError);
      expect((err as Error).message).toBe(
        `change/${CHANGE} in forge-ledger has commits the Git host's hasn't, and the host's has commits it hasn't (tasks merged there): Atticus doesn't rewrite it. Merge origin/change/${CHANGE} into it in workspace/.worktrees/${CHANGE}/forge-ledger (or push it), then run task 1.3 again.`,
      );
      expect(sh(cw, "rev-parse", "HEAD")).toBe(local);
    },
    T,
  );
});
