import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { MockGitHost } from "@maycombhq/adapters";
import { MockRuntime, type AiRequest, type HeadlessInvocation } from "@maycombhq/ai";
import { RunSummary } from "@maycombhq/core";
import {
  cancelTaskRunWait,
  completeTaskHandoff,
  previewTaskRun,
  isTaskRun,
  parseAnswer,
  readTaskRun,
  runTask,
  type CommandRunner,
} from "../src/index.js";
import { CHANGE, git, sh, speckitRoot } from "./helpers.js";

const T = 120_000;
const NOW = new Date("2026-10-21T09:00:00Z");
const now = () => NOW;
const APPROVAL = { by: "dev", at: "2026-10-21T09:00:00Z", ref: "task 1.2 PR" };
const FILE = "src/main/java/forge/ledger/TransferLimits.java";

const answer = (body: string) =>
  `I added the limit check.\n\n=== file: ${FILE}\npackage forge.ledger;\n\nclass TransferLimits {\n  ${body}\n}\n=== end file\n`;

/** A build that passes once TransferLimits.java has no "TODO". */
function fakeBuild(log: string[] = []): CommandRunner {
  return async (command, cwd) => {
    log.push(command);
    const text = await readFile(join(cwd, FILE), "utf8").catch(() => "");
    return text.includes("TODO") || !text
      ? { exitCode: 1, stdout: "", stderr: `${FILE}:4: error: TODO is not code` }
      : { exitCode: 0, stdout: "BUILD OK", stderr: "" };
  };
}

const paths = (root: string) => ({
  task: (rel: string) => join(root, "openspec/changes", CHANGE, "tasks/1.2", rel),
  wt: join(root, "workspace/.worktrees", CHANGE, ".tasks/1.2/forge-ledger"),
});

describe("Run with AI: plan only", () => {
  it(
    "writes the task's plan into the change and records the run summary (C5)",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      const seen: AiRequest[] = [];
      const runtime = new MockRuntime(
        (r) => {
          seen.push(r);
          return "## Steps\n\n1. Add TransferLimits.\n";
        },
        { now },
      );
      const r = await runTask(root, CHANGE, "1.2", {
        level: "plan",
        by: "dev",
        runtime,
        git,
        now,
        commands: fakeBuild(),
      });
      expect(r).toMatchObject({
        state: "planned",
        level: "plan",
        runtime: "mock",
        engine: "speckit",
        branch: "task/add-transfer-limit/1.2",
      });
      expect(r.notes[0]).toMatch(
        /^Handed the task down first \(specs\/1.2 in forge-ledger, commit [0-9a-f]{12}\)\.$/,
      );
      expect(await readFile(paths(root).task("plan.md"), "utf8")).toBe(
        "## Steps\n\n1. Add TransferLimits.\n",
      );
      const summary = RunSummary.parse(
        parse(await readFile(paths(root).task(`runs/${r.runs[0]}.yaml`), "utf8")),
      );
      expect(summary).toMatchObject({
        agent: "task-runner",
        runtime: "mock",
        state: "validated",
        output: "tasks/1.2/plan.md",
      });
      // The handed-down feature and the design reach the AI as data; the instructions are trusted.
      const prompt = seen[0]!.pack.prompt;
      expect(prompt).toContain("## Plan only");
      expect(prompt).toContain('<atticus-data id="repo:specs/1.2/plan.md"');
      expect(prompt).toContain('<atticus-data id="stories/s1-refuse-over-limit.md"');
      expect(prompt).toContain("## Skill: Write a Forge database migration");
      expect(sh(paths(root).wt, "status", "--porcelain")).toBe("");
    },
    T,
  );
});

