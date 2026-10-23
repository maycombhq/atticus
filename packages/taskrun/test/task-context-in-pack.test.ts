import { describe, expect, it } from "vitest";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import { runTask } from "../src/index.js";
import { CHANGE, git, speckitRoot } from "./helpers.js";

/** ADR 0113: atticus task run gives its model the same task context as atticus task context. */

const NOW = new Date("2026-10-21T09:00:00Z");
const now = () => NOW;

describe("Run with AI: the task's context", () => {
  it("puts the task context the assistants get into the task run's pack, as data", async () => {
    const { root } = await speckitRoot({ repos: ["forge-ledger"] });
    const seen: AiRequest[] = [];
    const runtime = new MockRuntime(
      (r) => {
        seen.push(r);
        return "## Steps\n\n1. Add TransferLimits.\n";
      },
      { now },
    );
    await runTask(root, CHANGE, "1.2", { level: "plan", by: "dev", runtime, git, now });
    const prompt = seen[0]!.pack.prompt;
    expect(prompt).toContain('<atticus-data id="task-context"');
    expect(prompt).toContain(`# Task 1.2 of ${CHANGE}:`);
    expect(prompt).toContain("## Acceptance criteria");
  }, 120_000);
});
