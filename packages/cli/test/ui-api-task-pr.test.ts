import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MockGitHost } from "@maycombhq/adapters";
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
});