describe("Run with AI: draft", () => {
  it(
    "changes code on the task branch, fixes a failing build, and commits once it passes",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      const builds: string[] = [];
      const runtime = new MockRuntime(
        (r) =>
          r.pack.prompt.includes("## Fix the build")
            ? answer("boolean allows() { return true; }")
            : answer("// TODO"),
        { now },
      );
      const r = await runTask(root, CHANGE, "1.2", {
        level: "draft",
        by: "dev",
        runtime,
        git,
        now,
        commands: fakeBuild(builds),
      });
      expect(r.state).toBe("built");
      expect(builds).toEqual(["forge build && forge test", "forge build && forge test"]);
      expect(r.attempts.map((a) => [a.n, a.passed, a.fixRun !== undefined])).toEqual([
        [1, false, false],
        [2, true, true],
      ]);
      expect(r.runs).toHaveLength(2);
      expect(await readFile(join(root, r.attempts[0]!.log), "utf8")).toContain("TODO is not code");
      expect(r.changed).toEqual([FILE]);
      const wt = paths(root).wt;
      expect(sh(wt, "rev-parse", "--abbrev-ref", "HEAD")).toBe("task/add-transfer-limit/1.2");
      expect(sh(wt, "log", "-1", "--format=%s")).toBe(
        "Check the limit in the transfer transaction, with tests (task 1.2 of add-transfer-limit)",
      );
      expect(sh(wt, "log", "-1", "--format=%b")).toContain("Requested-By: dev");
      expect(r.commit).toBe(sh(wt, "rev-parse", "HEAD"));
      expect(await readFile(paths(root).task("report.md"), "utf8")).toContain(
        "I added the limit check.",
      );
      expect(await readTaskRun(root, CHANGE, "1.2")).toEqual(r);
    },
    T,
  );

  it(
    "stops after the allowed fix rounds and hands to a person, every attempt recorded",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      const runtime = new MockRuntime(() => answer("// TODO"), { now });
      const r = await runTask(root, CHANGE, "1.2", {
        level: "draft",
        by: "dev",
        runtime,
        git,
        now,
        commands: fakeBuild(),
      });
      expect(r.state).toBe("needs-person");
      expect(r.attempts).toHaveLength(4);
      expect(r.attempts.every((a) => !a.passed)).toBe(true);
      expect(r.runs).toHaveLength(4);
      expect(r.notes.at(-1)).toMatch(
        /^The build still fails after 3 fix rounds; a person takes over in workspace\/.worktrees\/add-transfer-limit\/.tasks\/1.2\/forge-ledger\./,
      );
      expect(r.commit).toBeUndefined();
    },
    T,
  );

  it(
    "does nothing more once Atticus is stopped during the build: no fix round, no commit",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      let asked = 0;
      const runtime = new MockRuntime(
        () => {
          asked++;
          return answer("// TODO");
        },
        { now },
      );
      const r = await runTask(root, CHANGE, "1.2", {
        level: "draft",
        by: "dev",
        runtime,
        git,
        now,
        commands: async () => ({ exitCode: null, stdout: "", stderr: "", stopped: true }),
      });
      expect(asked).toBe(1); // the task's own answer, and no fix round after the stop
      expect(r.attempts).toHaveLength(1);
      expect(r.state).toBe("needs-person");
      expect(r.notes.at(-1)).toMatch(
        /^Atticus was stopped while the build ran, so nothing more was done; a person takes over in workspace\/.worktrees\/add-transfer-limit\/.tasks\/1.2\/forge-ledger\./,
      );
      expect(r.commit).toBeUndefined();
    },
    T,
  );

  it(
    "refuses an answer that writes outside the repo or into Git's files",
    async () => {
      expect(parseAnswer("=== file: ../escape.txt\nx\n=== end file\n").problems).toEqual([
        "../escape.txt leaves the repo",
      ]);
      expect(parseAnswer("=== file: .git/config\nx\n=== end file\n").problems).toEqual([
        ".git/config is Git's own data",
      ]);
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      const runtime = new MockRuntime(() => "=== file: /etc/passwd\nx\n=== end file\n", { now });
      const r = await runTask(root, CHANGE, "1.2", {
        level: "draft",
        by: "dev",
        runtime,
        git,
        now,
        commands: fakeBuild(),
      });
      expect(r.state).toBe("failed");
      expect(r.notes.at(-1)).toBe(
        "The answer was not applied: /etc/passwd is not a relative path inside the repo.",
      );
    },
    T,
  );

  it(
    "says when a repo has no build command, and won't open a PR without one",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      const manifest = join(root, "org-pack/profiles/forge/repos.manifest.yaml");
      await writeFile(
        manifest,
        (await readFile(manifest, "utf8")).replace("    build: forge build && forge test\n", ""),
      );
      const runtime = new MockRuntime(() => answer("boolean ok;"), { now });
      const draft = await runTask(root, CHANGE, "1.2", {
        level: "draft",
        by: "dev",
        runtime,
        git,
        now,
        commands: fakeBuild(),
      });
      expect(draft.state).toBe("unverified");
      expect(draft.notes).toContain(
        "forge-ledger has no build command in repos.manifest.yaml, so the change wasn't built or tested.",
      );
      const pr = await runTask(root, CHANGE, "1.2", {
        level: "pr",
        by: "dev",
        approval: APPROVAL,
        runtime: new MockRuntime(() => answer("boolean ok2;"), { now }),
        git,
        now,
        commands: fakeBuild(),
        gitHost: new MockGitHost([{ repo: "forge-ledger" }]),
      });
      expect(pr.state).toBe("needs-person");
      expect(pr.pr).toBeUndefined();
    },
    T,
  );
});

