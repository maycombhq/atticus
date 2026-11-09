import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { startServer, type RunningServer } from "@maycombhq/server";
import { extendUiRoutes } from "../src/ui-commands.js";
import { uiModelRunRoutes } from "../src/ui-api-runs.js";
import { keepResume, mapRepoOf, resumeAfterDone, resumeRefusal } from "../src/handoff-resume.js";
import { scopeDirs } from "../src/propose.js";

/**
 * ADR 0188: the app offers a button for every step in the daily path. The local steps a page
 * named as a command run here as local jobs (verify --all --write, the estate join, every wiki's
 * sync, the worktree clean-up), a task's context is given for the person's assistant, this
 * machine's recording is a toggle; the read of a repo prepared in the app is put on the map by
 * its Done (verify --write); Draft the stories again passes --force, on that step only. No
 * network: the steps here read and write the temporary metarepo only (CLAUDE.md rule 5).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge/metarepo");

let root: string;
let srv: RunningServer;
const call = async (path: string, method = "GET", body?: unknown) => {
  const r = await fetch(srv.url + path, {
    method,
    headers: {
      "X-Atticus-Token": srv.token,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  return { status: r.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
};
/** A local job followed to its end, as the app's followJob does. */
const job = async (path: string, body: unknown = {}) => {
  const started = await call(path, "POST", body);
  expect(started.status, JSON.stringify(started.body)).toBe(202);
  const id = String(started.body.jobId);
  for (let n = 0; n < 200; n++) {
    const j = await call(`/api/jobs/${id}`);
    if (j.body.state !== "running" && j.body.state !== "queued")
      return j.body as { state: string; result?: { code: number; lines: string[] } };
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`${path} didn't end`);
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-steps-"));
  await cp(join(FORGE, "org-pack"), join(root, "org-pack"), { recursive: true });
  srv = await startServer({
    root,
    port: 0,
    user: "pat",
    version: "1.0.0",
    extend: (r, ctx) => extendUiRoutes(r, ctx),
  });
});
afterAll(async () => {
  await srv?.close();
  await rm(root, { recursive: true, force: true });
});

describe("the local steps' routes", () => {
  it("runs verify --all --write as a job, saying when no repo has facts", async () => {
    const j = await job("/api/facts/apply-all");
    expect(j.result?.code).toBe(2);
    expect(j.result?.lines.join(" ")).toMatch(/No repo has facts yet/);
  });

  it("runs the estate join as a job", async () => {
    // No repo has specs here: the join says so, as `atticus estate join` does, and the job fails.
    const j = await job("/api/estate/join");
    expect(j.state).toBe("failed");
    expect(j.result?.code).not.toBe(0);
    expect(j.result?.lines.length).toBeGreaterThan(0);
  });

  it("syncs every wiki in one job", async () => {
    const j = await job("/api/knowledge/sources/sync");
    expect(Array.isArray(j.result?.lines)).toBe(true);
  });

  it("cleans up worktrees for every change, or one, and refuses a name that isn't an id", async () => {
    const all = await job("/api/workspace/prune");
    expect(all.result).toEqual({
      code: 0,
      lines: ["No change has worktrees here: nothing to clean up."],
    });
    const one = await job("/api/workspace/prune", { change: "add-transfer-limit" });
    expect(one.result?.code).toBe(0);
    expect(one.result?.lines[0]).toBe("add-transfer-limit:");
    expect((await call("/api/workspace/prune", "POST", { change: "../x" })).status).toBe(400);
  });

  it("turns this machine's recording off and on", async () => {
    expect((await call("/api/history/recording", "PUT", { on: false })).body).toEqual({
      on: false,
    });
    const me = parse(await readFile(join(root, ".atticus/me.yaml"), "utf8")) as {
      history: { record: boolean };
    };
    expect(me.history.record).toBe(false);
    const list = await call("/api/history");
    expect((list.body.recording as { on: boolean }).on).toBe(false);
    await call("/api/history/recording", "PUT", { on: true });
    expect(((await call("/api/history")).body.recording as { on: boolean }).on).toBe(true);
    expect((await call("/api/history/recording", "PUT", { on: "yes" })).status).toBe(400);
  });

  it("says why a task's context can't be made", async () => {
    const r = await call("/api/changes/no-such-change/tasks/1.1/context");
    expect(r.status).toBe(400);
  });
});

