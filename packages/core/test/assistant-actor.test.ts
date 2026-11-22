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
    // Atticus's own agents are known whatever the caller passes.
    expect(assistantActor("feature-placer")).toBe("feature-placer");
    expect(assistantActor("ledger-architect")).toBeUndefined();
  });

  it("matches the known names exactly, never as part of a person's name or address", () => {
    const known = ["judge", "critic", "naysayer", "feature-placer", "ledger-architect"];
    for (const by of [
      "judge",
      "Judge",
      "critic",
      "feature-placer",
      "ledger-architect",
      // The part before @ too, for Atticus's own agents: its name as an address is the agent.
      "feature-placer@forge.example",
      "judge@forge.example",
    ])
      expect(assistantActor(by, known), by).toBe(by);
    for (const by of [
      "m.judge@forge.example",
      "judge.smith",
      "critic.anna@forge.example",
      "feature-placer.fan",
      "pat.naysayer",
      "ledger-architect-team",
    ])
      expect(assistantActor(by, known), by).toBeUndefined();
  });

  it("reads an address's local part as Atticus's own agent only, never as an org pack's persona", () => {
    // Persona names are often a role's: a team mailbox of that name is a person.
    const known = ["security", "qa", "developer", "product-owner", "ledger-architect"];
    for (const by of known) expect(assistantActor(by, known), by).toBe(by);
    for (const by of [
      "security@forge.example",
      "qa@forge.example",
      "developer@forge.example",
      "product-owner@forge.example",
      "ledger-architect@forge.example",
    ])
      expect(assistantActor(by, known), by).toBeUndefined();
    // Atticus's own agents, whether or not the caller passes them.
    for (const by of ["feature-placer@forge.example", "task-runner@forge.example", "judge"])
      expect(assistantActor(by), by).toBe(by);
  });

  it("knows a handle ending -critic or -naysayer, but not an address or a dotted name", () => {
    for (const by of ["true-critic", "application-architect-naysayer", "ledger-api-critic"])
      expect(assistantActor(by), by).toBe(by);
    for (const by of [
      "pat-critic@forge.example",
      "anna.critic",
      "j.naysayer",
      "film critic",
      "pat_critic",
      "critical-path-team",
    ])
      expect(assistantActor(by), by).toBeUndefined();
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
