import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { MockGitHost } from "@maycombhq/adapters";
import { MockRuntime, type AiRequest, type HeadlessInvocation } from "@maycombhq/ai";
import { RunSummary } from "@maycombhq/core";
import {
  completeTaskHandoff,
  isTaskRun,
  parseAnswer,
  readTaskRun,
  runTask,
  TaskRunError,
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
      ).rejects.toThrow(/needs your approval: run it again with --approve/);
      const host = new MockGitHost([
        { repo: "forge-ledger", protectedBranches: ["main", "change/add-transfer-limit"] },
      ]);
      const err = await runTask(root, CHANGE, "1.2", {
        level: "pr",
        by: "dev",
        approval: APPROVAL,
        runtime,
        git,
        now,
        commands: fakeBuild(),
        gitHost: host,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TaskRunError);
      expect((err as Error).message).toBe(
        "change/add-transfer-limit is protected in forge-ledger; Run with AI never pushes to or opens a PR into a protected branch.",
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
