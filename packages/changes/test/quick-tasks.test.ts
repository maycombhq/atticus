import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCodeTable } from "../src/code-table.js";
import { checkQuickTasks, quickTaskCriteria } from "../src/quick-tasks.js";

/**
 * v31 (WP-05): a quick change's tasks are checked at its plan hand-off as the stories stage
 * checks a story's tasks: criteria present, an error case, every entry a criterion names known.
 * Only a task with no criteria at all blocks; the rest are notes. No I/O: the caller gives text.
 */

const DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/quick-tasks/change");
const TASKS = readFileSync(join(DIR, "tasks.md"), "utf8");
const DESIGN = readFileSync(join(DIR, "design.md"), "utf8");
const SPECS = [
  {
    path: "specs/refund-receipts/spec.md",
    text: readFileSync(join(DIR, "specs/refund-receipts/spec.md"), "utf8"),
  },
];
const MAP = new Set(["forge-refunds", "forge-ledger", "forge.refunds.settled"]);
const ctx = (o: { tasks?: string; design?: string } = {}) => ({
  tasks: o.tasks ?? TASKS,
  table: parseCodeTable(o.design ?? DESIGN),
  specs: SPECS,
  has: (id: string) => MAP.has(id),
  planned: [],
});

describe("a quick task's acceptance criteria", () => {
  it("are its own Given/When/Then lines and its requirement's scenarios", () => {
    expect(
      quickTaskCriteria(ctx()).map((t) => [t.id, t.line, t.own.length, t.scenarios.length]),
    ).toEqual([
      ["r1", 3, 2, 1],
      ["r2", 6, 0, 1],
      ["r3", 7, 1, 0],
      // Its requirement has no scenario, so the row gives it no criterion.
      ["r4", 9, 0, 0],
    ]);
  });

  it("blocks only the task with none, and notes the error cases and the unknown entry", () => {
    expect(checkQuickTasks(ctx())).toEqual([
      {
        rule: "stories.no-error-case",
        task: "r2",
        blocking: false,
        message:
          "tasks.md:6: task r2 (Serve a refund's receipt) takes requests, but no criterion says what happens when that fails: add one (the request is refused, and what the caller sees).",
      },
      {
        rule: "stories.unknown-entry",
        task: "r3",
        blocking: false,
        message:
          "tasks.md:8: a criterion of task r3 names GET /v1/receipts/{id}/audit, which neither the map, requirements.md's Planned nor a row of design.md's ## In the code has.",
      },
      {
        rule: "stories.no-error-case",
        task: "r3",
        blocking: false,
        message:
          "tasks.md:7: task r3 (Read the account's name from forge-ledger) calls another system, but no criterion says what happens when that fails: add one (the call fails or times out, and what the caller sees).",
      },
      {
        rule: "stories.no-criteria",
        task: "r4",
        blocking: true,
        message:
          'tasks.md:9: task r4 (Write the receipts runbook) has no acceptance criteria. Add one under its line, indented: "- Given …, when …, then …". Or name, in its row of design.md\'s ## In the code, a requirement of its spec delta that has a #### Scenario: (refund-receipts: Receipts have a runbook has none).',
      },
    ]);
  });

  it("passes a task once a criterion is added under it", () => {
    const tasks = TASKS.replace(
      "- [ ] r4 Write the receipts runbook",
      "- [ ] r4 Write the receipts runbook\n  - Given the runbook, when a receipt is missing, then it says how to issue it again.",
    );
    expect(checkQuickTasks(ctx({ tasks })).filter((f) => f.blocking)).toEqual([]);
  });

  it("reads a task with no row and no criterion as having none, and a CRLF file alike", () => {
    const tasks = "## forge-refunds\r\n\r\n- [ ] r9 Tidy the logs\r\n";
    expect(checkQuickTasks(ctx({ tasks })).map((f) => [f.rule, f.task, f.blocking])).toEqual([
      ["stories.no-criteria", "r9", true],
    ]);
    // A plain sub-list item that isn't in Given/When/Then form is not a criterion.
    const notes = "## forge-refunds\n\n- [ ] r9 Tidy the logs\n  - see the old runbook\n";
    expect(checkQuickTasks(ctx({ tasks: notes }))[0]?.rule).toBe("stories.no-criteria");
  });

  it("says nothing for a change with no tasks", () => {
    expect(checkQuickTasks(ctx({ tasks: "" }))).toEqual([]);
  });
});
