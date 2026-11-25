import { describe, expect, it } from "vitest";
import type { GateStatus } from "@maycombhq/naysayer";
import { statusLine } from "../src/critic-commands.js";

/** ADR 0210 part 7 (review of PR #21): a gate with only open items isn't "closed". */
const status = (o: Partial<GateStatus>): GateStatus => ({
  gate: "design",
  round: 1,
  open: { blocking: 1, gaps: 1, risks: 0, ideas: 0 },
  total: { blocking: 1, gaps: 1, risks: 0, ideas: 0 },
  mayProceed: false,
  goesAhead: true,
  openItems: ["Blocking finding f1 on the design gate (round 1): No retry budget."],
  humanDecides: false,
  checkRound: false,
  checkRoundsRun: 0,
  waiting: [],
  reasons: [],
  findings: [],
  ...o,
});

describe("a gate's status line with only open items", () => {
  it("says the hand-off goes ahead with them, never that the gate is closed", () => {
    const line = statusLine(status({}), "add-transfer-limit");
    expect(line).toBe(
      "The design gate has open items (1 blocking, 1 open gap): its hand-off goes ahead with them, and its PR lists them for the person who approves it. Act on any with atticus finding add-transfer-limit <id> <action>.",
    );
    expect(line).not.toContain("closed");
  });

  it("still says closed while a constitution finding holds it", () => {
    expect(statusLine(status({ goesAhead: false }), "add-transfer-limit")).toMatch(
      /^The design gate is closed/,
    );
  });
});
