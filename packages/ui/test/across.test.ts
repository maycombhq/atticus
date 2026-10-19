import { describe, expect, it } from "vitest";
import { filterRows, type AcrossRow } from "../src/screens/Across.js";
import { filterChanges, type ChangeSummary } from "../src/screens/Changes.js";

const none = { blocking: 0, gap: 0, risk: 0, idea: 0 };
const changes: ChangeSummary[] = [
  {
    id: "add-transfer-limit",
    title: "Add a daily transfer limit",
    type: "feature",
    state: "plan",
    repos: ["forge-ledger"],
    openFindings: { ...none, blocking: 1 },
  },
  {
    id: "fix-timeout",
    title: "Raise the audit timeout",
    type: "bugfix",
    state: "qa",
    openFindings: none,
  },
];

describe("finding a change", () => {
  it("matches words in the id, title and repos, case aside", () => {
    expect(filterChanges(changes, "LEDGER", "").map((c) => c.id)).toEqual(["add-transfer-limit"]);
    expect(filterChanges(changes, "audit timeout", "").map((c) => c.id)).toEqual(["fix-timeout"]);
    expect(filterChanges(changes, "", "")).toHaveLength(2);
  });

  it("filters by state, and blocked means a blocking finding is open", () => {
    expect(filterChanges(changes, "", "qa").map((c) => c.id)).toEqual(["fix-timeout"]);
    expect(filterChanges(changes, "", "blocked").map((c) => c.id)).toEqual(["add-transfer-limit"]);
  });
});

describe("filtering a list across changes", () => {
  const rows: AcrossRow[] = [
    { change: "a", changeTitle: "A", changeState: "plan", repo: "forge-ledger", done: false },
    { change: "b", changeTitle: "B", changeState: "build", repo: "forge-portal-ui", done: true },
  ];
  it("keeps rows that contain every word", () => {
    expect(filterRows(rows, "forge ledger").map((r) => r.change)).toEqual(["a"]);
    expect(filterRows(rows, "  ")).toHaveLength(2);
    expect(filterRows(rows, "nothing-like-this")).toEqual([]);
  });
});
