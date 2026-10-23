import { describe, expect, it } from "vitest";
import {
  buildContextPack,
  currentPromptLimit,
  fitBudget,
  PROMPT_FRAME_TOKENS,
  PROMPT_MARGIN,
  promptBudget,
  PromptTooLong,
  withPromptLimit,
  type SourceInput,
} from "../src/index.js";

/**
 * ADR 0112: every prompt fits the model it goes to. A step given the model's limit (--max-tokens)
 * builds its pack to fit it, counted as the pack counts (characters / 4) with a margin, and says
 * before handing off when even its smallest useful prompt can't fit.
 */

const NOW = new Date("2026-10-23T09:00:00Z");
const LEVELS = ["public", "internal", "confidential", "restricted"] as const;

const instructions = (chars: number): SourceInput => ({
  id: "0-task",
  kind: "instruction",
  origin: "atticus/test",
  text: "i".repeat(chars),
  classification: "public",
  trusted: true,
});
const data = (id: string, chars: number, priority = 10): SourceInput => ({
  id,
  kind: "code",
  origin: `forge-orders:${id}`,
  text: "d".repeat(chars),
  classification: "internal",
  priority,
});

const pack = (sources: SourceInput[], o: { budget?: number; maxTokens?: number } = {}) =>
  buildContextPack({
    change: "add-fraud-check",
    agent: "spec-drafter",
    budget: o.budget ?? 150_000,
    sources,
    levels: LEVELS,
    maxClassification: "internal",
    now: NOW,
    ...(o.maxTokens ? { maxTokens: o.maxTokens } : {}),
  });

describe("the prompt budget for a model's limit (ADR 0112)", () => {
  it("is the limit less a quarter for the counter's error, less the hand-off frame", () => {
    expect(PROMPT_MARGIN).toBe(0.25);
    expect(PROMPT_FRAME_TOKENS).toBe(400);
    // Copilot's GPT-4o mini: 12,078 tokens.
    expect(promptBudget(12_078)).toBe(Math.floor(12_078 * 0.75) - 400);
    expect(promptBudget(12_078)).toBe(8658);
    expect(fitBudget(150_000, 12_078)).toBe(8658);
    // A step's own budget below the model's stays.
    expect(fitBudget(5000, 12_078)).toBe(5000);
    expect(fitBudget(150_000)).toBe(150_000);
  });

  it("cuts a pack to the model's limit, keeping the highest priority first", () => {
    const p = pack([instructions(4000), data("a", 20_000, 30), data("b", 20_000, 20)], {
      maxTokens: 12_078,
    });
    expect(p.manifest.budget).toBe(8658);
    expect(p.manifest.totalTokens).toBeLessThanOrEqual(8658);
    expect(p.manifest.sources.map((s) => s.id)).toEqual(["0-task", "a"]);
    expect(p.manifest.dropped).toEqual([{ id: "b", reason: "over the 8658-token budget" }]);
  });

  it("takes the limit from the step it runs in, when the pack isn't given one", async () => {
    expect(currentPromptLimit()).toBeUndefined();
    const p = await withPromptLimit(12_078, async () => {
      expect(currentPromptLimit()).toBe(12_078);
      expect(fitBudget(150_000)).toBe(8658);
      return pack([instructions(400), data("a", 40_000)]);
    });
    expect(p.manifest.budget).toBe(8658);
    expect(p.manifest.dropped.map((d) => d.id)).toEqual(["a"]);
    expect(currentPromptLimit()).toBeUndefined();
  });

  it("says, before anything is handed off, when the smallest useful prompt can't fit", () => {
    let e: unknown;
    try {
      buildContextPack({
        change: "add-fraud-check",
        agent: "spec-drafter",
        budget: 150_000,
        sources: [instructions(8000), data("4-catalog", 40_000, 40), data("x", 400)],
        levels: LEVELS,
        maxClassification: "internal",
        now: NOW,
        maxTokens: 12_078,
        required: ["4-catalog"],
        step: "spec draft forge-orders",
        smaller: "draft fewer flows at a time",
      });
    } catch (x) {
      e = x;
    }
    expect(e).toBeInstanceOf(PromptTooLong);
    const t = e as PromptTooLong;
    // The rule (50), the instructions (2000) and the catalog wrapped as data (10,023).
    expect(t.needed).toBe(12_073);
    expect(t.budget).toBe(8658);
    expect(t.maxTokens).toBe(12_078);
    expect(t.message).toBe(
      `atticus spec draft forge-orders can't fit its smallest useful prompt in the model: it needs about ${t.needed} tokens (its instructions and 4-catalog), and a model of 12078 tokens leaves 8658 for the prompt. Use a model with a bigger limit (atticus.model in VS Code, or adapters.model in runtime.yaml), or draft fewer flows at a time.`,
    );
  });

  it("names only the instructions when nothing else is required, and only with a limit", () => {
    expect(() => pack([instructions(40_000)], { maxTokens: 12_078 })).toThrow(
      /needs about 10\d\d\d tokens \(its instructions\)/,
    );
    // Without a model limit a too-big pack is still the old error.
    expect(() => pack([instructions(40_000)], { budget: 5000 })).toThrow(
      "instructions alone (10050 tokens) exceed the 5000-token budget",
    );
  });
});
