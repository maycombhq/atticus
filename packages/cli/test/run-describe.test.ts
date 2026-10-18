import { describe, expect, it } from "vitest";
import type { TaskRunRecord } from "@maycombhq/taskrun";
import { describeRun } from "../src/run-commands.js";

const record = (o: Partial<TaskRunRecord>): TaskRunRecord =>
  ({
    schemaVersion: 1,
    change: "add-transfer-limit",
    task: "1.2",
    repo: "forge-ledger",
    level: "draft",
    state: "failed",
    notes: [],
    attempts: [],
    runs: [],
    changed: [],
    ...o,
  }) as TaskRunRecord;

function lines(r: TaskRunRecord) {
  const out: string[] = [];
  const code = describeRun("/x", r, { out: (l) => out.push(l), err: () => undefined });
  return { out, code };
}

describe("atticus task run: a failed run says why", () => {
  it("puts the failing step and its error in the first line, then the other notes", () => {
    const r = lines(
      record({
        notes: [
          "Handed the task down first (specs/1.2 in forge-ledger, commit abcdef123456).",
          "The AI run ended failed: no recording for agent task-runner with prompt 1234.",
        ],
      }),
    );
    expect(r.code).toBe(1);
    expect(r.out).toEqual([
      "The run for task 1.2 failed: The AI run ended failed: no recording for agent task-runner with prompt 1234.",
      "  Handed the task down first (specs/1.2 in forge-ledger, commit abcdef123456).",
    ]);
  });

  it("keeps the plain sentence when there is no note to give", () => {
    expect(lines(record({})).out).toEqual(["The run for task 1.2 failed."]);
  });

  it("leaves the other states as they were", () => {
    const r = lines(record({ state: "needs-person", worktree: "w", notes: ["The build fails."] }));
    expect(r.out).toEqual(["Task 1.2 needs a person in w.", "  The build fails."]);
    expect(r.code).toBe(1);
  });
});
