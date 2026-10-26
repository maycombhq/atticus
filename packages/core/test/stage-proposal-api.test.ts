import { describe, expect, it } from "vitest";
import { Api, API_VERSION } from "../src/index.js";

/**
 * API 2.27.0 (ADR 0115 addendum, 2026-10-25): a stage tab's finding may carry what an assistant
 * proposed about it, waiting on a person. Additive: a view without it still parses.
 */
describe("a stage finding's proposal by an assistant (C4 2.27.0)", () => {
  const finding = {
    schemaVersion: 1,
    id: "flow-use-matches-estate-feature-l10",
    kind: "issue",
    change: "add-fraud-check",
    gate: "define",
    round: 2,
    rule: "flow-use-matches-estate",
    layer: "org",
    lens: "true",
    severity: "blocking",
    artifact: "feature.md",
    locator: { line: 10 },
    summary: "Reserving stock now waits for the screen's verdict, so its steps change.",
    why: "A flow marked read gets no target flow.",
    fix: { text: "Mark forge-stock.reserve-stock as changed." },
    evidence: [{ source: "artifact", path: "feature.md", line: 10, quote: "reserve-stock (read)" }],
    waivable: true,
    state: "open",
    createdAt: "2026-10-21T09:00:00Z",
  };
  const view = {
    finding,
    file: "openspec/changes/add-fraud-check/review/define/2/flow-use-matches-estate-feature-l10.yaml",
    options: { fix: "Mark it changed.", apply: true, dismiss: true, waive: true },
    comments: [],
  };

  it("is 2.27.0 or later, and takes the proposal; a view without one still parses", () => {
    // 2.25.0 and 2.26.0 landed beside this one (B-change, B-task-knowledge), so the proposal
    // field arrived at 2.27.0; a later additive version keeps all of it.
    const [major, minor] = API_VERSION.split(".").map(Number);
    expect(major).toBe(2);
    expect(minor).toBeGreaterThanOrEqual(27);
    expect(Api.StageFindingView.safeParse(view).success).toBe(true);
    const proposed = {
      ...view,
      proposal: {
        claim: "not-relevant",
        by: "claude",
        at: "2026-10-21T09:05:00Z",
        reason: "Reserving stock only reads the verdict.",
      },
    };
    expect(Api.StageFindingView.parse(proposed).proposal?.by).toBe("claude");
    expect(
      Api.StageFindingView.safeParse({ ...view, proposal: { claim: "waived", by: "x", at: "y" } })
        .success,
    ).toBe(false);
  });
});
