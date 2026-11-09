import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockGitHost } from "@maycombhq/adapters";
import { MockRuntime } from "@maycombhq/ai";
import { Api } from "@maycombhq/core";
import { startServer } from "@maycombhq/server";
import { runTask } from "@maycombhq/taskrun";
import { uiRoutes } from "../src/ui-api.js";
import { confirmFor } from "./confirm-helpers.js";
import { CHANGE, git, speckitRoot } from "./run-helpers.js";

/**
 * App-only audit (API 3.3.0): a task drafted while its repo had no build command (UNVERIFIED) is
 * built and raised from the app once the command is set, and a task whose branch has commits the
 * change branch hasn't isn't marked done without the person saying why.
 */
const FILE = "src/main/java/forge/ledger/TransferLimits.java";
const now = () => new Date("2026-11-09T09:00:00Z");
const ok = async () => ({ exitCode: 0, stdout: "ok", stderr: "" });

async function unverifiedTask() {
  const { root } = await speckitRoot({ repos: ["forge-ledger"] });
  const manifest = join(root, "org-pack/profiles/forge/repos.manifest.yaml");
  const had = await readFile(manifest, "utf8");
  await writeFile(manifest, had.replace("    build: forge build && forge test\n", ""));
  const r = await runTask(root, CHANGE, "1.2", {
    level: "draft",
    by: "dev",
    runtime: new MockRuntime(
      () =>
        `Done.\n\n=== file: ${FILE}\npackage forge.ledger;\n\nclass TransferLimits { boolean ok; }\n=== end file\n`,
      { now },
    ),
    git,
    now,
    commands: ok,
  });
  expect(r.state).toBe("unverified");
  return { root, manifest, had };
}

describe("tasks from the app (app-only audit)", () => {
  it("says the task's branch isn't merged, refuses Mark done without a reason (409), records one with it", async () => {
    const { root } = await unverifiedTask();
    const srv = await startServer({
      root,
      port: 0,
      user: "pat",
      extend: (r, ctx) => uiRoutes(r, ctx, { taskRun: { git, commands: ok } }),
    });
    const call = (path: string, method = "GET", body?: unknown) =>
      fetch(`${srv.url}${path}`, {
        method,
        headers: { "X-Atticus-Token": srv.token, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    try {
      const list = (await (await call(`/api/changes/${CHANGE}/tasks`)).json()) as unknown[];
      const t = Api.Task.parse(list.find((x) => (x as { id: string }).id === "1.2"));
      expect(t.unmerged).toMatchObject({ commits: 1, branch: `task/${CHANGE}/1.2` });
      expect(t.repoBuilds).toBe(false);
      const no = await call(`/api/changes/${CHANGE}/tasks/1.2/done`, "POST", { done: true });
      expect(no.status).toBe(409);
      const said = JSON.stringify(await no.json());
      expect(said).toContain(`Task 1.2's branch task/${CHANGE}/1.2 in forge-ledger has 1 commit`);
      expect(said).toContain("say why its work isn't needed");
      const yes = await call(`/api/changes/${CHANGE}/tasks/1.2/done`, "POST", {
        done: true,
        reason: "Done by hand in task 1.3.",
      });
      expect(yes.status).toBe(200);
      const done = Api.Task.parse(await yes.json());
      expect(done.done).toBe(true);
      expect(done.decision).toMatchObject({ by: "pat", reason: "Done by hand in task 1.3." });
      expect(done.unmerged).toBeUndefined();
    } finally {
      await srv.close();
    }
  }, 180_000);

  it("Build and raise PR builds an unverified task with the build command set since, and raises its PR only with the person's confirmation", async () => {
    const { root, manifest, had } = await unverifiedTask();
    const host = new MockGitHost([{ repo: "forge-ledger" }]);
    const srv = await startServer({
      root,
      port: 0,
      user: "pat",
      extend: (r, ctx) => uiRoutes(r, ctx, { gitHost: host, taskRun: { git, commands: ok } }),
    });
    const call = (path: string, body: unknown) =>
      fetch(`${srv.url}${path}`, {
        method: "POST",
        headers: { "X-Atticus-Token": srv.token, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const path = `/api/changes/${CHANGE}/tasks/1.2/build`;
    try {
      const notYet = await call(path, {});
      expect(notYet.status).toBe(422);
      expect(JSON.stringify(await notYet.json())).toContain("Set up › Repos");
      await writeFile(manifest, had);
      // The push and PR need the person's yes: the session token alone is 403.
      expect((await call(path, { raise: true })).status).toBe(403);
      const confirmation = await confirmFor(srv, "task-pr", `${CHANGE}/1.2`);
      const raised = await call(path, { raise: true, confirmation });
      expect(raised.status).toBe(201);
      const t = Api.Task.parse(await raised.json());
      expect(t.taskRun).toMatchObject({ state: "pr-open", pr: { number: 1 } });
      expect(t.repoBuilds).toBe(true);
    } finally {
      await srv.close();
    }
  }, 180_000);
});
