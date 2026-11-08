import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "@maycombhq/server";
import { uiRoutes } from "../src/ui-api.js";
import { taskRun } from "../src/run-commands.js";
import { CHANGE, git, speckitRoot } from "./run-helpers.js";

/**
 * A run's view says where its task stands (API 2.61.0, review round 22): Run with AI on a task
 * shows the task run's state, worktree and notes beside the run's own state.
 */
let srv: RunningServer | undefined;
afterAll(() => srv?.close());

describe("GET /api/changes/{id}/runs with a task run", () => {
  it("gives each run of a task its task run: state, branch, worktree and notes", async () => {
    const { root } = await speckitRoot({ repos: ["forge-ledger"] });
    const out: string[] = [];
    expect(
      await taskRun(
        root,
        CHANGE,
        "1.3",
        { by: "dev", level: "draft", mode: "hand-off" },
        { out: (l) => out.push(l), err: (l) => out.push(l) },
        { git, now: () => new Date("2026-10-21T09:00:00Z") },
      ),
    ).toBe(0);
    const runId = /atticus handoff done (run-[0-9a-z-]+)$/.exec(out[0]!)![1]!;
    srv = await startServer({ root, port: 0, user: "pat", extend: (r, ctx) => uiRoutes(r, ctx) });
    const r = await fetch(`${srv.url}/api/changes/${CHANGE}/runs`, {
      headers: { "X-Atticus-Token": srv.token },
    });
    expect(r.status).toBe(200);
    const runs = (await r.json()) as { runId: string; taskRun?: Record<string, unknown> }[];
    const run = runs.find((x) => x.runId === runId)!;
    expect(run.taskRun).toMatchObject({
      task: "1.3",
      repo: "forge-ledger",
      level: "draft",
      state: "waiting",
      branch: `task/${CHANGE}/1.3`,
      worktree: `workspace/.worktrees/${CHANGE}/.tasks/1.3/forge-ledger`,
    });
  }, 120_000);
});

describe("POST /api/runs/{runId}/done on a task run", () => {
  it("builds and commits; a failing build is 422 with its words, and a second click meanwhile 409", async () => {
    const { root } = await speckitRoot({ repos: ["forge-ledger"] });
    const out: string[] = [];
    const now = () => new Date("2026-10-21T09:00:00Z");
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
    let pass = false;
    const commands = async () => {
      await new Promise((r) => setTimeout(r, 300));
      return pass
        ? { exitCode: 0, stdout: "ok", stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "Velocity.java:1: error" };
    };
    const s2 = await startServer({
      root,
      port: 0,
      user: "pat",
      extend: (r, ctx) => uiRoutes(r, ctx, { taskRun: { commands, git } }),
    });
    try {
      const done = () =>
        fetch(`${s2.url}/api/runs/${runId}/done`, {
          method: "POST",
          headers: { "X-Atticus-Token": s2.token, "Content-Type": "application/json" },
          body: "{}",
        });
      const [first, second] = await Promise.all([done(), done()]);
      expect([first.status, second.status].sort()).toEqual([409, 422]);
      const failed = [first, second].find((x) => x.status === 422)!;
      expect(JSON.stringify(await failed.json())).toContain("The build still fails");
      pass = true;
      const ok = await done();
      expect(ok.status).toBe(200);
    } finally {
      await s2.close();
    }
  }, 120_000);
});
