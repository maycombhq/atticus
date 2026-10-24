import { describe, expect, it } from "vitest";
import { actionFor } from "../src/atticus";
import { nextRow, type NextNode } from "../src/next-rows";

/**
 * The Next section's rows (ADR 0098, 0100, 0101): every row a person can act on does something
 * when clicked. A step after the next one runs the same way as the next one: a person clicked
 * "then: find what the change needs" and nothing happened.
 */

const needs = {
  step: "needs",
  command: "atticus change needs add-note-tags",
  why: "add-note-tags is placed on the estate: your assistant says what it needs.",
  change: "add-note-tags",
};
const raise = {
  step: "raise-needs",
  command: "atticus needs --change add-note-tags",
  why: "2 needs of add-note-tags are open.",
  change: "add-note-tags",
  person: true,
};
const setupStep = { id: "scan", label: "Scan the repos", done: false };

const every: NextNode[] = [
  { kind: "loading" },
  { kind: "error", message: "Couldn't read the next step" },
  { kind: "next", step: needs },
  { kind: "then", step: raise },
  { kind: "no-next" },
  { kind: "setup", steps: [setupStep, { id: "baseline", label: "Accept", done: false }] },
  { kind: "setup", steps: [{ ...setupStep, done: true }] },
  { kind: "setup-step", step: setupStep },
  { kind: "setup-step", step: { ...setupStep, done: true } },
  { kind: "app" },
  { kind: "runs", runs: "Hand-off to GitHub Copilot", model: "" },
  { kind: "no-root" },
];

describe("the Next section's rows", () => {
  it("gives every row but the loading and nothing-to-do ones a command", () => {
    for (const n of every) {
      const r = nextRow(n);
      if (n.kind === "loading" || n.kind === "no-next") expect(r.command).toBeUndefined();
      else expect(r.command, n.kind).toBeDefined();
    }
  });

  it("runs the next step and each step after it through atticus.runStep, with the step", () => {
    const next = nextRow({ kind: "next", step: needs });
    const then = nextRow({ kind: "then", step: raise });
    expect(next.command).toEqual({
      command: "atticus.runStep",
      title: "Run this step",
      args: [needs],
    });
    expect(then.command).toEqual({
      command: "atticus.runStep",
      title: "Run this step",
      args: [raise],
    });
    // Both keep the inline Run button.
    expect(next.context).toBe("atticus.next");
    expect(then.context).toBe("atticus.next");
    expect(then.description).toBe("your step");
    expect(nextRow({ kind: "then", step: needs }).description).toBe("then");
  });

  it("says each step in plain words, not its why", () => {
    const titles = (id: string) => (id === "add-note-tags" ? "Add tags to notes" : undefined);
    expect(nextRow({ kind: "then", step: needs }, titles).label).toBe(
      "Find what “Add tags to notes” needs from the organisation",
    );
    expect(nextRow({ kind: "next", step: raise }, titles).label).toBe(
      "Raise “Add tags to notes”'s open needs",
    );
  });

  it("runs a change's needs with Copilot, and leaves raising them to a person", () => {
    expect(actionFor(needs)).toEqual({ kind: "ai", args: ["change", "needs", "add-note-tags"] });
    expect(actionFor(raise)).toEqual({
      kind: "person",
      command: "atticus needs --change add-note-tags",
    });
    expect(
      actionFor({ step: "find", command: 'atticus knowledge find "Kafka topic"', why: "" }),
    ).toEqual({ kind: "ai", args: ["knowledge", "find", "Kafka topic"] });
  });

  it("does the next setup step from the checklist's row, or accepts the catalog when all are done", () => {
    expect(nextRow(every[5]!).command).toMatchObject({
      command: "atticus.setupStep",
      args: ["scan"],
    });
    expect(nextRow(every[6]!).command).toMatchObject({ command: "atticus.acceptCatalog" });
  });
});

describe("what runs a step (ADR 0121 item 6)", () => {
  it("says runtime.yaml's line, and the model VS Code runs steps on; a click picks the model", () => {
    const r = nextRow({
      kind: "runs",
      runs: "Hand-off to GitHub Copilot · model mode allowed: anthropic",
      model: "copilot/gpt-4o",
    });
    expect(r.label).toBe("Hand-off to GitHub Copilot · model mode allowed: anthropic");
    expect(r.description).toBe("in VS Code: copilot/gpt-4o");
    expect(r.command).toEqual({ command: "atticus.pickModel", title: "Pick the model" });
    expect(nextRow({ kind: "runs", runs: "x", model: "" }).description).toBe(
      "in VS Code: the chat's model",
    );
    expect(nextRow({ kind: "runs", runs: "x", model: "atticus" }).description).toBe(
      "in VS Code: Atticus's configured model",
    );
  });
});
