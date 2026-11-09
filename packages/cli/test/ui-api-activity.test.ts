import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { Api, runsDirOf, startTerminalRun } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { tracked, uiActivityRoutes } from "../src/ui-api-activity.js";
import { main } from "../src/main.js";

/**
 * ADR 0187: the Console's list. The app's jobs with what they printed, the commands run in a
 * terminal (their run files, tailed and sent live), a Copilot run the app started, and the
 * hand-off runs that wait for an assistant, with what their Done printed. No network.
 */

const metarepo = async () => {
  const root = await mkdtemp(join(tmpdir(), "atticus-activity-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  return root;
};

let srv: RunningServer;
let root: string;
const events: z.infer<typeof Api.LiveEvent>[] = [];
const gone = new Set<number>();

beforeAll(async () => {
  root = await metarepo();
  srv = await startServer({
    root,
    port: 0,
    user: "pat",
    extend: (r, ctx) => uiActivityRoutes(r, ctx, { alive: (pid) => !gone.has(pid), tickMs: 20 }),
  });
  srv.events.listen((e) => events.push(Api.LiveEvent.parse(e)));
});
afterAll(() => srv?.close());

const call = async (path: string) => {
  const r = await fetch(srv.url + path, { headers: { "X-Atticus-Token": srv.token } });
  return { status: r.status, body: (await r.json()) as unknown };
};
const list = async () => Api.ActivityList.parse((await call("/api/activity")).body);
const until = async (ok: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 300; i++) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("never happened");
};

describe("the Console's list (ADR 0187)", () => {
  it("needs the session token", async () => {
    expect((await fetch(srv.url + "/api/activity")).status).toBe(401);
  });

  it("says nothing has run on a fresh metarepo", async () => {
    expect(await list()).toEqual({ entries: [], running: 0 });
  });

  it("lists an app job with its title and printed lines, live, and how to stop it", async () => {
    let release!: () => void;
    const job = srv.jobs.start(
      "scan",
      async (c) => {
        c.line("Scanning forge-ledger");
        await new Promise<void>((r) => (release = r));
        c.line("12 records");
      },
      { title: "Scan" },
    );
    await until(async () => (await list()).running === 1);
    const [e] = (await list()).entries;
    expect(e).toMatchObject({
      id: job.id,
      kind: "scan",
      title: "Scan",
      where: "app",
      state: "running",
      lines: 1,
      stop: `/api/jobs/${job.id}/cancel`,
    });
    release();
    await srv.jobs.settle(job.id);
    const lines = Api.ActivityLines.parse((await call(`/api/activity/${job.id}/lines`)).body);
    expect(lines).toEqual({
      id: job.id,
      from: 0,
      lines: ["Scanning forge-ledger", "12 records"],
      total: 2,
      state: "done",
    });
    expect((await call(`/api/activity/${job.id}/lines?from=1`)).body).toMatchObject({
      from: 1,
      lines: ["12 records"],
    });
    await until(() =>
      events.some(
        (x) => x.type === "activity.lines" && x.id === job.id && x.lines.includes("12 records"),
      ),
    );
    expect(
      events.some(
        (x) => x.type === "activity.changed" && x.entry.id === job.id && x.entry.state === "done",
      ),
    ).toBe(true);
    expect((await list()).entries[0]!.stop).toBeUndefined();
  });

  it("runs a request the page waits on as a job, keeping its answer", async () => {
    const ctx = { jobs: srv.jobs };
    expect(await tracked(ctx, "Critic on c1", async () => 42)).toBe(42);
    await expect(
      tracked(ctx, "Sync the wiki w", async () => {
        throw new Error("no wiki");
      }),
    ).rejects.toThrow("no wiki");
    const e = (await list()).entries.filter((x) => x.kind === "work");
    expect(e.map((x) => [x.title, x.state])).toEqual([
      ["Sync the wiki w", "failed"],
      ["Critic on c1", "done"],
    ]);
    // A context with no jobs runs it as it is.
    expect(await tracked({} as never, "x", async () => 1)).toBe(1);
  });

  it("shows a command run in a terminal, tails its lines live, and how it ended", async () => {
    const rec = startTerminalRun(root, {
      positionals: ["map", "forge-ledger"],
      flags: ["handoff"],
      env: { TERM_PROGRAM: "vscode" },
      pid: 777,
    })!;
    rec.line("Reading forge-ledger");
    const id = `term-${rec.runId}`;
    await until(async () => (await list()).entries.some((x) => x.id === id));
    expect((await list()).entries.find((x) => x.id === id)).toMatchObject({
      kind: "command",
      title: "atticus map forge-ledger --handoff",
      where: "vscode",
      state: "running",
      runId: rec.runId,
    });
    expect(events.some((x) => x.type === "activity.changed" && x.entry.id === id)).toBe(true);
    rec.line("The prompt is in .runs/x/prompt.md");
    await until(() =>
      events.some(
        (x) =>
          x.type === "activity.lines" &&
          x.id === id &&
          x.lines.includes("The prompt is in .runs/x/prompt.md"),
      ),
    );
    rec.end(0);
    await until(() =>
      events.some(
        (x) => x.type === "activity.changed" && x.entry.id === id && x.entry.state === "done",
      ),
    );
    expect((await call(`/api/activity/${id}/lines`)).body).toMatchObject({
      lines: ["Reading forge-ledger", "The prompt is in .runs/x/prompt.md"],
      total: 2,
      state: "done",
    });
    // One whose process is gone without saying.
    const lost = startTerminalRun(root, {
      positionals: ["verify", "forge-ledger"],
      flags: [],
      pid: 888,
    })!;
    gone.add(888);
    await until(async () =>
      (await list()).entries.some((x) => x.id === `term-${lost.runId}` && x.state === "ended"),
    );
  });

  it("shows a hand-off run waiting for the assistant, then what its Done printed", async () => {
    const dir = join(runsDirOf(root), "c1", "run-abc1");
    await mkdir(dir, { recursive: true });
    const run = (state: string) =>
      writeFile(
        join(dir, "run.json"),
        JSON.stringify({
          runId: "run-abc1",
          runtime: "hand-off",
          state,
          startedAt: new Date().toISOString(),
          errors: [],
          request: { change: "c1", agent: "critic", outputPath: "review/critic.md" },
        }),
      );
    await run("waiting");
    await until(async () => (await list()).entries.some((x) => x.id === "run-abc1"));
    const e = (await list()).entries.find((x) => x.id === "run-abc1")!;
    expect(e).toMatchObject({
      kind: "handoff",
      where: "assistant",
      state: "waiting",
      handoff: { change: "c1", agent: "critic", output: "review/critic.md" },
    });
    expect(e.handoff!.promptPath).toMatch(/c1\/run-abc1\/prompt\.md$/);
    const said = Api.ActivityLines.parse((await call("/api/activity/run-abc1/lines")).body);
    expect(said.lines.join("\n")).toContain("atticus handoff done run-abc1");
    expect(said.lines.join("\n")).toContain("prompt.md");
    // Done in a terminal: its output is in the same entry.
    const done = startTerminalRun(root, {
      positionals: ["handoff", "done", "run-abc1"],
      flags: [],
      pid: 1,
    })!;
    done.line("critic.md: 2 findings, no problems");
    done.end(0);
    await run("validated");
    await new Promise((r) => setTimeout(r, 1100));
    const after = Api.ActivityLines.parse((await call("/api/activity/run-abc1/lines")).body);
    expect(after.state).toBe("done");
    expect(after.lines).toContain("critic.md: 2 findings, no problems");
    // Done in the app: its job's lines too.
    await tracked({ jobs: srv.jobs }, "Done: run-abc1", async (c) => c?.line("Validated."), {
      meta: { handoffRun: "run-abc1" },
    });
    expect(
      Api.ActivityLines.parse((await call("/api/activity/run-abc1/lines")).body).lines,
    ).toContain("Validated.");
  });

  it("refuses an id or a from it can't read, and says 404 for none", async () => {
    expect((await call("/api/activity/..%2Fx/lines")).status).toBe(400);
    expect((await call("/api/activity/job-1/lines?from=-1")).status).toBe(400);
    expect((await call("/api/activity/job-999/lines")).status).toBe(404);
    expect((await call("/api/activity/term-20261109-101530-1-abcd/lines")).status).toBe(404);
    expect((await call("/api/activity/run-nope/lines")).status).toBe(404);
  });
});

describe("a command run from the command line (ADR 0187)", () => {
  it("keeps a long command's lines, and nothing for a quick one", async () => {
    const r = await metarepo();
    const out: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => out.push(l) };
    await main(["next", "--root", r], io, { record: true });
    const { readTerminalRuns } = await import("@maycombhq/core");
    expect(readTerminalRuns(r)).toEqual([]);
    const code = await main(["verify", "forge-nothing", "--root", r], io, { record: true });
    const [rec] = readTerminalRuns(r);
    expect(rec).toMatchObject({
      title: "atticus verify forge-nothing --root",
      state: code === 0 ? "done" : "failed",
      exitCode: code,
    });
    // The --root value (a folder) is never recorded.
    expect(JSON.stringify(rec)).not.toContain(r);
    // Run in the app's server (no record), nothing is kept.
    const r2 = await metarepo();
    await main(["verify", "forge-nothing", "--root", r2], io);
    expect(readTerminalRuns(r2)).toEqual([]);
  });
});
