import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import { screenOf, tabsOf } from "../src/app/screens.js";
import {
  CockpitPicked,
  CockpitView,
  PastChangesView,
  stageMark,
} from "../src/screens/work/Cockpit.js";

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
  it("is Change's tab after All changes, and the first of a change's pages with --full", () => {
    expect(screenOf("cockpit")?.section).toBe("Change");
    expect(screenOf("cockpit")?.aside).toBeUndefined();
    expect(
      tabsOf("Change")
        .map((t) => t.id)
        .slice(0, 2),
    ).toEqual(["changes", "cockpit"]);
    const changeTabs = tabsOf("Change", true).filter((t) => t.group);
    expect(changeTabs[0]?.id).toBe("cockpit");
  });

  it("says to pick a change in All changes when the address names none", () => {
    const list = [
      { id: "add-transfer-limit", title: "Add a daily transfer limit", state: "define" },
    ];
    for (const current of [undefined, "nope"]) {
      const out = renderToStaticMarkup(
        <CockpitPicked list={list} current={current} c={{ state: "loading" }} />,
      );
      expect(out).toContain(esc(COPY.work.pickAChange));
      expect(out).toContain(`href="#/changes">${esc(COPY.work.openAllChanges)}</a>`);
      expect(out).not.toContain("pick-cockpit");
    }
    const picked = renderToStaticMarkup(
      <CockpitPicked list={list} current="add-transfer-limit" c={{ state: "ready", data: DATA }} />,
    );
    expect(picked).toContain('<label for="pick-cockpit"');
    expect(picked).toContain("atticus change feature add-transfer-limit");
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

  it("says where the stages' work is when it ran ahead of the state (B-change), and nothing when it didn't", () => {
    const work =
      'Stories done; the change is still in define: raise "Send to architecture" (the define hand-off), then the design and plan hand-offs.';
    expect(renderToStaticMarkup(<CockpitView c={{ ...DATA, work }} />)).toContain(esc(work));
    expect(renderToStaticMarkup(<CockpitView c={DATA} />)).not.toContain("still in define");
  });
});

describe("watching a change from its cockpit (WP7.5)", () => {
  it("offers to watch, or to stop watching", async () => {
    const { WatchButton } = await import("../src/screens/work/Cockpit.js");
    expect(
      renderToStaticMarkup(<WatchButton change="add-transfer-limit" watching={false} />),
    ).toContain(esc(C.watch));
    const on = renderToStaticMarkup(<WatchButton change="add-transfer-limit" watching />);
    expect(on).toContain(esc(C.unwatch));
    expect(on).toContain('aria-pressed="true"');
  });
});

describe("earlier changes like this one (WP7.6)", () => {
  const PAST: Api.SimilarChangesT = {
    how: "words",
    note: "similarity in meaning is off here",
    changes: [
      {
        id: "2026-05-12-raise-transfer-limit",
        change: "raise-transfer-limit",
        title: "Raise the daily transfer limit for business accounts",
        archived: "2026-05-12",
        summary: "Business customers hit the daily transfer limit when paying suppliers.",
        file: "openspec/changes/archive/2026-05-12-raise-transfer-limit/brief.md",
        score: 3.2,
      },
    ],
  };

  it("lists each with when it was archived and what it asked, says how they were found, and offers to use one", () => {
    const out = renderToStaticMarkup(<PastChangesView r={PAST} onUse={() => undefined} />);
    expect(out).toContain(esc(C.like.title));
    expect(out).toContain(esc(PAST.changes[0]!.title));
    expect(out).toContain(esc(C.like.archived("2026-05-12")));
    expect(out).toContain(esc(PAST.changes[0]!.summary));
    expect(out).toContain(esc(C.like.byWords("similarity in meaning is off here")));
    expect(out).toContain(esc(C.like.use));
  });

  it("says when none is near", () => {
    const out = renderToStaticMarkup(<PastChangesView r={{ how: "meaning", changes: [] }} />);
    expect(out).toContain(esc(C.like.none));
    expect(out).not.toContain(esc(C.like.use));
  });
});
