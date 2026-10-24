import { describe, expect, it } from "vitest";
import { copilotSetup, describeEnd, endActions, endFiles } from "../src/describe";
import type { StepEnd } from "../src/runner";

/** What a person can do from the notice a step ends with, so no ending is a dead end. */
describe("the buttons on a step's ending", () => {
  it("offers to set Copilot up, not to install it, when no model is there and Copilot isn't set up", () => {
    // VS Code 1.143 has Copilot built in: its extension shows only once it is set up, and a bank
    // may block the marketplace, so installing is the wrong way on.
    expect(endActions({ state: "no-model" }, { copilot: false })).toEqual([
      "Set up Copilot",
      "Show details",
    ]);
  });

  it("offers to set Copilot up when it is installed but gives no model (not signed in)", () => {
    expect(endActions({ state: "no-model" }, { copilot: true })).toEqual([
      "Set up Copilot",
      "Pick the model",
      "Show details",
    ]);
  });

  it("offers another model when the prompt is too long or the model didn't answer", () => {
    expect(endActions({ state: "too-long" }, { copilot: true })).toEqual([
      "Pick the model",
      "Show details",
    ]);
    expect(endActions({ state: "model-error" }, { copilot: true })).toEqual([
      "Pick the model",
      "Show details",
    ]);
  });

  it("offers to answer when the step stopped for a question", () => {
    expect(endActions({ state: "question" }, { copilot: true })).toEqual([
      "Answer",
      "Show details",
    ]);
  });
});

describe("a step's prompt and answer, one click from its ending (ADR 0106)", () => {
  const done = (files?: StepEnd["files"]): StepEnd => ({
    state: "done",
    rounds: 1,
    exitCode: 0,
    messages: [],
    errors: [],
    questions: [],
    ...(files ? { files } : {}),
  });
  const both = {
    runId: "run-20261023053215-0001",
    prompt: ".runs/survey-forge-ledger/run-20261023053215-0001/prompt.md",
    answer: ".runs/survey-forge-ledger/run-20261023053215-0001/scan-settings.yaml",
  };

  it("opens the last round's prompt and answer when both are there", () => {
    expect(endActions(done(both), { copilot: true })).toEqual([
      "Open the prompt",
      "Open the answer",
      "Show details",
    ]);
    expect(endFiles(done(both), "/meta")).toEqual([
      {
        title: "Open the prompt",
        path: "/meta/.runs/survey-forge-ledger/run-20261023053215-0001/prompt.md",
      },
      {
        title: "Open the answer",
        path: "/meta/.runs/survey-forge-ledger/run-20261023053215-0001/scan-settings.yaml",
      },
    ]);
  });

  it("offers only the prompt when no answer was written", () => {
    const { answer: _a, ...prompt } = both;
    const end: StepEnd = {
      state: "no-model",
      runId: both.runId,
      promptFile: both.prompt,
      resultFile: both.answer,
      resumeCommand: "atticus scan survey forge-ledger --resume run-20261023053215-0001",
      files: prompt,
    };
    expect(endActions(end, { copilot: false })).toEqual([
      "Set up Copilot",
      "Open the prompt",
      "Show details",
    ]);
    expect(endFiles(end, "/meta").map((f) => f.title)).toEqual(["Open the prompt"]);
  });

  it("offers no file when the step never handed a prompt off", () => {
    expect(endActions(done(), { copilot: true })).toEqual(["Show details"]);
    expect(endFiles(done(), "/meta")).toEqual([]);
  });

  it("keeps the question's Answer first", () => {
    const q: StepEnd = { ...(done(both) as object), state: "question" } as StepEnd;
    expect(endActions(q, { copilot: true })).toEqual([
      "Answer",
      "Open the prompt",
      "Open the answer",
      "Show details",
    ]);
  });
});

describe("setting Copilot up", () => {
  it("uses VS Code's own Copilot setup when it has one", () => {
    expect(
      copilotSetup(["workbench.action.openSettings", "workbench.action.chat.triggerSetup"]),
    ).toEqual({ command: "workbench.action.chat.triggerSetup", args: [] });
  });

  it("installs Copilot Chat only in a VS Code without that setup", () => {
    expect(copilotSetup(["workbench.action.openSettings"])).toEqual({
      command: "workbench.extensions.installExtension",
      args: ["GitHub.copilot-chat"],
    });
  });
});

describe("the notice a step ends with", () => {
  const end = (state: "stopped" | "failed", messages: string[], errors: string[] = []) =>
    ({ state, rounds: 3, exitCode: 1, messages, errors, questions: [] }) satisfies StepEnd;

  it("says why a step stopped, from what the command line printed, and keeps all of it below", () => {
    const why =
      "No answer passed the checks after 3 attempts: ledger-team quotes teams.md, which isn't one of the change's files";
    const lines = describeEnd(end("stopped", ["", why, "Run it again with --attempts 5."]));
    expect(lines[0]).toBe(`The step stopped without finishing: ${why}`);
    expect(lines.slice(1)).toEqual([why, "Run it again with --attempts 5."]);
  });

  it("says why a step couldn't run, and shortens a very long reason", () => {
    const long = "x".repeat(400);
    const first = describeEnd(end("failed", [], [long]))[0]!;
    expect(first.startsWith("The step couldn't run: xxx")).toBe(true);
    expect(first.endsWith("…")).toBe(true);
    expect(first.length).toBeLessThan(260);
  });

  it("says only that it stopped when the command line said nothing", () => {
    expect(describeEnd(end("stopped", []))[0]).toBe("The step stopped without finishing.");
    expect(describeEnd(end("failed", []))[0]).toBe("The step couldn't run.");
  });
});
