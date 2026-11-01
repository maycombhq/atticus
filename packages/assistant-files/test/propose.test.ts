import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { QuestionProposal } from "@maycombhq/core";
import { metarepoCommands, PROPOSAL_SHAPE, proposeCommand } from "../src/index.js";

/** /atticus-propose (ADR 0144, Q5): the assistant proposes, a person confirms. */

describe("/atticus-propose", () => {
  it("is a metarepo step command", () => {
    expect(metarepoCommands().find((c) => c.name === "atticus-propose")).toEqual(proposeCommand());
  });

  it("shows the shape Atticus checks proposals with", () => {
    const yaml = PROPOSAL_SHAPE.replace(/^```yaml\n|\n```$/g, "")
      .replace("<your assistant's name>", "claude-code")
      .replace("<now, ISO 8601>", "2026-10-31T12:00:00.000Z");
    expect(QuestionProposal.safeParse(parse(yaml)).success).toBe(true);
  });

  it("never answers: it checks with questions proposed and leaves accepting to a person", () => {
    const b = proposeCommand().body;
    expect(b).toContain("`atticus questions proposed`");
    expect(b).toContain("Never run `atticus questions answer` yourself");
    expect(b).toContain("never guess");
  });
});
