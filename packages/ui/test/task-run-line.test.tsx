import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TaskRunLine } from "../src/screens/Changes.js";

/**
 * A run that is part of a task run says where the task stands (review round 22): a stopped or
 * failing task needs a person, said as an alert with its note and the last build's log.
 */
describe("the task run under its AI run", () => {
  it("says a task needs a person, why, and where its log is", () => {
    const html = renderToStaticMarkup(
      <TaskRunLine
        of={{
          task: "1.2",
          repo: "forge-ledger",
          level: "draft",
          state: "needs-person",
          branch: "task/add-transfer-limit/1.2",
          worktree: "workspace/.worktrees/add-transfer-limit/.tasks/1.2/forge-ledger",
          notes: [
            "Atticus was stopped while the build ran, so nothing more was done; a person takes over in workspace/.worktrees/add-transfer-limit/.tasks/1.2/forge-ledger.",
          ],
          log: ".runs/add-transfer-limit/run-1/build-1.log",
        }}
      />,
    );
    expect(html).toContain("Task 1.2: needs a person");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Atticus was stopped while the build ran");
    expect(html).toContain("Last build: .runs/add-transfer-limit/run-1/build-1.log");
  });

  it("says a built task plainly, with no alert", () => {
    const html = renderToStaticMarkup(
      <TaskRunLine
        of={{
          task: "1.3",
          repo: "forge-ledger",
          level: "draft",
          state: "built",
          branch: "b",
          worktree: "w",
          notes: [],
        }}
      />,
    );
    expect(html).toContain("Task 1.3: built");
    expect(html).not.toContain('role="alert"');
  });
});
