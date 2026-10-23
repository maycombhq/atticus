import { describe, expect, it } from "vitest";
import { endActions } from "../src/describe";

/** What a person can do from the notice a step ends with, so no ending is a dead end. */
describe("the buttons on a step's ending", () => {
  it("offers to install Copilot Chat when no model is there because it isn't installed", () => {
    expect(endActions({ state: "no-model" }, { copilot: false })).toEqual([
      "Install Copilot Chat",
      "Show details",
    ]);
  });

  it("offers to set Copilot up when it is installed but gives no model (not signed in)", () => {
    expect(endActions({ state: "no-model" }, { copilot: true })).toEqual([
      "Set up Copilot",
      "Pick a model",
      "Show details",
    ]);
  });

  it("offers another model when the prompt is too long or the model didn't answer", () => {
    expect(endActions({ state: "too-long" }, { copilot: true })).toEqual([
      "Pick a model",
      "Show details",
    ]);
    expect(endActions({ state: "model-error" }, { copilot: true })).toEqual([
      "Pick a model",
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
