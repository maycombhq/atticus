import { describe, expect, it } from "vitest";
import { assistantSession } from "../src/assistant-session.js";

// ADR 0115 addendum (2026-10-25): `atticus finding` with no --by, run in a coding assistant's
// terminal, records the assistant, not the Git user, so its decision is only a proposal.
describe("assistantSession", () => {
  it("names the assistant whose terminal the command runs in", () => {
    expect(assistantSession({ CLAUDECODE: "1" })).toEqual({
      by: "claude-code",
      because: "CLAUDECODE is set",
    });
    expect(assistantSession({ GEMINI_CLI: "1" })?.by).toBe("gemini-cli");
    expect(assistantSession({ CURSOR_AGENT: "1" })?.by).toBe("cursor");
  });

  it("takes ATTICUS_ASSISTANT, and reads an unknown name as an assistant all the same", () => {
    expect(assistantSession({ ATTICUS_ASSISTANT: "copilot" })?.by).toBe("copilot");
    expect(assistantSession({ ATTICUS_ASSISTANT: "northwind-helper" })?.by).toBe(
      "northwind-helper-assistant",
    );
  });

  it("is nothing in a person's own terminal", () => {
    expect(assistantSession({ TERM: "xterm", CLAUDECODE: "0" })).toBeUndefined();
  });
});