describe("Run with AI: pr", () => {
  it(
    "pushes the task branch with the person's approval and opens a PR into the change branch",
    async () => {
      const { root, remotes } = await speckitRoot({ repos: ["forge-ledger"] });
      const host = new MockGitHost([{ repo: "forge-ledger" }]);
      const runtime = new MockRuntime(() => answer("boolean allows() { return true; }"), { now });
      const r = await runTask(root, CHANGE, "1.2", {
        level: "pr",
        by: "dev",
        approval: APPROVAL,
        runtime,
        git,
        now,
        commands: fakeBuild(),
        gitHost: host,
      });
      expect(r.state).toBe("pr-open");
      expect(r.pr).toEqual({ number: 1, url: "https://git.example.com/forge-ledger/pull/1" });
      const call = host.journal.find((j) => j.method === "createPullRequest")!;
      expect(call.approval).toMatchObject({ by: "dev", ref: "task 1.2 PR" });
      expect(call.args[0]).toMatchObject({
        head: "task/add-transfer-limit/1.2",
        base: "change/add-transfer-limit",
      });
      expect(sh(remotes["forge-ledger"]!, "rev-parse", "task/add-transfer-limit/1.2")).toBe(
        r.commit,
      );
      // Nothing went to main.
      expect(sh(remotes["forge-ledger"]!, "log", "-1", "--format=%s", "main")).toBe("initial");
    },
    T,
  );

  it(
    "refuses without approval, into a protected branch, and above the repo's autonomy cap",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      const runtime = new MockRuntime(() => answer("boolean allows() { return true; }"), { now });
      await expect(
        runTask(root, CHANGE, "1.2", {
          level: "pr",
          by: "dev",
          runtime,
          git,
          now,
          commands: fakeBuild(),
        }),
      ).rejects.toThrow(
        /needs the person's yes: ask them to run it with --approve \(an assistant never approves a push\)/,
      );
      const host = new MockGitHost([
        { repo: "forge-ledger", protectedBranches: ["main", "change/add-transfer-limit"] },
      ]);
      // Refused at the push: the drafted, committed work is kept and the task is a person's.
      const prot = await runTask(root, CHANGE, "1.2", {
        level: "pr",
        by: "dev",
        approval: APPROVAL,
        runtime,
        git,
        now,
        commands: fakeBuild(),
        gitHost: host,
      });
      expect(prot.state).toBe("needs-person");
      expect(prot.notes.at(-1)).toMatch(
        /^change\/add-transfer-limit is protected in forge-ledger; Run with AI never pushes to or opens a PR into a protected branch\. — the work is in workspace\/.worktrees\//,
      );
      const rt = join(root, "org-pack/runtime.yaml");
      await writeFile(
        rt,
        (await readFile(rt, "utf8")).replace("forge-reports-job: draft", "forge-ledger: plan-only"),
      );
      await expect(
        runTask(root, CHANGE, "1.2", { level: "draft", by: "dev", runtime, git, now }),
      ).rejects.toThrow(
        "forge-ledger allows Run with AI up to plan-only (runtime.yaml autonomy.capPerRepo); ask for a lower level.",
      );
      // No level asked: runtime.yaml's default is lowered to the cap, and the task plans.
      const planned = await runTask(root, CHANGE, "1.2", { by: "dev", runtime, git, now });
      expect(planned).toMatchObject({ level: "plan", state: "planned" });
    },
    T,
  );
});

