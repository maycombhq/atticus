import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import { screenOf, tabsOf } from "../src/app/screens.js";
import { CockpitView, stageMark } from "../src/screens/work/Cockpit.js";

/** The change cockpit (WP7.1): one change at a glance, the first of its pages. */

const C = COPY.cockpit;
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

const DATA: Api.ChangeCockpitT = {
  id: "add-transfer-limit",
  state: "define",
  nextStep: 'Finish the define work, then raise "Send to architecture".',
  next: {
    step: "feature",
    command: "atticus change feature add-transfer-limit",
    slash: "/atticus-feature add-transfer-limit",
    why: "add-transfer-limit has a brief: your assistant places it on the estate.",
  },
  reasons: [
    {
      code: "stage-not-done",
      message: "The feature stage waits for a person to answer its questions.",
    },
  ],
  risk: { level: "low", score: 2 },
  stages: [
    { stage: "feature", state: "waiting", drafts: 2, rounds: 1, openQuestions: 1 },
    { stage: "architecture", state: "not-started", drafts: 0, rounds: 0, openQuestions: 0 },
    { stage: "stories", state: "not-started", drafts: 0, rounds: 0, openQuestions: 0 },
  ],
  openQuestions: 1,
  repos: [
    {
      id: "forge-ledger",
      branch: "change/add-transfer-limit",
      base: "main",
      pr: "https://git.example.com/forge/forge-ledger/pull/7",
    },
  ],
};

describe("the change cockpit (WP7.1)", () => {
  it("is the first page of a change", () => {
    expect(screenOf("cockpit")?.section).toBe("Changes");
    const changeTabs = tabsOf("Changes").filter((t) => t.group);
    expect(changeTabs[0]?.id).toBe("cockpit");
  });

  it("shows the stages, the next step with both commands, what blocks it, the questions and the branches", () => {
    const out = renderToStaticMarkup(<CockpitView c={DATA} />);
    expect(out).toContain(esc(C.state("define", "low")));
    expect(out).toContain(esc(C.stage(C.stages.feature!, C.marks.current!)));
    expect(out).toContain(esc(C.stage(C.stages.stories!, C.marks.todo!)));
    expect(out).toContain(esc(C.progress(2, 1, 1)));
    expect(out).toContain('aria-current="step"');
    expect(out).toContain("/atticus-feature add-transfer-limit");
    expect(out).toContain("atticus change feature add-transfer-limit");
    expect(out).toContain(esc("The feature stage waits for a person to answer its questions."));
    expect(out).toContain(esc(C.questions(1)));
    expect(out).toContain(esc(C.branchOn("change/add-transfer-limit", "main")));
    expect(out).toContain("https://git.example.com/forge/forge-ledger/pull/7");
  });

  it("says when no repo has a branch yet, and marks a finished stage done", () => {
    const out = renderToStaticMarkup(<CockpitView c={{ ...DATA, repos: [], reasons: [] }} />);
    expect(out).toContain(esc(C.noRepos));
    expect(out).not.toContain(esc(C.blocks));
    expect(stageMark({ ...DATA.stages[0]!, state: "done" })).toBe("done");
  });
});
