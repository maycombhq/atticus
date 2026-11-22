import { describe, expect, it } from "vitest";
import { ACCEPTABLE_STAGE_RULES, wayOn, wayOnKind } from "../src/index.js";

/**
 * ADR 0203 A.4, the app's half: why a stage rule can't be accepted, as a kind the app words in
 * its copy file (packages/ui/src/copy.ts), one kind for each row of the ADR's table. The command
 * line's words (wayOn) are the same rows, unchanged.
 */
describe("wayOnKind", () => {
  it.each([
    ["stories.note-overrides-code", "document-over-code"],
    ["feature.nothing-placed", "nothing-to-plan"],
    ["small.no-target-flow", "nothing-to-plan"],
    ["feature.unknown-flow", "needs-catalog"],
    ["delta.unknown-column", "needs-catalog"],
    ["delta.exists", "contradicts-fact"],
    ["delta.no-retention", "data-safety"],
    ["feature.archived-repo", "archived-repo"],
    ["operation.archived-repo", "archived-repo"],
    ["delta.at-unknown", "cites-missing-code"],
    ["delta.deploy-order", "order"],
    ["operation.no-undo", "order"],
    ["stage.no-answer", "answer-shape"],
    ["design.unmapped", "answer-shape"],
    ["stories.no-criteria", "next-stage-needs"],
  ] as const)("%s is %s", (rule, kind) => {
    expect(wayOnKind(rule)).toBe(kind);
  });

  it("is the row wayOn words, so the two never disagree", () => {
    const words = new Map<string, string>();
    for (const rule of ["delta.exists", "delta.stale", "delta.wrong-repo"]) {
      const k = wayOnKind(rule) ?? "none";
      words.set(k, words.get(k) ?? wayOn(rule));
      expect(wayOn(rule)).toBe(words.get(k));
    }
    expect(words.size).toBe(1);
  });

  it("is never asked of a rule a person may accept", () => {
    for (const rule of ACCEPTABLE_STAGE_RULES) expect(wayOnKind(rule)).toBeUndefined();
  });
});
