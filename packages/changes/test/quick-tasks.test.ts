import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCodeTable } from "../src/code-table.js";
import { checkQuickTasks, quickTaskCriteria, saysFailure } from "../src/quick-tasks.js";

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
  it("are its own Given/When/Then lines, or one scenario of its requirement no earlier task took", () => {
    expect(
      quickTaskCriteria(ctx()).map((t) => [t.id, t.line, t.own.length, t.took?.scenario]),
    ).toEqual([
      ["r1", 3, 2, undefined],
      ["r2", 6, 0, "A receipt is asked for"],
      ["r3", 7, 1, undefined],
      // Its requirement has no scenario, so the row gives it no criterion.
      ["r4", 9, 0, undefined],
      // The one scenario of its requirement is r2's: a scenario vouches for one task.
      ["r5", 10, 0, undefined],
    ]);
  });

  it("blocks the tasks with none, naming a scenario another task took, and notes the rest", () => {
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
      {
        rule: "stories.no-criteria",
        task: "r5",
        blocking: true,
        message:
          'tasks.md:10: task r5 (Serve a receipt as a PDF) has no acceptance criteria. Add one under its line, indented: "- Given …, when …, then …". Or name, in its row of design.md\'s ## In the code, a requirement of its spec delta that has a #### Scenario: (refund-receipts: A receipt is served has the scenario "A receipt is asked for", and task r2 took it: a scenario vouches for one task; add one for r5).',
      },
      {
        rule: "stories.spec-criteria",
        task: "r2",
        blocking: false,
        message:
          "Criteria from the spec deltas' scenarios, one task each in tasks.md's order: r2 \"A receipt is asked for\" (refund-receipts: A receipt is served).",
      },
    ]);
  });

  it("passes a task once a criterion is added under it", () => {
    const tasks = TASKS.replace(
      "- [ ] r4 Write the receipts runbook",
      "- [ ] r4 Write the receipts runbook\n  - Given the runbook, when a receipt is missing, then it says how to issue it again.",
    ).replace(
      "- [ ] r5 Serve a receipt as a PDF (after r2)",
      "- [ ] r5 Serve a receipt as a PDF (after r2)\n  - Given a receipt, when its PDF is asked for, then a 404 Not Found answers for a refund with none.",
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

  it("reads a status code as a failure only as one, not as a count", () => {
    expect(saysFailure("then it is refused with status 422")).toBe(true);
    expect(saysFailure("then HTTP 503 is answered")).toBe(true);
    expect(saysFailure("then a 404 Not Found answers")).toBe(true);
    expect(saysFailure("Given 400 vets, when the list is read, then each is shown")).toBe(false);
  });

  it("says nothing for a change with no tasks", () => {
    expect(checkQuickTasks(ctx({ tasks: "" }))).toEqual([]);
  });
});
