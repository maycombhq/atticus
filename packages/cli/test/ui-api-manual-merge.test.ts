import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import { MockGitHost } from "@maycombhq/adapters";
import { MockRuntime } from "@maycombhq/ai";
import { Api, parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { runTask } from "@maycombhq/taskrun";
import { uiRoutes } from "../src/ui-api.js";
import { uiRunRoutes } from "../src/ui-api-run.js";
import { CHANGE, git, speckitRoot } from "./run-helpers.js";

/**
 * Seventh UX walk (tasks and manual steps, API 2.72.0): a task ticks in tasks.md once its PR
 * merged, a person ticks or unticks one from the Task board, and a manual Git host's step marked
 * done syncs the change's hand-off, so a merge recorded on the reviews step moves the gate on.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const CHANGE_FIXTURES = join(HERE, "../../changes/test/fixtures/add-transfer-limit");
const REPO = "forge/forge-metarepo";
const T = 180_000;

function caller(srv: RunningServer) {
  return async (path: string, o: { method?: string; body?: unknown } = {}) => {
    const r = await fetch(srv.url + path, {
      method: o.method ?? "GET",
      headers: {
        "X-Atticus-Token": srv.token,
        ...(o.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
    });
    const text = await r.text();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: r.status, body: (text ? JSON.parse(text) : {}) as any };
  };
}

describe("ticking tasks", () => {
  it(
    "ticks a task once its PR merged, says so, and a person ticks or unticks one from the board",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      const now = () => new Date("2026-11-08T09:00:00Z");
      const host = new MockGitHost([{ repo: "forge-ledger" }]);
      const approval = { by: "dev", at: "2026-11-08T09:00:00Z", ref: "task 1.2" };
      const r = await runTask(root, CHANGE, "1.2", {
        level: "pr",
        by: "dev",
        approval,
        runtime: new MockRuntime(
          () =>
            "Done.\n\n=== file: src/main/java/forge/ledger/TransferLimits.java\nclass TransferLimits {}\n=== end file\n",
          { now },
        ),
        git,
        gitHost: host,
        now,
        commands: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
      });
      const srv = await startServer({
        root,
        port: 0,
        user: "pat",
        extend: (rt, ctx) =>
          uiRoutes(rt, ctx, { gitHost: host, now: "2026-11-08T09:00:00Z", taskRun: { git } }),
      });
      const call = caller(srv);
      const md = () => readFile(join(root, "openspec/changes", CHANGE, "tasks.md"), "utf8");
      try {
        let tasks = z.array(Api.Task).parse((await call(`/api/changes/${CHANGE}/tasks`)).body);
        expect(tasks.find((t) => t.id === "1.2")).toMatchObject({ done: false });
        host.review("forge-ledger", r.pr!.number, "tia", "approved");
        await host.merge("forge-ledger", r.pr!.number, approval);
        tasks = z.array(Api.Task).parse((await call(`/api/changes/${CHANGE}/tasks`)).body);
        const t = tasks.find((x) => x.id === "1.2")!;
        expect(t.done).toBe(true);
        expect(t.taskRun?.pr?.state).toBe("merged");
        expect(t.taskRun?.ticked).toBe("2026-11-08T09:00:00Z");
        expect(await md()).toContain("- [x] 1.2 Check the limit");

        // The person unticks it on the board: it stays unticked.
        const un = await call(`/api/changes/${CHANGE}/tasks/1.2/done`, {
          method: "POST",
          body: { done: false },
        });
        expect(un.status).toBe(200);
        expect(Api.Task.parse(un.body).done).toBe(false);
        tasks = z.array(Api.Task).parse((await call(`/api/changes/${CHANGE}/tasks`)).body);
        expect(tasks.find((x) => x.id === "1.2")?.done).toBe(false);
        // And ticks one by hand.
        const tick = await call(`/api/changes/${CHANGE}/tasks/1.1/done`, {
          method: "POST",
          body: { done: true },
        });
        expect(Api.Task.parse(tick.body)).toMatchObject({ id: "1.1", done: true });
        expect(await md()).toContain("- [x] 1.1 Add V3__add_daily_limit.sql");
        expect(
          (
            await call(`/api/changes/${CHANGE}/tasks/9.9/done`, {
              method: "POST",
              body: { done: true },
            })
          ).status,
        ).toBe(404);
        expect(
          (await call(`/api/changes/${CHANGE}/tasks/1.1/done`, { method: "POST", body: {} }))
            .status,
        ).toBe(400);
      } finally {
        await srv.close();
      }
    },
    T,
  );
});

async function manualRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-ui-manual-"));
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  const rt = join(root, "org-pack/runtime.yaml");
  await writeFile(
    rt,
    (await readFile(rt, "utf8")).replace("gitHost: { type: mock }", "gitHost: { type: manual }"),
  );
  for (const r of parse(readFileSync(join(FORGE, "expected/scan.yaml"), "utf8")) as Record<
    string,
    unknown
  >[]) {
    const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
    if (!p.ok) throw new Error(String(r.id));
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await mkdir(join(root, ".github"), { recursive: true });
  await writeFile(join(root, ".github/CODEOWNERS"), "*  @forge/platform\n");
  return root;
}

describe("a manual Git host's step marked done syncs the change", () => {
  it(
    "records the PR's link, then its merge on the reviews step, and the gate moves on with no Merge step",
    async () => {
      const root = await manualRoot();
      const srv = await startServer({
        root,
        port: 0,
        user: "pat",
        extend: (r, ctx) => {
          const deps = { now: "2026-11-08T09:00:00Z" };
          uiRunRoutes(uiRoutes(r, ctx, deps), ctx, deps);
        },
      });
      const call = caller(srv);
      try {
        const made = await call("/api/changes", {
          method: "POST",
          body: {
            id: CHANGE,
            title: "Add transfer limit",
            type: "feature",
            owners: { "product-owner": ["pat"], architect: ["ari"], developer: ["dev"] },
            systems: ["ledger"],
          },
        });
        expect(made.status).toBe(201);
        await cp(join(CHANGE_FIXTURES, "define"), join(root, "openspec/changes", CHANGE), {
          recursive: true,
        });
        const h = await call(`/api/changes/${CHANGE}/handoff`, {
          method: "POST",
          body: { repo: REPO },
        });
        expect(h.status).toBe(201);
        const open = "open-pr-handoff-add-transfer-limit-define";
        const opened = await call(`/api/todo/${open}/done`, {
          method: "POST",
          body: { values: { url: `https://git.forge.example/${REPO}/pull/5`, number: "5" } },
        });
        expect(opened.status).toBe(200);
        // Synced: the hand-off goes by the recorded PR now, and waits for its reviews.
        expect(opened.body.synced.join("\n")).toContain("PR #5 can't merge yet:");
        const d1 = Api.ChangeDetail.parse((await call(`/api/changes/${CHANGE}`)).body);
        expect(d1.handoff).toMatchObject({ pr: `https://git.forge.example/${REPO}/pull/5` });

        const merged = await call(`/api/todo/report-pr-handoff-add-transfer-limit-define/done`, {
          method: "POST",
          body: { values: { approvers: "ari", checksPassing: "yes", merged: "yes" } },
        });
        expect(merged.status).toBe(200);
        expect(merged.body.synced).toContain(`PR #5 merged. ${CHANGE} is now design.`);
        const d2 = Api.ChangeDetail.parse((await call(`/api/changes/${CHANGE}`)).body);
        expect(d2.state).toBe("design");
        const todo = await call("/api/todo?all=1");
        expect(
          todo.body.steps.filter((s: { action: string }) => s.action === "merge-pull-request"),
        ).toEqual([]);
      } finally {
        await srv.close();
      }
    },
    T,
  );

  it(
    "a step of a change with no hand-off open doesn't sync",
    async () => {
      const root = await manualRoot();
      const srv = await startServer({
        root,
        port: 0,
        user: "pat",
        extend: (r, ctx) => {
          const deps = { now: "2026-11-08T09:00:00Z" };
          uiRunRoutes(uiRoutes(r, ctx, deps), ctx, deps);
        },
      });
      const call = caller(srv);
      try {
        const { ManualGitHost, fileStepStore } = await import("@maycombhq/adapters");
        await new ManualGitHost({ store: fileStepStore(root) }).createPullRequest(
          {
            repo: "forge-ledger",
            head: `task/${CHANGE}/1.1`,
            base: `change/${CHANGE}`,
            title: "Task 1.1",
            body: "Task",
          },
          { by: "dev", at: "2026-11-08T09:00:00Z", ref: "task" },
        );
        const done = await call(`/api/todo/open-pr-task-${CHANGE}-1-1/done`, {
          method: "POST",
          body: {
            values: { url: "https://git.forge.example/forge/forge-ledger/pull/9", number: "9" },
          },
        });
        expect(done.status).toBe(200);
        expect(done.body.synced).toBeUndefined();
      } finally {
        await srv.close();
      }
    },
    T,
  );
});
