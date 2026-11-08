import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockRuntime } from "@maycombhq/ai";
import { runTask, shellCommandRunner, stopAllBuilds, stopSignal } from "../src/index.js";
import { CHANGE, git, speckitRoot } from "./helpers.js";

/**
 * Once Atticus is stopping (Ctrl+C on atticus ui, the editor gone), a task run does nothing more
 * (review round 22). Its own file: the stop lasts for the rest of the process.
 */
const now = () => new Date("2026-10-21T09:00:00Z");

describe("a task run after Atticus is stopped", () => {
  it("writes no plan, starts no build, and says it was stopped; the model call is aborted", async () => {
    const { root } = await speckitRoot({ repos: ["forge-ledger"] });
    stopAllBuilds();
    expect(stopSignal.aborted).toBe(true);
    // A build asked for now doesn't start.
    const b = await shellCommandRunner()("echo started > started.txt", root);
    expect(b).toMatchObject({ exitCode: null, stopped: true });
    expect(existsSync(join(root, "started.txt"))).toBe(false);
    const r = await runTask(root, CHANGE, "1.2", {
      level: "plan",
      by: "dev",
      runtime: new MockRuntime(() => "## Steps\n\n1. Add TransferLimits.\n", { now }),
      git,
      now,
    });
    expect(r.state).toBe("needs-person");
    expect(r.notes.at(-1)).toBe(
      "Atticus was stopped before the answer was applied, so nothing was written; run the task again.",
    );
    expect(existsSync(join(root, "openspec/changes", CHANGE, "tasks/1.2/plan.md"))).toBe(false);
  }, 120_000);
});