describe("Run with AI: hand-off and headless modes", () => {
  it(
    "hand-off: writes the prompt and waits; atticus handoff done builds, commits and finishes",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      const r = await runTask(root, CHANGE, "1.2", {
        level: "draft",
        mode: "hand-off",
        by: "dev",
        git,
        now,
        commands: fakeBuild(),
      });
      expect(r).toMatchObject({ state: "waiting", runtime: "hand-off" });
      const runId = r.waiting!;
      expect(await isTaskRun(root, runId)).toBe(true);
      const prompt = await readFile(join(root, ".runs", CHANGE, runId, "prompt.md"), "utf8");
      expect(prompt).toContain(
        "Make the changes in workspace/.worktrees/add-transfer-limit/.tasks/1.2/forge-ledger (branch task/add-transfer-limit/1.2) only",
      );
      expect(
        prompt.trimEnd().endsWith(`When you are done, run: atticus handoff done ${runId}`),
      ).toBe(true);
      expect(existsSync(join(root, ".runs", CHANGE, runId, "context-manifest.json"))).toBe(true);

      // The person's assistant does a first, broken attempt.
      const wt = paths(root).wt;
      await writeFile(join(wt, FILE), "class TransferLimits { // TODO }\n");
      await writeFile(paths(root).task("report.md"), "Added TransferLimits.\n");
      const first = await completeTaskHandoff(root, runId, { git, now, commands: fakeBuild() });
      expect(first.state).toBe("waiting");
      expect(first.attempts).toHaveLength(1);
      // Then fixes it.
      await writeFile(join(wt, FILE), "class TransferLimits { boolean ok; }\n");
      const second = await completeTaskHandoff(root, runId, { git, now, commands: fakeBuild() });
      expect(second.state).toBe("built");
      expect(second.attempts.map((a) => a.passed)).toEqual([false, true]);
      expect(second.changed).toEqual([FILE]);
      expect(sh(wt, "log", "-1", "--format=%s")).toBe(
        "Check the limit in the transfer transaction, with tests (task 1.2 of add-transfer-limit)",
      );
      expect(await isTaskRun(root, runId)).toBe(false);
      await expect(completeTaskHandoff(root, runId, { git, now })).rejects.toThrow(
        `No task run is waiting on ${runId}.`,
      );
    },
    T,
  );

  it(
    "hand-off: a build stopped by Ctrl+C isn't a failed attempt; the run waits for Done again",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      const r = await runTask(root, CHANGE, "1.2", {
        level: "draft",
        mode: "hand-off",
        by: "dev",
        git,
        now,
        commands: fakeBuild(),
      });
      const runId = r.waiting!;
      await writeFile(join(paths(root).wt, FILE), "class TransferLimits { boolean ok; }\n");
      await writeFile(paths(root).task("report.md"), "Added TransferLimits.\n");
      const stopped = await completeTaskHandoff(root, runId, {
        git,
        now,
        commands: async () => ({ exitCode: null, stdout: "", stderr: "", stopped: true }),
      });
      expect(stopped).toMatchObject({ state: "waiting", waiting: runId });
      expect(stopped.attempts).toHaveLength(0);
      expect(stopped.commit).toBeUndefined();
      expect(stopped.notes.at(-1)).toBe(
        `Atticus was stopped while it checked the work, so nothing more was done; run atticus handoff done ${runId} again.`,
      );
      // Done again, not stopped: built and committed.
      const again = await completeTaskHandoff(root, runId, { git, now, commands: fakeBuild() });
      expect(again.state).toBe("built");
      expect(again.attempts.map((a) => a.passed)).toEqual([true]);
    },
    T,
  );

  it(
    "hand-off: a second run of a task that waits is refused, so the first one's Done still builds",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      const opts = {
        level: "draft" as const,
        mode: "hand-off" as const,
        by: "dev",
        git,
        now,
        commands: fakeBuild(),
      };
      const first = await runTask(root, CHANGE, "1.2", opts);
      await expect(runTask(root, CHANGE, "1.2", opts)).rejects.toThrow(
        `Task 1.2 already waits on your assistant (run ${first.waiting}, in workspace/.worktrees/add-transfer-limit/.tasks/1.2/forge-ledger): finish it with atticus handoff done ${first.waiting}, or cancel that run (AI runs, Cancel) and run the task again.`,
      );
      expect(await isTaskRun(root, first.waiting!)).toBe(true);
      // Cancelled (the app's Cancel): the task run ends, said so, and the task can run again.
      const cancelled = await cancelTaskRunWait(root, first.waiting!, { by: "pat", now });
      expect(cancelled).toMatchObject({ state: "failed" });
      expect(cancelled!.notes.at(-1)).toBe(
        `Run ${first.waiting} was cancelled by pat, so nothing more was done; run the task again.`,
      );
      const again = await runTask(root, CHANGE, "1.2", opts);
      expect(again.waiting).not.toBe(first.waiting);
    },
    T,
  );

  it(
    "hand-off: Done before the report is written waits for it, using nothing up; a cancelled run says so",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      const r = await runTask(root, CHANGE, "1.2", {
        level: "draft",
        mode: "hand-off",
        by: "dev",
        git,
        now,
        commands: fakeBuild(),
      });
      const runId = r.waiting!;
      await writeFile(join(paths(root).wt, FILE), "class TransferLimits { boolean ok; }\n");
      // The assistant ran Done before it wrote the report.
      const early = await completeTaskHandoff(root, runId, { git, now, commands: fakeBuild() });
      expect(early).toMatchObject({ state: "waiting", waiting: runId });
      expect(early.attempts).toHaveLength(0);
      expect(early.notes.at(-1)).toMatch(
        new RegExp(`: write it, then run atticus handoff done ${runId} again\\.$`),
      );
      // The dry run sees the waiting task too.
      await expect(previewTaskRun(root, CHANGE, "1.2")).rejects.toThrow(
        /already waits on your assistant/,
      );
      await writeFile(paths(root).task("report.md"), "Added TransferLimits.\n");
      // Cancelled in the app's run.json meanwhile: refused in words, not a transition error.
      const file = join(root, ".runs", CHANGE, runId, "run.json");
      const was = await readFile(file, "utf8");
      await writeFile(file, JSON.stringify({ ...JSON.parse(was), state: "cancelled" }));
      await expect(
        completeTaskHandoff(root, runId, { git, now, commands: fakeBuild() }),
      ).rejects.toThrow(
        `Run ${runId} was cancelled; run the task again (atticus task run ${CHANGE} 1.2).`,
      );
      await writeFile(file, was);
      const done = await completeTaskHandoff(root, runId, { git, now, commands: fakeBuild() });
      expect(done.state).toBe("built");
    },
    T,
  );

  it(
    "hand-off: a commit that fails after the answer is validated ends the task for a person, never stuck",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      const r = await runTask(root, CHANGE, "1.2", {
        level: "draft",
        mode: "hand-off",
        by: "dev",
        git,
        now,
        commands: fakeBuild(),
      });
      const runId = r.waiting!;
      await writeFile(join(paths(root).wt, FILE), "class TransferLimits { boolean ok; }\n");
      await writeFile(paths(root).task("report.md"), "Added TransferLimits.\n");
      const hooked: typeof git = async (args, cwd) => {
        if (args[0] === "commit") throw new Error("pre-commit hook failed: checkstyle");
        return git(args, cwd);
      };
      const out = await completeTaskHandoff(root, runId, {
        git: hooked,
        now,
        commands: fakeBuild(),
      });
      expect(out.state).toBe("needs-person");
      expect(out.notes.at(-1)).toMatch(/^pre-commit hook failed: checkstyle — the work is in /);
      expect(await isTaskRun(root, runId)).toBe(false);
      // The task can run again.
      const again = await runTask(root, CHANGE, "1.2", {
        level: "draft",
        mode: "hand-off",
        by: "dev",
        git,
        now,
        commands: fakeBuild(),
      });
      expect(again.state).toBe("waiting");
    },
    T,
  );

  it(
    "hand-off: two Dones at once build once; the other is refused while the first runs",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      const r = await runTask(root, CHANGE, "1.2", {
        level: "draft",
        mode: "hand-off",
        by: "dev",
        git,
        now,
        commands: fakeBuild(),
      });
      const runId = r.waiting!;
      await writeFile(join(paths(root).wt, FILE), "class TransferLimits { boolean ok; }\n");
      await writeFile(paths(root).task("report.md"), "Added TransferLimits.\n");
      let builds = 0;
      const slow: CommandRunner = async (cmd, cwd, o) => {
        builds++;
        await new Promise((res) => setTimeout(res, 300));
        return fakeBuild()(cmd, cwd, o);
      };
      const [a, b] = await Promise.allSettled([
        completeTaskHandoff(root, runId, { git, now, commands: slow }),
        completeTaskHandoff(root, runId, { git, now, commands: slow }),
      ]);
      expect(builds).toBe(1);
      const ok = [a, b].filter((x) => x.status === "fulfilled");
      const no = [a, b].filter((x) => x.status === "rejected") as PromiseRejectedResult[];
      expect(ok).toHaveLength(1);
      expect((ok[0] as PromiseFulfilledResult<{ state: string }>).value.state).toBe("built");
      expect(String(no[0]!.reason)).toMatch(
        /Another run of task 1.2 of add-transfer-limit is running/,
      );
    },
    T,
  );

  it(
    "says what a run would do without doing it: the default level from runtime.yaml, and the cap",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      const p = await previewTaskRun(root, CHANGE, "1.2");
      expect(p).toMatchObject({
        change: CHANGE,
        task: "1.2",
        repo: "forge-ledger",
        branch: "task/add-transfer-limit/1.2",
      });
      expect(["plan", "draft", "pr"]).toContain(p.level);
      expect(existsSync(paths(root).wt)).toBe(false);
      await expect(previewTaskRun(root, CHANGE, "9.9")).rejects.toThrow();
    },
    T,
  );

  it(
    "headless Claude Code: runs claude -p in the task worktree (fake runner) and builds what it changed",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      const seen: HeadlessInvocation[] = [];
      const r = await runTask(root, CHANGE, "1.2", {
        level: "draft",
        mode: "headless-claude-code",
        by: "dev",
        git,
        now,
        commands: fakeBuild(),
        runtimeOptions: {
          headless: {
            runner: async (i) => {
              seen.push(i);
              await writeFile(join(i.cwd, FILE), "class TransferLimits { boolean ok; }\n");
              return {
                exitCode: 0,
                stdout: JSON.stringify({ result: "Added TransferLimits.", is_error: false }),
                stderr: "",
              };
            },
          },
        },
      });
      expect(r).toMatchObject({ state: "built", runtime: "headless-claude-code", changed: [FILE] });
      expect(seen[0]!.cwd).toBe(paths(root).wt);
      expect(seen[0]!.env).toEqual({ SPECIFY_FEATURE_DIRECTORY: "specs/1.2" });
      expect(seen[0]!.args).toContain("acceptEdits");
      expect(await readFile(paths(root).task("report.md"), "utf8")).toContain(
        "Added TransferLimits.",
      );
    },
    T,
  );
});
