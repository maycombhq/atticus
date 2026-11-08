import { describe, expect, it } from "vitest";
import { titledText } from "../src/stages/expand.js";

describe("titledText (sixth UX walk)", () => {
  it("puts the title over the text once", () => {
    expect(titledText("Show an account's status", "Why: tellers ask.\n")).toBe(
      "# Show an account's status\n\nWhy: tellers ask.\n",
    );
    const brief = "# Show an account's status\n\nWhy: tellers ask.\n";
    expect(titledText("Show an account's status", brief)).toBe(brief);
    expect(titledText("Show an account's status", `\r\n${brief.replace(/\n/g, "\r\n")}`)).toContain(
      "Why",
    );
    expect(titledText(undefined, "text")).toBe("text");
    expect(titledText("Other", brief)).toBe(`# Other\n\n${brief}`);
  });
});
