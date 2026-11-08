import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MockGitHost } from "@maycombhq/adapters";
import { MockRuntime } from "@maycombhq/ai";
import { runTask } from "@maycombhq/taskrun";
import { Api } from "@maycombhq/core";
import { startServer } from "@maycombhq/server";
import { uiRoutes } from "../src/ui-api.js";
import { taskRun } from "../src/run-commands.js";
import { CHANGE, git, speckitRoot } from "./run-helpers.js";

/**
 * Sixth UX walk (API 2.69.0): the Task board says where each task's Run with AI stands, and a
 * drafted task's PR is raised from the app on the person's click, without running it again.
 */
describe("a task's run on the Task board, and its PR from the app", () => {
  it("lists the task's run state and run; Raise the task's PR opens it (201), then says it's open (422)", async () => {
    const { root } = await speckitRoot({ repos: ["forge-ledger"] });
    const now = () => new Date("2026-11-08T09:00:00Z");
    const out: string[] = [];
    await taskRun(
      root,
      CHANGE,
      "1.3",
      { by: "dev", level: "draft", mode: "hand-off" },
      { out: (l) => out.push(l), err: (l) => out.push(l) },
      { git, now },
    );
    const runId = /atticus handoff done (run-[0-9a-z-]+)$/.exec(out[0]!)![1]!;
    await writeFile(join(root, "openspec/changes", CHANGE, "tasks/1.3/report.md"), "Did it.\n");
    // The assistant's change in the task's worktree, which Done commits.
    await writeFile(
      join(root, "workspace/.worktrees", CHANGE, ".tasks/1.3/forge-ledger/VELOCITY.md"),
      "Velocity check.\n",
    );
    const commands = async () => ({ exitCode: 0, stdout: "ok", stderr: "" });
    const host = new MockGitHost([{ repo: "forge-ledger" }]);
    const srv = await startServer({
      root,
      port: 0,
      user: "pat",
      extend: (r, ctx) => uiRoutes(r, ctx, { gitHost: host, taskRun: { commands, git } }),
    });
    const call = (path: string, method = "GET") =>
      fetch(`${srv.url}${path}`, {
        method,
        headers: { "X-Atticus-Token": srv.token, "Content-Type": "application/json" },
        ...(method === "POST" ? { body: "{}" } : {}),
      });
    try {
      // Before Done, the task waits on the person's assistant, and names its run.
      let tasks = z
        .array(Api.Task)
        .parse(await (await call(`/api/changes/${CHANGE}/tasks`)).json());
      expect(tasks.find((t) => t.id === "1.3")).toMatchObject({
        run: runId,
        taskRun: { state: "waiting", level: "draft", branch: `task/${CHANGE}/1.3` },
      });
      // A task that never ran has no taskRun.
      expect(tasks.find((t) => t.id === "1.2")?.taskRun).toBeUndefined();
      expect((await call(`/api/runs/${runId}/done`, "POST")).status).toBe(200);
      tasks = z.array(Api.Task).parse(await (await call(`/api/changes/${CHANGE}/tasks`)).json());
      const built = tasks.find((t) => t.id === "1.3")!;
      expect(built.taskRun?.state).toBe("built");
      expect(built.taskRun?.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(built.done).toBe(false);

      const raised = await call(`/api/changes/${CHANGE}/tasks/1.3/pr`, "POST");
      expect(raised.status).toBe(201);
      const t = Api.Task.parse(await raised.json());
      expect(t.taskRun).toMatchObject({ state: "pr-open", pr: { number: 1 } });
      expect(t.taskRun?.notes.join(" ")).toContain("PR raised by pat");

      const again = await call(`/api/changes/${CHANGE}/tasks/1.3/pr`, "POST");
      expect(again.status).toBe(422);
      expect(JSON.stringify(await again.json())).toContain("Task 1.3's PR is already open");
      // One that hasn't run, and one that isn't a task.
      const early = await call(`/api/changes/${CHANGE}/tasks/1.2/pr`, "POST");
      expect(early.status).toBe(422);
      expect(JSON.stringify(await early.json())).toContain("Task 1.2 hasn't been drafted yet");
      expect((await call(`/api/changes/${CHANGE}/tasks/9.9/pr`, "POST")).status).toBe(404);
    } finally {
      await srv.close();
    }
  }, 120_000);

  it("says a PR that couldn't be opened (422), keeps the task built with why, and raises it on the next click", async () => {
    const { root } = await speckitRoot({ repos: ["forge-ledger"] });
    const now = () => new Date("2026-11-08T09:00:00Z");
    const file = "src/main/java/forge/ledger/TransferLimits.java";
    await runTask(root, CHANGE, "1.2", {
      level: "draft",
      by: "dev",
      runtime: new MockRuntime(
        () =>
          `Done.\n\n=== file: ${file}\npackage forge.ledger;\n\nclass TransferLimits { boolean ok; }\n=== end file\n`,
        { now },
      ),
      git,
      now,
      commands: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
    });
    const host = new MockGitHost([{ repo: "forge-ledger" }]);
    host.failNext("unavailable", "createPullRequest");
    const srv = await startServer({
      root,
      port: 0,
      user: "pat",
      extend: (r, ctx) => uiRoutes(r, ctx, { gitHost: host, taskRun: { git } }),
    });
    const call = (path: string, method = "GET") =>
      fetch(`${srv.url}${path}`, {
        method,
        headers: { "X-Atticus-Token": srv.token, "Content-Type": "application/json" },
        ...(method === "POST" ? { body: "{}" } : {}),
      });
    try {
      const failed = await call(`/api/changes/${CHANGE}/tasks/1.2/pr`, "POST");
      expect(failed.status).toBe(422);
      expect(JSON.stringify(await failed.json())).toContain("The PR wasn't raised:");
      const tasks = z
        .array(Api.Task)
        .parse(await (await call(`/api/changes/${CHANGE}/tasks`)).json());
      const t = tasks.find((x) => x.id === "1.2")!;
      expect(t.taskRun?.state).toBe("built");
      expect(t.taskRun?.notes.at(-1)).toMatch(/^The PR wasn't raised: .*raise the task's PR again/);
      const raised = await call(`/api/changes/${CHANGE}/tasks/1.2/pr`, "POST");
      expect(raised.status).toBe(201);
      expect(Api.Task.parse(await raised.json()).taskRun).toMatchObject({ state: "pr-open" });
    } finally {
      await srv.close();
    }
  }, 120_000);

  it("says a raised PR's state from the Git host, and runs the task again from the app once it is closed (review round 43)", async () => {
    const { root } = await speckitRoot({ repos: ["forge-ledger"] });
    const now = () => new Date("2026-11-08T09:00:00Z");
    const file = "src/main/java/forge/ledger/TransferLimits.java";
    await runTask(root, CHANGE, "1.2", {
      level: "draft",
      by: "dev",
      runtime: new MockRuntime(
        () =>
          `Done.\n\n=== file: ${file}\npackage forge.ledger;\n\nclass TransferLimits { boolean ok; }\n=== end file\n`,
        { now },
      ),
      git,
      now,
      commands: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
    });
    const host = new MockGitHost([{ repo: "forge-ledger" }]);
    const srv = await startServer({
      root,
      port: 0,
      user: "pat",
      extend: (r, ctx) => uiRoutes(r, ctx, { gitHost: host, taskRun: { git } }),
    });
    const call = (path: string, method = "GET", body: unknown = {}) =>
      fetch(`${srv.url}${path}`, {
        method,
        headers: { "X-Atticus-Token": srv.token, "Content-Type": "application/json" },
        ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
      });
    const task12 = async () =>
      z
        .array(Api.Task)
        .parse(await (await call(`/api/changes/${CHANGE}/tasks`)).json())
        .find((t) => t.id === "1.2")!;
    const runIt = () =>
      call(`/api/changes/${CHANGE}/runs`, "POST", {
        agent: "task-runner",
        task: "1.2",
        runtime: "hand-off",
      });
    try {
      expect((await call(`/api/changes/${CHANGE}/tasks/1.2/pr`, "POST")).status).toBe(201);
      expect((await task12()).taskRun?.pr).toMatchObject({ number: 1, state: "open" });
      // The app's Run with AI (no level) is refused while the PR is open, and says so: never
      // that no Git host is connected.
      const held = await runIt();
      expect(held.status).toBe(409);
      const said = JSON.stringify(await held.json());
      expect(said).toContain("Task 1.2's PR is open");
      expect(said).not.toContain("no Git host is connected");
      // A host that can't say leaves the recorded state: the PR open, its state not said.
      host.failNext("unavailable", "getPullRequest");
      const unknown = await task12();
      expect(unknown.taskRun?.state).toBe("pr-open");
      expect(unknown.taskRun?.pr).toBeDefined();
      expect(unknown.taskRun?.pr?.state).toBeUndefined();
      // Closed on the host: the board hears it, and Run with AI runs the task again.
      await host.closePullRequest("forge-ledger", 1, {
        by: "pat",
        at: "2026-11-08T09:00:00Z",
        ref: "closed on the host",
      });
      expect((await task12()).taskRun?.pr).toMatchObject({ number: 1, state: "closed" });
      expect((await runIt()).status).toBe(201);
      const t = await task12();
      expect(t.taskRun?.state).toBe("waiting");
      expect(t.taskRun?.notes).toContain(
        "Its earlier PR https://git.example.com/forge-ledger/pull/1 is closed.",
      );
    } finally {
      await srv.close();
    }
  }, 120_000);
});
