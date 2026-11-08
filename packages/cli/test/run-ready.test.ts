import { afterAll, describe, expect, it } from "vitest";
import { Api } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { uiRoutes } from "../src/ui-api.js";
import { readyLines, taskRunReady } from "../src/run-ready-commands.js";
import { CHANGE, git, speckitRoot } from "./run-helpers.js";

/**
 * ADR 0181 part 4: Run all ready tasks, from the command line and the Task board. The invented
 * Forge change add-transfer-limit: tasks 2.1 and 2.2 (forge-portal-bff) wait for story s1's tasks
 * 1.1 and 1.2 (forge-ledger). Hand-off mode, local bare remotes: no model, no network.
 */

const NOW = () => new Date("2026-10-21T09:00:00Z");
const T = 180_000;
let srv: RunningServer | undefined;
afterAll(() => srv?.close());

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};

describe("atticus task run-ready", () => {
  it(
    "says what is ready, previews the pr level without --approve, and does nothing",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      const r = io();
      const code = await taskRunReady(root, CHANGE, { by: "ari", level: "pr" }, r.io, {
        git,
        now: NOW,
        repoOrder: [],
      });
      expect(code).toBe(0);
      expect(r.out[0]).toBe(
        "Ready to run, in cross-repo order: 1.1 (forge-ledger), 1.2 (forge-ledger), 1.3 (forge-ledger).",
      );
      expect(r.out).toContain(
        "  Not ready: task 2.1: it waits for tasks 1.1, 1.2 to be done first.",
      );
      expect(r.out.at(-1)).toMatch(
        /^Nothing was done: run it again with --approve .*an assistant never approves a push/,
      );
    },
    T,
  );

  it(
    "runs the ready tasks in order and stops on the first that needs a person (hand-off: the assistant has it)",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      const r = io();
      const code = await taskRunReady(
        root,
        CHANGE,
        { by: "ari", level: "draft", mode: "hand-off" },
        r.io,
        { git, now: NOW, repoOrder: [] },
      );
      expect(code).toBe(1);
      expect(r.out.join("\n")).toMatch(/Handed task 1.1 to your assistant/);
      expect(r.out.at(-1)).toBe(
        `Stopped at task 1.1, which needs a person; not run yet: 1.2, 1.3. Run atticus task run-ready ${CHANGE} again once it is picked up.`,
      );
    },
    T,
  );

  it("refuses what it can't run", async () => {
    const r = io();
    expect(await taskRunReady("/nowhere", undefined, { by: "ari" }, r.io)).toBe(2);
    expect(await taskRunReady("/nowhere", CHANGE, {}, r.io)).toBe(2);
    expect(await taskRunReady("/nowhere", CHANGE, { by: "ari", level: "all" }, r.io)).toBe(2);
    expect(readyLines(CHANGE, { tasks: [], ready: [] })).toEqual([
      `Every task of ${CHANGE} is done.`,
    ]);
  });
});

describe("Run all ready tasks on the Task board (API 2.76.0)", () => {
  it(
    "lists the ready tasks, runs them as one job and says where it stopped; never the pr level",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      srv = await startServer({
        root,
        port: 0,
        user: "ari",
        watch: false,
        extend: (r, ctx) => uiRoutes(r, ctx, { taskRun: { git } }),
      });
      const call = async (method: string, path: string, body?: unknown) => {
        const res = await fetch(srv!.url + path, {
          method,
          headers: { "X-Atticus-Token": srv!.token, "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
      };
      const ready = Api.ReadyTasks.parse(
        (await call("GET", `/api/changes/${CHANGE}/tasks/ready`)).body,
      );
      expect(ready.ready).toEqual(["1.1", "1.2", "1.3"]);
      expect(ready.tasks.find((t) => t.id === "2.2")?.waitsFor).toEqual(["1.1", "1.2"]);
      // The app never asks for the pr level: that is the person's --approve elsewhere.
      expect(
        (await call("POST", `/api/changes/${CHANGE}/tasks/run-ready`, { level: "pr" })).status,
      ).toBe(400);
      const started = await call("POST", `/api/changes/${CHANGE}/tasks/run-ready`, {
        runtime: "hand-off",
      });
      expect(started.status).toBe(202);
      const accepted = Api.RunReadyAccepted.parse(started.body);
      expect(accepted.tasks).toEqual(["1.1", "1.2", "1.3"]);
      let job: { state: string; result?: unknown } | undefined;
      for (let i = 0; i < 600; i++) {
        job = (await call("GET", `/api/jobs/${accepted.jobId}`)).body as {
          state: string;
          result?: unknown;
        };
        if (job.state !== "running" && job.state !== "queued") break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(job?.state).toBe("done");
      const result = Api.RunReadyResult.parse(job?.result);
      expect(result.ran).toEqual([
        { task: "1.1", repo: "forge-ledger", state: "waiting", branch: `task/${CHANGE}/1.1` },
      ]);
      expect(result.stopped?.task).toBe("1.1");
      expect(result.left).toEqual(["1.2", "1.3"]);
      // The task with the assistant isn't ready again until its Done.
      const after = Api.ReadyTasks.parse(
        (await call("GET", `/api/changes/${CHANGE}/tasks/ready`)).body,
      );
      expect(after.ready).toEqual(["1.2", "1.3"]);
      expect(after.tasks[0]).toMatchObject({ id: "1.1", ready: false });
      // Asked for tasks that aren't ready: nothing starts.
      expect(
        (await call("POST", `/api/changes/${CHANGE}/tasks/run-ready`, { tasks: ["2.1"] })).status,
      ).toBe(422);
    },
    T,
  );
});
