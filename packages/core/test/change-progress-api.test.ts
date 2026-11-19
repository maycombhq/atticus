import { describe, expect, it } from "vitest";
import { API_VERSION, Api, openApiDocument } from "../src/index.js";

/** API 2.25.0 (ADR 0124 addendum B-change): where a change's stages are against its state. */
describe("a change read from its stages' files (C4 2.25.0)", () => {
  it("is 2.25.0 or later, and the cockpit may say where the work is; an older cockpit still parses", () => {
    const [major, minor] = API_VERSION.split(".").map(Number);
    expect(major! > 2 || (major === 2 && minor! >= 25)).toBe(true);
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

/** API 3.18.0 (ADR 0201): a change says whether it takes the quick path. */
describe("a change on the quick path (C4 3.18.0)", () => {
  const row = {
    id: "shipped-orders-event",
    title: "Shipped-orders event",
    type: "quick",
    state: "plan",
    repos: [],
    openFindings: { blocking: 0, gap: 0, risk: 0, idea: 0 },
    updatedAt: "2026-11-18T09:00:00Z",
  };

  it("is 3.18.0 or later, and a change row may say quickPath; an older row still parses", () => {
    const [major, minor] = API_VERSION.split(".").map(Number);
    expect(major! > 3 || (major === 3 && minor! >= 18)).toBe(true);
    expect(Api.ChangeSummary.parse({ ...row, quickPath: true }).quickPath).toBe(true);
    expect(Api.ChangeSummary.parse(row).quickPath).toBeUndefined();
    expect(Api.ChangeSummary.safeParse({ ...row, quickPath: "yes" }).success).toBe(false);
  });

  it("is in the OpenAPI document, beside fastPath", () => {
    const doc = openApiDocument() as {
      info: { version: string };
      components: { schemas: Record<string, { properties: Record<string, unknown> }> };
    };
    expect(doc.info.version).toBe(API_VERSION);
    const props = doc.components.schemas.ChangeSummary!.properties;
    expect(Object.keys(props)).toEqual(expect.arrayContaining(["fastPath", "quickPath"]));
  });
});
