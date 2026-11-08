import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startServer } from "@maycombhq/server";
import { uiRoutes } from "../src/ui-api.js";
import { CHANGE, speckitRoot } from "./run-helpers.js";

/** UX review: Run with AI on a task whose repo has no worktree yet opens it, no terminal first. */
it("opens the task's worktree, then runs the task", async () => {
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