describe("the read of a repo, prepared in the app", () => {
  it("is put on the map by its Done: verify --write after the last batch", async () => {
    const id = "run-20261109120000-0001";
    await mkdir(join(root, ".runs", "map-forge-ledger", id), { recursive: true });
    await keepResume(root, "map-forge-ledger", id, [
      "map",
      "forge-ledger",
      "--handoff",
      "--resume",
      id,
    ]);
    const asked: string[][] = [];
    const done = await resumeAfterDone(
      root,
      async (args) => {
        asked.push(args);
        if (args[0] === "verify")
          return {
            code: 0,
            out: ["Wrote the catalog for forge-ledger: 4 files written."],
            err: [],
          };
        return {
          code: 0,
          out: [
            JSON.stringify({
              state: "done",
              messages: ["Read forge-ledger in 1 batch: 4 facts kept, 0 still rejected."],
            }),
          ],
          err: [],
        };
      },
      "map-forge-ledger",
      id,
    );
    expect(asked).toEqual([
      ["map", "forge-ledger", "--resume", id, "--handoff", "--json"],
      ["verify", "forge-ledger", "--write"],
    ]);
    expect(done).toEqual({
      lines: [
        "Read forge-ledger in 1 batch: 4 facts kept, 0 still rejected.",
        "Wrote the catalog for forge-ledger: 4 files written.",
      ],
      applied: "forge-ledger",
    });
  });

  it("offers the next batch instead, and writes nothing to the catalog yet", async () => {
    const id = "run-20261109120100-0001";
    await keepResume(root, "map-forge-ledger", id, ["map", "forge-ledger", "--resume", id]);
    const asked: string[][] = [];
    const next = await resumeAfterDone(
      root,
      async (args) => {
        asked.push(args);
        return {
          code: 0,
          out: [JSON.stringify({ state: "handoff", runId: "run-next", messages: ["Batch 2."] })],
          err: [],
        };
      },
      "map-forge-ledger",
      id,
    );
    expect(asked).toHaveLength(1);
    expect(next).toEqual({ next: "run-next", lines: ["Batch 2."] });
  });

  it("reads which repo a step reads", () => {
    expect(mapRepoOf(["map", "forge-ledger", "--resume", "r"])).toBe("forge-ledger");
    expect(mapRepoOf(["map", "--all"])).toBeUndefined();
    expect(mapRepoOf(["change", "draft", "c1"])).toBeUndefined();
  });
});

describe("Draft the stories again", () => {
  it("keeps --force in the resume of plan stories only", () => {
    expect(resumeRefusal(["plan", "stories", "c1", "--force", "--resume", "r1"], "r1")).toBe(
      undefined,
    );
    expect(resumeRefusal(["change", "feature", "c1", "--force", "--resume", "r1"], "r1")).toMatch(
      /--force/,
    );
  });

  it("prepares plan stories with --force, and no other step with it", async () => {
    const asked: string[][] = [];
    const s = await startServer({
      root,
      port: 0,
      user: "pat",
      version: "1.0.0",
      extend: (r, ctx) =>
        uiModelRunRoutes(r, ctx, {
          runStep: async (args) => {
            asked.push(args);
            return { code: 0, out: ["Nothing to hand off."], err: [] };
          },
        }),
    });
    const prep = (args: string[]) =>
      fetch(s.url + "/api/runs/handoff", {
        method: "POST",
        headers: { "X-Atticus-Token": s.token, "Content-Type": "application/json" },
        body: JSON.stringify({ args }),
      });
    try {
      expect((await prep(["plan", "stories", "c1", "--force"])).status).toBe(201);
      expect(asked).toEqual([["plan", "stories", "c1", "--force", "--handoff", "--json"]]);
      for (const bad of [
        ["change", "feature", "c1", "--force"],
        ["plan", "stories", "c1", "--force", "--force"],
        ["plan", "stories", "c1", "--mode", "model"],
      ])
        expect((await prep(bad)).status, bad.join(" ")).toBe(400);
      // ADR 0188: the read of a repo and the fast path's step are AI steps the app starts.
      expect((await prep(["map", "forge-ledger"])).status).toBe(201);
      expect((await prep(["change", "small", "c1"])).status).toBe(201);
    } finally {
      await s.close();
    }
  });
});

describe("what the app's work proposes", () => {
  it("includes a change's drawn target flows and its knowledge list", () => {
    const dirs = scopeDirs("/m", "work");
    expect(dirs).toContain("openspec/changes/*/target-flows");
    expect(dirs).toContain("openspec/changes/*/knowledge.yaml");
  });
});
