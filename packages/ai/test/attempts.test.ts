import { describe, expect, it } from "vitest";
import { AgentDefinition } from "@maycombhq/core";
import { buildContextPack, resumedAttempt, type Run } from "../src/index.js";

/**
 * A step that checks its AI answer hands back what failed, for another attempt. Through a
 * hand-off each attempt is a new run, resumed by the command line; the count of attempts must
 * carry across, or a step that never gets a good answer hands it back forever. And an answer
 * word for word the last one won't pass checks it just failed, so asking again is pointless.
 */

const agent = AgentDefinition.parse({
  schemaVersion: 1,
  id: "story-writer",
  role: "business-analyst",
  description: "Writes user stories with Given/When/Then acceptance criteria from the design.",
  inputs: ["proposal"],
  outputArtifact: "stories",
  checklist: "forge-architecture",
  tokenBudget: 4000,
  allowedRuntimes: ["hand-off"],
});

const runWith = (handedBack: { attempt: number; answer: string }[], output?: string): Run => {
  const pack = buildContextPack({
    change: "knowledge-scan",
    agent: agent.id,
    budget: 4000,
    levels: ["public", "internal"],
    maxClassification: "internal",
    now: new Date("2026-10-23T03:00:00Z"),
    sources: [
      {
        id: "task",
        kind: "instruction",
        origin: "task",
        text: "Read the pages.",
        classification: "internal",
        trusted: true,
      },
      ...handedBack.flatMap((h) => [
        {
          id: `${h.attempt}-previous`,
          kind: "document" as const,
          origin: `attempt ${h.attempt}`,
          text: h.answer,
          classification: "internal",
        },
        {
          id: `${h.attempt}-problems`,
          kind: "document" as const,
          origin: `checks on attempt ${h.attempt}`,
          text: "- the quote is not on the page",
          classification: "internal",
        },
      ]),
    ],
  });
  return {
    runId: "run-1",
    request: { change: "knowledge-scan", agent, pack, outputPath: "knowledge-items.yaml" },
    runtime: "hand-off",
    state: "produced",
    attempt: 1,
    startedAt: "2026-10-23T03:00:00Z",
    errors: [],
    ...(output !== undefined ? { output } : {}),
  };
};

describe("an attempt resumed from a hand-off", () => {
  it("is the first when nothing was handed back", () => {
    expect(resumedAttempt(runWith([], "items: []\n"))).toEqual({ attempt: 1, repeats: false });
  });

  it("is one after the last attempt whose checks were handed back", () => {
    expect(
      resumedAttempt(runWith([{ attempt: 2, answer: "items: [a]\n" }], "items: [b]\n")),
    ).toEqual({
      attempt: 3,
      repeats: false,
    });
  });

  it("knows an answer word for word the one that just failed", () => {
    expect(
      resumedAttempt(runWith([{ attempt: 1, answer: "items: [a]\n" }], "items: [a]\n")),
    ).toEqual({
      attempt: 2,
      repeats: true,
    });
  });
});
