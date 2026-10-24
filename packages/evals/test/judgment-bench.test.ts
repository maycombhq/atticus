import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { judgmentTable, runJudgmentBench } from "../src/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("the judgments' eval (ADR 0117)", () => {
  it("scores each replaced judgment against the old heuristic, on the recorded verdicts", async () => {
    const rows = await runJudgmentBench(ROOT);
    console.log(`\n${judgmentTable(rows)}\n`);
    const by = Object.fromEntries(rows.map((r) => [r.kind, r]));
    // Every replaced judgment is at least as right as the rule it replaced, and never says yes
    // where the truth is no: no reused answer, no passed value, no untested field.
    for (const r of rows) {
      expect({ kind: r.kind, better: r.model.correct >= r.old.correct }).toEqual({
        kind: r.kind,
        better: true,
      });
      expect({ kind: r.kind, wrongYes: r.model.wrongYes }).toEqual({ kind: r.kind, wrongYes: 0 });
    }
    // The audit's failing examples, one by one.
    expect(by["same-question"]!.old.wrong).toEqual(
      expect.arrayContaining([
        "renamed-at-vs-renamed-by",
        "retry-timeout-vs-5xx",
        "nullable-vs-shown",
      ]),
    );
    expect(by["same-question"]!.model.wrong).toEqual([]);
    expect(by["covers-field"]!.old.wrong).toEqual(
      expect.arrayContaining(["id-inside-valid", "renamed-event-not-field"]),
    );
    expect(by["states-value"]!.old.wrong).toEqual(
      expect.arrayContaining([
        "three-days-in-approvers",
        "no-sign-off-is-not-a-ban",
        "date-scattered",
      ]),
    );
    // A hand-off spends no judge call and reuses no answer it hasn't been shown.
    expect(by["same-question"]!.handoff.wrongYes).toBe(0);
    // One batched call per kind with open items.
    expect(by["same-question"]!.prompts).toBeLessThanOrEqual(by["same-question"]!.cases);
    expect(by["covers-field"]!.prompts).toBe(1);
    expect(by["states-value"]!.prompts).toBeGreaterThan(0);
  });
});
