import { describe, expect, it } from "vitest";
import { checkStories, StoriesAnswerSchema, type DeltaStory } from "../src/stages/stories.js";

const story = (kind: string, op: "add" | "change" | "remove" = "add"): DeltaStory => ({
  id: "s1",
  repo: "forge-ledger",
  flow: "ledger-api.post-entry",
  name: "Post an entry",
  change: "modify" as DeltaStory["change"],
  tasks: [
    {
      id: "t1",
      story: "s1",
      repo: "forge-ledger",
      flow: "ledger-api.post-entry",
      op,
      position: 2,
      kind,
      title: "Check the daily limit",
      what: "reject an entry over the daily limit",
      fields: ["amount"],
      evidence: [],
    },
  ],
});

const answer = (criteria: unknown[]) =>
  StoriesAnswerSchema.parse({
    stories: [
      {
        id: "s1",
        title: "Daily limit",
        asA: "a teller",
        iWant: "entries over the limit refused",
        soThat: "the ledger stays within policy",
        tasks: [{ id: "t1", criteria }],
      },
    ],
  });

describe("a task that can fail has an error criterion (ADR 0124, Part 3)", () => {
  it("asks for one on a validate, write, call-out or publish step, not blocking yet", () => {
    for (const kind of ["validate", "write", "call-out", "publish"]) {
      const issues = checkStories(
        answer([{ text: "Given 50, when posted, then amount 50 is saved", checks: ["amount"] }]),
        [story(kind)],
        [],
        [],
      );
      const e = issues.find((i) => i.rule === "stories.no-error-case");
      expect(e, kind).toBeTruthy();
      expect(e!.blocking).toBe(false);
    }
  });
  it("is satisfied by an outcome: error criterion, and not asked of a read, a respond or a removed step", () => {
    const ok = checkStories(
      answer([
        { text: "Given 50, when posted, then amount 50 is saved", checks: ["amount"] },
        {
          text: "Given 5000 over the limit, when posted, then 422 and amount is not saved",
          checks: ["amount"],
          outcome: "error",
        },
      ]),
      [story("validate")],
      [],
      [],
    );
    expect(ok.map((i) => i.rule)).not.toContain("stories.no-error-case");
    for (const [kind, op] of [
      ["read", "add"],
      ["respond", "add"],
      ["write", "remove"],
    ] as const) {
      const issues = checkStories(
        answer([{ text: "Given x, when y, then amount is z", checks: ["amount"] }]),
        [story(kind, op)],
        [],
        [],
      );
      expect(
        issues.map((i) => i.rule),
        `${kind} ${op}`,
      ).not.toContain("stories.no-error-case");
    }
  });
  it("reads a bare-string criterion as a success", () => {
    const a = answer(["Given x, when y, then z"]);
    expect(a.stories[0]!.tasks[0]!.criteria[0]).toEqual({
      text: "Given x, when y, then z",
      checks: [],
      outcome: "success",
    });
  });
});
