import { describe, expect, it } from "vitest";
import { openItemRows, openItemsNode } from "../src/sidebar-data";

/** ADR 0210 part 7 (review of PR #21): a change's open items in the Atticus view. */
describe("a change's open items in the sidebar", () => {
  const f1 = { message: "Blocking finding f1 on the design gate (round 2): No retry budget." };

  it("is one row naming how many, opening to each once", () => {
    const [node, ...rest] = openItemsNode("add-transfer-limit", [
      f1,
      f1,
      { message: "Task 1.1 isn't merged." },
    ]);
    expect(rest).toEqual([]);
    expect(node).toMatchObject({
      id: "open-items:add-transfer-limit",
      label: "Open items (2)",
      expand: { kind: "open-items", change: "add-transfer-limit" },
    });
    expect(node!.tooltip).toContain("its PR lists them, and the person who approves it decides");
    const rows = openItemRows("add-transfer-limit", (node!.expand as { items: string[] }).items);
    expect(rows.map((r) => r.label)).toEqual([f1.message, "Task 1.1 isn't merged."]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
  });

  it("is no row when there are none, or the server doesn't say", () => {
    expect(openItemsNode("add-transfer-limit", [])).toEqual([]);
    expect(openItemsNode("add-transfer-limit")).toEqual([]);
  });
});
