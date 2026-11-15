import { describe, expect, it } from "vitest";
import { Api } from "@maycombhq/core";
import { confirmOf } from "../src/verify-preview.js";

/**
 * Beta.28.1 (field hunt G1, the last re-review): what the preview says of the next Apply's guards.
 * Only what a person can confirm gets a command; a refusal nothing confirms (removals nothing
 * explains, an empty build, nothing read) is said as refused, with its reasons and no command; a
 * catalog from before the slots points at `atticus upgrade`.
 */
const R = "forge-payments";
const view = (c: ReturnType<typeof confirmOf>) =>
  Api.VerifyPreviewView.shape.preview.unwrap().shape.confirm.parse(c);

describe("the preview's word on the Apply's guards", () => {
  it("says nothing when the guards pass", () => {
    expect(confirmOf(R, undefined)).toBeUndefined();
  });

  it("gives the command for large removals and hand edits, with their counts", () => {
    expect(view(confirmOf(R, { reasons: ["large-removals"], allowRemovals: 7 }))).toEqual({
      removals: 7,
      command: `atticus verify ${R} --write --allow-removals 7`,
    });
    expect(
      view(
        confirmOf(R, {
          reasons: ["large-removals", "hand-edits"],
          allowRemovals: 7,
          discardEdits: 3,
        }),
      ),
    ).toEqual({
      removals: 7,
      edits: 3,
      command: `atticus verify ${R} --write --allow-removals 7 --discard-edits 3`,
    });
  });

  it("says a refusal nothing confirms as refused, with no command that won't help", () => {
    for (const reasons of [
      ["unexplained-removals"],
      ["unexplained-removals", "large-removals"],
      ["empty"],
      ["nothing-read"],
    ] as const) {
      const c = view(confirmOf(R, { reasons: [...reasons], allowRemovals: 7 }));
      expect(c?.refused, reasons.join()).toEqual(reasons.filter((x) => x !== "large-removals"));
      expect(c?.command).toBeUndefined();
    }
  });

  it("points a catalog from before the slots at atticus upgrade, not --discard-edits", () => {
    expect(view(confirmOf(R, { reasons: ["not-upgraded"], discardEdits: 40 }))).toEqual({
      upgrade: true,
      command: "atticus upgrade",
    });
  });
});
