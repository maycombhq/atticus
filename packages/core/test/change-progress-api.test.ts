import { describe, expect, it } from "vitest";
import { API_VERSION, Api } from "../src/index.js";

/** API 2.25.0 (ADR 0124 addendum B-change): where a change's stages are against its state. */
describe("a change read from its stages' files (C4 2.25.0)", () => {
  it("is 2.25.0 or later, and the cockpit may say where the work is; an older cockpit still parses", () => {
    const [major, minor] = API_VERSION.split(".").map(Number);
    expect(major).toBe(2);
    expect(minor).toBeGreaterThanOrEqual(25);
    const cockpit = {
      id: "screen-orders",
      state: "define",
      nextStep: 'Ready to raise "Send to architecture".',
      reasons: [],
      risk: { level: "high", score: 13 },
      stages: [
        { stage: "feature", state: "done", drafts: 1, rounds: 1, openQuestions: 0 },
        { stage: "architecture", state: "done", drafts: 1, rounds: 1, openQuestions: 0 },
        { stage: "stories", state: "done", drafts: 1, rounds: 1, openQuestions: 0 },
      ],
      openQuestions: 0,
      repos: [],
    };
    const work =
      'Stories done; the change is still in define: raise "Send to architecture" (the define hand-off), then the design and plan hand-offs.';
    expect(Api.ChangeCockpit.parse({ ...cockpit, work }).work).toBe(work);
    expect(Api.ChangeCockpit.parse(cockpit).work).toBeUndefined();
  });
});
