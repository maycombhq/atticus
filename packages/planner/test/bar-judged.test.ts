import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HandoffRuntime, judgeStandIn } from "@maycombhq/ai";
import { DEFAULT_TEST_STRATEGY, memoryJudgments } from "@maycombhq/core";
import { DEFAULT_DOR_CHECKS, dorChecks } from "../src/index.js";

/**
 * ADR 0117 addendum: which of the readiness bar's checks a definition-of-ready item asks for is
 * a judgment (the word rule dorChecks read "user" as who and "acceptance" as criteria). Atticus's
 * own default items carry the checks they were written with; another item is judged and kept.
 */

const NOW = new Date("2026-10-23T12:00:00Z");
const ITEMS = [
  "Dependencies named",
  "The services and codebases it changes are listed",
  "Acceptance by the product owner is recorded before the sprint starts",
];

describe("the definition of ready's checks", () => {
  it("knows the default items' checks, the same words Atticus ships", () => {
    expect(Object.keys(DEFAULT_DOR_CHECKS)).toEqual(DEFAULT_TEST_STRATEGY.definitionOfReady);
  });

  it("asks the judge of an org's own items in one prompt, and keeps the verdicts", async () => {
    const judge = judgeStandIn(
      (it) => {
        const check = it.facts[0] ?? "";
        const yes =
          it.texts.item!.startsWith("The services and codebases") &&
          check.includes("names the systems and repos");
        return {
          verdict: yes ? "yes" : "no",
          quotes: [{ of: "item", text: it.texts.item! }],
        };
      },
      { now: () => NOW },
    );
    const store = memoryJudgments();
    const dor = await dorChecks(ITEMS, { runtime: judge.runtime, store, change: "c", now: NOW });
    expect(judge.calls()).toBe(1);
    expect(dor).toEqual([
      { item: ITEMS[0], checks: ["depends"] },
      { item: ITEMS[1], checks: ["systems"] },
      // "Acceptance" is not acceptance criteria: the judge read the item.
      { item: ITEMS[2], checks: [] },
    ]);
    // Read back with no model: the same checks, nothing asked.
    expect(await dorChecks(ITEMS, { store, change: "c", now: NOW })).toEqual(dor);
    expect(judge.calls()).toBe(1);
  });

  it("with the hand-off runtime runs only the known checks, and lists the rest for a person", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-bar-"));
    const runtime = new HandoffRuntime({ root, validate: async () => [], now: () => NOW });
    const dor = await dorChecks(ITEMS, {
      runtime,
      store: memoryJudgments(),
      change: "c",
      now: NOW,
    });
    expect(dor[0]).toEqual({ item: ITEMS[0], checks: ["depends"] });
    expect(dor[1]).toMatchObject({ item: ITEMS[1], checks: [] });
    expect(dor[1]!.notJudged).toHaveLength(6);
    expect(dor[2]!.notJudged).toHaveLength(6);
  });
});
