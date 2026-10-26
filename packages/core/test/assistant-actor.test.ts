import { describe, expect, it } from "vitest";
import { assistantActor, isAssistantResolution } from "../src/index.js";

// ADR 0115 addendum (2026-10-25, finding integrity): a `by` that names an AI, never a person,
// can only propose a resolution of a blocking or risk finding.
describe("assistantActor", () => {
  it("knows the assistants Atticus writes files for, by id and by their short name", () => {
    for (const by of ["claude", "Claude", "claude-code", "copilot", "cursor", "gemini-cli"])
      expect(assistantActor(by)).toBe(by.trim());
  });

  it("knows runtime kinds, generic words for an AI, and a Git host's bot accounts", () => {
    for (const by of [
      "hand-off",
      "headless-claude-code",
      "assistant",
      "ai",
      "agent",
      "renovate[bot]",
      "ci-bot",
      "copilot-agent",
      "ai-reviewer",
    ])
      expect(assistantActor(by)).toBe(by);
  });

  it("knows the org pack's agents and models when the caller passes them", () => {
    expect(assistantActor("feature-placer", ["feature-placer"])).toBe("feature-placer");
    expect(assistantActor("northwind-model-2", ["northwind-model-2"])).toBe("northwind-model-2");
    expect(assistantActor("feature-placer")).toBeUndefined();
  });

  it("reads an email's local part", () => {
    expect(assistantActor("copilot@forge.example")).toBe("copilot@forge.example");
    expect(assistantActor("pat@forge.example")).toBeUndefined();
  });

  it("leaves people alone, including names that only contain an AI word", () => {
    for (const by of ["pat", "tia", "maia", "aidan", "agentina", "robot-arm-team", "someone"])
      expect(assistantActor(by)).toBeUndefined();
  });

  it("says whether a finding's resolution was an assistant's", () => {
    expect(isAssistantResolution({ by: "claude" })).toBe(true);
    expect(isAssistantResolution({ by: "pat" })).toBe(false);
    expect(isAssistantResolution(undefined)).toBe(false);
  });
});
