import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { startServer } from "@maycombhq/server";
import { uiRoutes } from "../src/ui-api.js";
import { CHANGE, speckitRoot } from "./run-helpers.js";

// Opening the worktree commits in it, as the person's git would: a CI runner has no git
// identity of its own, so this test gives one (in-process, as the server runs here).
afterEach(() => vi.unstubAllEnvs());

/** UX review: Run with AI on a task whose repo has no worktree yet opens it, no terminal first. */
it("opens the task's worktree, then runs the task", async () => {
  for (const [k, v] of Object.entries({
    GIT_AUTHOR_NAME: "Pat",
    GIT_AUTHOR_EMAIL: "pat@example.com",
    GIT_COMMITTER_NAME: "Pat",
    GIT_COMMITTER_EMAIL: "pat@example.com",
  }))
    vi.stubEnv(k, v);
  const { root } = await speckitRoot({ repos: ["forge-ledger"], open: false });
  const s = await startServer({ root, port: 0, user: "pat", extend: (r, ctx) => uiRoutes(r, ctx) });
  try {
    const res = await fetch(`${s.url}/api/changes/${CHANGE}/runs`, {
      method: "POST",
      headers: { "X-Atticus-Token": s.token, "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "task-runner", task: "1.3", runtime: "hand-off" }),
    });
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain("has no worktree");
    expect(res.ok, body).toBe(true);
    const repos = await readFile(join(root, "openspec/changes", CHANGE, "repos.yaml"), "utf8");
    expect(repos).toMatch(/forge-ledger[\s\S]*worktree/);
  } finally {
    await s.close();
  }
}, 120_000);
