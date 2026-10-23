import { describe, expect, it } from "vitest";
import { changeDiagramHash, changeMapMarkdown, type ChangeMapJson } from "../src/change-map";

/** /changemap (ADR 0108): a change's picture in Copilot Chat. */

const MAP: ChangeMapJson = {
  change: "add-transfer-limit",
  title: "Daily transfer limit",
  source: "openspec/changes/add-transfer-limit/target-flows",
  nodes: [
    { id: "ledger-api", legend: "modify" },
    { id: "limits-svc", legend: "new" },
    { id: "audit-svc" },
  ],
  edges: [{ legend: "new" }, { legend: "retire" }, {}],
  mermaid: 'flowchart LR\n  limits_svc["+ limits-svc"]\n',
  flows: 2,
  problems: [],
};

describe("a change's picture in the chat (ADR 0108)", () => {
  it("draws the Mermaid and says the marks in words", () => {
    const md = changeMapMarkdown(MAP);
    expect(md).toContain(
      "drawn from 2 target flows in openspec/changes/add-transfer-limit/target-flows: 2 + new, 1 ◇ changed, 1 ✕ retired",
    );
    expect(md).toContain('```mermaid\nflowchart LR\n  limits_svc["+ limits-svc"]\n```');
  });

  it("says what couldn't be drawn", () => {
    expect(changeMapMarkdown({ ...MAP, problems: ["target-flows/x.yaml: bad"] })).toContain(
      "Couldn't be drawn:\n- target-flows/x.yaml: bad",
    );
  });

  it("with no target flows, says which step writes them", () => {
    expect(changeMapMarkdown({ ...MAP, flows: 0 })).toBe(
      "add-transfer-limit has no target flows yet, so there is nothing to draw. Its architecture stage writes them: /architecture add-transfer-limit",
    );
  });

  it("opens the Change diagram on the change", () => {
    expect(changeDiagramHash("add transfer")).toBe("#/change-diagram?change=add%20transfer");
  });
});
