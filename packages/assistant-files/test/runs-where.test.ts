import { describe, expect, it } from "vitest";
import { Runtime } from "@maycombhq/core";
import type { ProbeResult } from "../src/probe.js";
import { probedAssistant, whatRunsWhere } from "../src/runs-where.js";

/** ADR 0121 item 6: one line saying which mode, assistant and model run a step. */

const rt = (o: Record<string, unknown>) =>
  Runtime.parse({
    schemaVersion: 1,
    assistants: { allowed: ["copilot"], default: "copilot" },
    ...o,
  });

describe("what runs a step here (ADR 0121)", () => {
  it("names the assistant a step is handed to", () => {
    expect(whatRunsWhere(rt({}))).toBe("Hand-off to GitHub Copilot");
  });

  it("adds the model mode that is allowed, with its provider and model", () => {
    expect(
      whatRunsWhere(
        rt({
          modes: { allowed: ["hand-off", "model"], default: "hand-off" },
          adapters: { model: { type: "anthropic", settings: { model: "claude-opus-5-5" } } },
        }),
      ),
    ).toBe("Hand-off to GitHub Copilot · model mode allowed: anthropic claude-opus-5-5");
  });

  it("says model mode first when it is the default, and when it has no provider yet", () => {
    expect(
      whatRunsWhere(
        rt({
          assistants: { allowed: ["copilot", "cursor"], default: "cursor" },
          modes: { allowed: ["hand-off", "model"], default: "model" },
          adapters: { model: { type: "bedrock", settings: {} } },
        }),
      ),
    ).toBe("Model mode: bedrock · hand-off to Cursor allowed");
    expect(whatRunsWhere(rt({ modes: { allowed: ["model"], default: "model" } }))).toBe(
      "Model mode, but no model provider is set up (Set up › AI)",
    );
  });

  it("says headless Claude Code, text only, and off", () => {
    expect(
      whatRunsWhere(
        rt({
          assistants: { allowed: ["claude-code"], default: "claude-code" },
          modes: { allowed: ["headless-claude-code", "hand-off"], default: "headless-claude-code" },
          ai: "text-only",
        }),
      ),
    ).toBe("Headless Claude Code · hand-off to Claude Code allowed · text only: no pictures sent");
    expect(whatRunsWhere(rt({ ai: "off" }))).toBe(
      "AI is off here: people write what agents would draft",
    );
  });

  it("names the assistant atticus probe measured here, with its tier (a real metarepo, 2026-10-25)", () => {
    const probe = (assistant: ProbeResult["assistant"], measured: string, tier: 1 | 2 | 3) =>
      ({
        schemaVersion: 1,
        assistant,
        measured,
        tier,
        read: true,
        write: tier < 3,
        run: tier === 1,
        answered: "command",
      }) as ProbeResult;
    const both = rt({ assistants: { allowed: ["copilot", "claude-code"], default: "copilot" } });
    const probes = [probe("claude-code", "2026-10-24T09:00:00Z", 1)];
    expect(probedAssistant(both, probes)).toBe("claude-code");
    expect(whatRunsWhere(both, { probes })).toBe(
      "Hand-off to Claude Code, agentic (tier 1) as atticus probe measured it",
    );
    // The newest measurement of an assistant runtime.yaml allows; none: the default, unchanged.
    const two = [...probes, probe("copilot", "2026-10-25T09:00:00Z", 2)];
    expect(whatRunsWhere(both, { probes: two })).toBe(
      "Hand-off to GitHub Copilot, batched hand-off (tier 2) as atticus probe measured it",
    );
    expect(probedAssistant(rt({}), probes)).toBeUndefined();
    expect(whatRunsWhere(rt({}), { probes })).toBe("Hand-off to GitHub Copilot");
    expect(whatRunsWhere(both, { probes: [] })).toBe("Hand-off to GitHub Copilot");
  });
});
