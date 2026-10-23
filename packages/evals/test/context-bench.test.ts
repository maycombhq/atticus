import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENGINE_DEFAULT } from "@maycombhq/planner";
import { engineSwitches, renderContextTable, runContextBench } from "../src/index.js";

// ADR 0107 point 6: the context engine's eval, on the Forge fixtures and their golden answers.

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("the context engine's eval", () => {
  it("scores each step with the whole lists and with the engine, and the checked-in table is up to date", async () => {
    const rows = await runContextBench({ fixtures: join(REPO, "fixtures") });
    // Four steps, five cases, two budgets, two modes.
    expect(rows).toHaveLength(20);
    // The whole lists drop whole when the budget is tight; the engine fits what matters.
    const at = (step: string, c: string, budget: string, mode: string) =>
      rows.find((r) => r.step === step && r.case === c && r.budget === budget && r.mode === mode)!;
    expect(at("feature", "shop: add-fraud-check", "tight", "whole lists").recall).toBe(0);
    expect(at("feature", "shop: add-fraud-check", "tight", "engine").recall).toBe(1);
    // A step uses the engine by default only where its recall is at least the whole lists'.
    const sw = engineSwitches(rows);
    for (const r of rows.filter((x) => x.mode === "engine" && sw[x.step])) {
      const whole = at(r.step, r.case, r.budget, "whole lists");
      expect(r.recall, `${r.step} ${r.case} ${r.budget}`).toBeGreaterThanOrEqual(whole.recall);
    }
    expect(sw).toEqual(ENGINE_DEFAULT);
    const doc = readFileSync(join(REPO, "docs/evidence/context-eval.md"), "utf8");
    expect(doc, "run node packages/evals/scripts/write-context-eval.mjs").toBe(
      renderContextTable(rows),
    );
  }, 300_000);
});
