import { describe, expect, it } from "vitest";
import { csvCell, html, workItemsCsv, type CsvStory } from "../src/index.js";

/**
 * The tracker import files (ADR 0124 addendum B-short). The fraud check's whole file is pinned in
 * the planner (fixtures/stages/stories/expected/ado.csv); these are the escaping and the links.
 */

const story: CsvStory = {
  title: 'Hold orders over €1,000 "for review"',
  statement: "As a clerk I want big orders held so that a person looks first.",
  change: "hold-big-orders",
  repo: "forge-orders",
  flow: "forge-orders.place-order",
  file: "stories/s1-place-order.md",
  criteria: ["Given an order of 1200, when it is placed, then it is held & 202 < 300."],
  tasks: [
    {
      label: "1.1",
      title: "Add the branch step: hold big orders",
      steps: ["Add the branch step: hold big orders."],
      places: ["forge-orders:src/main/java/forge/orders/OrderController.java:9"],
      fields: ["total"],
      criteria: ["Given an order of 1200, when it is placed, then it is held & 202 < 300."],
      prompt: "tasks/1.1.prompt.md",
      run: "atticus task hold-big-orders 1.1",
    },
  ],
};

describe("work items as a tracker's import file", () => {
  it("quotes a CSV cell with a comma, quote or line break, and escapes HTML", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('a, "b"')).toBe('"a, ""b"""');
    expect(html('<b> & "x"')).toBe("&lt;b&gt; &amp; &quot;x&quot;");
  });

  it("Azure DevOps: a User Story with its Task under it, criteria as an HTML list, paths when given", () => {
    const rows = workItemsCsv([story], { areaPath: "Forge\\Orders", iterationPath: "Forge\\S12" })
      .split("\r\n")
      .filter(Boolean);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatch(/^,User Story,"Hold orders over €1,000 ""for review""",,/);
    expect(rows[1]).toContain(
      "<li>Given an order of 1200, when it is placed, then it is held &amp; 202 &lt; 300.</li>",
    );
    expect(rows[1]).toMatch(/,hold-big-orders; forge-orders,Forge\\Orders,Forge\\S12$/);
    expect(rows[2]).toMatch(/^,Task,,1\.1 Add the branch step: hold big orders,/);
  });

  it("Jira: a Story and its Sub-task, linked by Parent", () => {
    const rows = workItemsCsv([story], { format: "jira" }).split("\r\n").filter(Boolean);
    expect(rows[0]).toBe(
      "Issue Id,Issue Type,Summary,Description,Acceptance Criteria,Parent,Labels",
    );
    expect(rows[1]).toMatch(/^1,Story,/);
    expect(rows[2]).toMatch(/^2,Sub-task,1\.1 Add the branch step: hold big orders,/);
    expect(rows[2]).toMatch(/,1,hold-big-orders forge-orders$/);
  });
});
