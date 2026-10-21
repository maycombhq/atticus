import { describe, expect, it } from "vitest";
import { parseReference, scoreVerifier } from "../src/bench.js";

/** How often the AI verify step (ADR 0082) is right, by the bench's reference. */
const ref = parseReference(`
repo: invented-tasks
commit: 0123456789abcdef0123456789abcdef01234567
covers: [serves, stores]
serves:
  - { method: GET, path: /tasks-api/tasks, at: "TaskController.java:14" }
  - { method: GET, path: /tasks-api/tasks/archive, at: "ArchiveHandler.java:8" }
stores:
  - { table: task, at: "V1__create_task.sql:1" }
`);

describe("bench: the verifier's precision", () => {
  it("counts a flagged miss the reference has, and a flagged wrong record the reference doesn't", () => {
    const s = scoreVerifier(ref, {
      missed: [
        { kind: "entry-point", method: "GET", name: "/tasks-api/tasks/archive" }, // agreed
        { kind: "entry-point", method: "GET", name: "/tasks-api/tasks/purge" }, // not in the reference
        { kind: "table", name: "task_audit" }, // not in the reference
        { kind: "call", method: "GET", name: "/x" }, // calls aren't covered: not scored
      ],
      wrong: [
        { kind: "entry-point", method: "GET", name: "/tasks" }, // agreed: the reference has it with the prefix
        { kind: "table", name: "task" }, // the reference has it: the verifier is wrong
        { kind: "other", name: "x" }, // not scored
      ],
    });
    expect(s).toEqual({
      missed: { flagged: 4, scored: 3, agreed: 1 },
      wrong: { flagged: 3, scored: 2, agreed: 1 },
      precision: 2 / 5,
    });
  });

  it("is 1 when nothing could be scored", () => {
    expect(scoreVerifier(ref, { missed: [], wrong: [] }).precision).toBe(1);
  });
});
