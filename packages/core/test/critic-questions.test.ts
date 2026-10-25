import { describe, expect, it } from "vitest";
import {
  ChecklistRule,
  CriticQuestion,
  DEFAULT_CHANGE_TYPES,
  Finding,
  LEGACY_LENSES,
  Lens,
  lensCovers,
  questionOfLens,
} from "../src/index.js";

/**
 * The critic asks four questions (ADR 0124 addendum, Part 4). C3 gains them additively: the four
 * question ids are lenses, a rule may say which question it answers, and the seven role lenses
 * an org pack wrote before keep parsing and map to a question.
 */

const rule = {
  id: "r",
  title: "A rule",
  layer: "org",
  appliesTo: { artifacts: ["design"] },
  severity: "risk",
  check: { type: "ai", prompt: "Report what the design leaves out, quoting it." },
  waivable: false,
  source: "test",
};

describe("the critic's four questions in C3", () => {
  it("names the four questions, first among the lenses", () => {
    expect(CriticQuestion.options).toEqual(["true", "complete", "safe", "ship"]);
    expect(Lens.options.slice(0, 4)).toEqual(["true", "complete", "safe", "ship"]);
    expect(LEGACY_LENSES).toEqual([
      "business",
      "architecture",
      "story",
      "ux",
      "delivery",
      "code-and-test",
      "release",
    ]);
  });

  it("maps each old lens to the question that took it over, and what it covered", () => {
    expect(Object.fromEntries(LEGACY_LENSES.map((l) => [l, questionOfLens(l)]))).toEqual({
      business: "complete",
      architecture: "true",
      story: "complete",
      ux: "complete",
      delivery: "ship",
      "code-and-test": "complete",
      release: "ship",
    });
    for (const q of CriticQuestion.options) expect(questionOfLens(q)).toBe(q);
    // The architecture lens reviewed security too, so a change type that lists it covers safe.
    expect(lensCovers("architecture")).toEqual(["true", "safe"]);
    expect(lensCovers("ux")).toEqual(["complete"]);
    expect(lensCovers("safe")).toEqual(["safe"]);
  });

  it("reads a rule with an old lens, a question lens, or an old lens and a question", () => {
    expect(ChecklistRule.parse({ ...rule, lens: "ux" }).question).toBeUndefined();
    expect(ChecklistRule.parse({ ...rule, lens: "ship" }).lens).toBe("ship");
    expect(ChecklistRule.parse({ ...rule, lens: "architecture", question: "safe" }).question).toBe(
      "safe",
    );
    expect(
      ChecklistRule.safeParse({ ...rule, lens: "architecture", question: "fast" }).success,
    ).toBe(false);
  });

  it("refuses a question that contradicts the rule's question lens", () => {
    const r = ChecklistRule.safeParse({ ...rule, lens: "ship", question: "safe" });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/lens ship already names the question/);
  });

  it("keeps finding files written with an old lens readable, and takes a question lens", () => {
    const f = {
      schemaVersion: 1,
      id: "f1",
      kind: "issue",
      change: "c",
      gate: "plan",
      round: 1,
      rule: "r",
      layer: "org",
      severity: "risk",
      artifact: "design.md",
      locator: { line: 3 },
      summary: "Something.",
      why: "Because.",
      fix: { text: "Fix it." },
      evidence: [{ source: "artifact", path: "design.md", line: 3 }],
      waivable: false,
      createdAt: "2026-10-24T09:00:00Z",
    };
    expect(Finding.parse({ ...f, lens: "delivery" }).lens).toBe("delivery");
    expect(Finding.parse({ ...f, lens: "ship" }).lens).toBe("ship");
  });
});

describe("the default change types ask the four questions (the product owner, 2026-10-24)", () => {
  it("lists each type's questions instead of the old lens names, covering what the old lenses did", () => {
    expect(Object.fromEntries(DEFAULT_CHANGE_TYPES.types.map((t) => [t.id, t.lenses]))).toEqual({
      feature: ["true", "complete", "safe", "ship"],
      integration: ["true", "complete", "safe", "ship"],
      "bug-fix": ["complete", "ship"],
      "emergency-fix": ["complete", "ship"],
      "config-change": ["true", "safe", "ship"],
      "tech-debt": ["true", "complete", "safe"],
      "small-change": ["true", "complete", "safe", "ship"],
    });
    // Each type asks exactly the questions its old lenses covered (the architecture lens covered
    // true and safe), so a rule written for a question applies to the same types as before.
    const OLD: Record<string, Lens[]> = {
      feature: [...LEGACY_LENSES],
      integration: ["business", "architecture", "story", "delivery", "code-and-test", "release"],
      "bug-fix": ["story", "code-and-test", "release"],
      "emergency-fix": ["code-and-test", "release"],
      "config-change": ["architecture", "release"],
      "tech-debt": ["architecture", "code-and-test"],
      "small-change": ["architecture", "story", "code-and-test", "release"],
    };
    for (const t of DEFAULT_CHANGE_TYPES.types) {
      const covered = new Set(OLD[t.id]!.flatMap(lensCovers));
      expect(t.lenses, t.id).toEqual(CriticQuestion.options.filter((q) => covered.has(q)));
    }
  });
});
