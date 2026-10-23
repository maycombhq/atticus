import { describe, expect, it } from "vitest";
import { attachPaths, START_WORDS, startTaskChat } from "../src/task-start";

/** ADR 0113: Start this task in Copilot, and Attach to Atticus change. */
describe("Start this task in Copilot", () => {
  const md = "# Task 1.1 of return-order-time: Change the respond step\n\n## Acceptance criteria\n";

  it("opens Copilot Chat in agent mode with /atticus-task where the prompt file is written", () => {
    expect(startTaskChat("return-order-time", "1.1", md, true)).toEqual({
      query: "/atticus-task return-order-time 1.1",
      mode: "agent",
      isPartialQuery: true,
    });
  });

  it("puts the context itself in the box where it isn't, for the person to send", () => {
    const c = startTaskChat("return-order-time", "1.1", md, false);
    expect(c.mode).toBe("agent");
    expect(c.isPartialQuery).toBe(true);
    expect(c.query).toMatch(/^Implement task 1\.1 of the Atticus change return-order-time\./);
    expect(c.query).toContain("never push or merge");
    expect(c.query).toContain("## Acceptance criteria");
  });

  it("says what happened, and the clipboard when chat can't open", () => {
    expect(START_WORDS.opened("1.1")).toMatch(/Press Enter to start/);
    expect(START_WORDS.copied("1.1", "no chat")).toMatch(
      /on the clipboard: paste it into Copilot Chat in agent mode/,
    );
  });
});

describe("Attach to Atticus change", () => {
  const f = (p: string) => ({ scheme: "file", fsPath: p });
  it("takes every file selected in the Explorer, or the one clicked", () => {
    expect(attachPaths(f("C:/w/a.pdf"), [f("C:/w/a.pdf"), f("C:/w/b.png")])).toEqual([
      "C:/w/a.pdf",
      "C:/w/b.png",
    ]);
    expect(attachPaths(f("C:/w/a.pdf"), undefined)).toEqual(["C:/w/a.pdf"]);
    expect(attachPaths(undefined, undefined)).toEqual([]);
    expect(attachPaths({ scheme: "untitled", fsPath: "Untitled-1" }, undefined)).toEqual([]);
  });
});
