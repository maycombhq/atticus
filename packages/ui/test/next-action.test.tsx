import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import { dashboardStep, stageStep, type OnboardingData } from "../src/screens/work/next.js";
import { RunNextPanel } from "../src/screens/work/RunNext.js";
import { CockpitView } from "../src/screens/work/Cockpit.js";
import { goNoGoGate } from "../src/screens/run/Release.js";
import { handoffCell } from "../src/screens/Across.js";

/**
 * Seventh UX walk: Run next panels were terminal-first everywhere ("In a terminal, at the
 * metarepo:" then the command), even on Home for `atticus change new` beside a New change button.
 * The step's in-app action comes first (New change, Raise hand-off, the Task board, Prepare);
 * the command stays copyable under "Or in a terminal". What's next follows the change's state and
 * gate, and a manual Git host's PR is a step waiting on a person, never a manual:// link.
 */

const html = (el: ReactElement) => renderToStaticMarkup(el);
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
const R = COPY.runNext;
const W = COPY.work;
const P = COPY.phase;
const MANUAL = "manual://git-host/forge/forge-gq/pull/4";

const onboarded: OnboardingData = {
  manifests: [],
  repos: [
    {
      id: "forge-ledger",
      platform: "forge",
      type: "forge-service",
      owner: "team-ledger",
      manifest: "org-pack/profiles/forge/repos.manifest.yaml",
      cloned: true,
      scanSettings: { path: "org-pack/scan/forge-ledger.yaml", present: true },
      lastScan: { records: 4, kinds: { Endpoint: 4 }, commit: "abc1234def" },
    },
  ],
  sources: { path: "org-pack/sources.yaml", present: true, wikis: [], absorbed: [] },
  catalog: { records: 4 },
  problems: [],
} as unknown as OnboardingData;

const cockpit = (o: Partial<Api.ChangeCockpitT> = {}): Api.ChangeCockpitT => ({
  id: "show-status",
  state: "define",
  nextStep: 'Ready to raise "Send to architecture".',
  reasons: [],
  risk: { level: "low", score: 1 },
  stages: [
    { stage: "feature", state: "done", drafts: 1, rounds: 1, openQuestions: 0 },
    { stage: "architecture", state: "not-started", drafts: 0, rounds: 0, openQuestions: 0 },
    { stage: "stories", state: "not-started", drafts: 0, rounds: 0, openQuestions: 0 },
  ],
  openQuestions: 0,
  repos: [],
  ...o,
});

/** Where the terminal disclosure starts; -1 without one. */
const terminalAt = (out: string) => out.indexOf("<details");

describe("Run next puts the in-app action first, the command under Or in a terminal", () => {
  it("on Home with no change in flight: the New change button, not a terminal command first", () => {
    const step = dashboardStep(onboarded, 0, []);
    const out = html(<RunNextPanel step={step} />);
    const button = out.indexOf(esc(COPY.newChange.start));
    expect(button).toBeGreaterThan(0);
    expect(terminalAt(out)).toBeGreaterThan(button);
    expect(out).toContain(`<summary>${esc(R.orTerminal)}</summary>`);
    expect(out.indexOf(esc(R.terminal))).toBeGreaterThan(terminalAt(out));
    expect(out).toContain(esc('atticus change new "<title>" --type <type>'));
    expect(out).not.toContain(esc(R.noSlash));
  });

  it("a stage's hand-off: Raise hand-off first", () => {
    const step = stageStep(
      "feature",
      { id: "show-status", title: "Show status", state: "define" },
      undefined,
      cockpit({ reasons: [{ code: "no-handoff", message: "No hand-off PR yet." }] }),
    );
    const out = html(<RunNextPanel step={step} />);
    const raise = out.indexOf(esc(P.raiseHandOff));
    expect(raise).toBeGreaterThan(0);
    expect(terminalAt(out)).toBeGreaterThan(raise);
    expect(out).toContain("atticus change handoff show-status --approve");
  });

  it("a task: the Task board first", () => {
    const step = stageStep("tasks", { id: "show-status", title: "Show status", state: "build" }, [
      { id: "1.1", repo: "forge-ledger", description: "Add the status", done: false },
    ]);
    const out = html(<RunNextPanel step={step} />);
    const board = out.indexOf('href="#/tasks?change=show-status"');
    expect(board).toBeGreaterThan(0);
    expect(terminalAt(out)).toBeGreaterThan(board);
  });

  it("an AI step: its command under Or in a terminal, after where its Run or Prepare goes", () => {
    const out = html(
      <RunNextPanel
        step={{
          command: "atticus change feature show-status",
          why: W.why.feature,
          slash: { command: "/atticus-feature show-status", where: W.slashWhere.metarepo },
        }}
      />,
    );
    expect(terminalAt(out)).toBeGreaterThan(0);
    expect(out.indexOf("atticus change feature show-status")).toBeGreaterThan(terminalAt(out));
    expect(out).toContain(`aria-label="${R.copy}: atticus change feature show-status"`);
  });
});

describe("What's next follows the change's state and gate, on Home too", () => {
  it("takes the change's own next step from its cockpit, not the stage its state names", () => {
    const why =
      "show-status's define hand-off PR isn't open yet: your Git host is manual, so opening it is a step waiting on you.";
    const step = dashboardStep(
      onboarded,
      0,
      [{ id: "show-status", title: "Show status", state: "define" }],
      undefined,
      cockpit({
        next: {
          step: "merge",
          command: "atticus todo --change show-status",
          why,
          pr: MANUAL,
        },
      }),
    );
    expect(step.why).toBe(why);
    expect(step.why).not.toContain(W.why.change("show-status", W.stage.feature));
    const out = html(<RunNextPanel step={step} />);
    expect(out).toContain(esc(P.manualPrWaits));
    expect(out).toContain('href="#/todo"');
    expect(out).not.toContain('href="manual:');
  });
});

describe("a stage page follows the change's own next step where it differs", () => {
  it("Tasks with every task ticked: the build hand-off, not change status", () => {
    const step = stageStep(
      "tasks",
      { id: "show-status", title: "Show status", state: "build" },
      [{ id: "1.1", repo: "forge-ledger", description: "Add the status", done: true }],
      cockpit({
        state: "build",
        next: {
          step: "handoff",
          command: "atticus change handoff show-status --approve",
          why: "Every task of show-status is ticked.",
        },
      }),
    );
    expect(step).toMatchObject({
      command: "atticus change handoff show-status --approve",
      kind: "handoff",
      change: "show-status",
    });
  });
});

describe("At a glance: the in-app action first", () => {
  it("offers the Task board for a task step, and the command under Or in a terminal", () => {
    const out = html(
      <CockpitView
        c={cockpit({
          state: "build",
          next: {
            step: "task",
            command: "atticus task run show-status 1.1",
            slash: "/atticus-task show-status 1.1",
            why: "Task 1.1 is the first one not done.",
          },
        })}
      />,
    );
    const board = out.indexOf('href="#/tasks?change=show-status"');
    expect(board).toBeGreaterThan(0);
    expect(terminalAt(out)).toBeGreaterThan(board);
  });

  it("raises the hand-off here before any command", () => {
    const out = html(
      <CockpitView
        c={cockpit({
          next: {
            step: "handoff",
            command: "atticus change handoff show-status --approve",
            why: "The feature stage is done.",
          },
        })}
      />,
    );
    const raise = out.indexOf(esc(P.raiseHandOff));
    expect(raise).toBeGreaterThan(0);
    expect(terminalAt(out)).toBeGreaterThan(raise);
  });

  it("says a manual Git host's hand-off PR waits on a person, with no manual:// link", () => {
    const out = html(
      <CockpitView
        c={cockpit({
          next: {
            step: "merge",
            command: "atticus todo --change show-status",
            why: "The hand-off PR isn't open yet.",
            pr: MANUAL,
          },
        })}
      />,
    );
    expect(out).toContain(esc(P.manualPrWaits));
    expect(out).not.toContain('href="manual:');
  });
});

describe("Release's go / no-go on a manual Git host", () => {
  it("says the PR waits on a person, not OPEN, and never names its manual:// link", () => {
    const g = goNoGoGate({
      change: { state: "release-ready" },
      handoff: { state: "open", pr: MANUAL, approvals: [] },
    });
    expect(g.value).toBe(COPY.release.waitsOnYouChip);
    expect(g.value).not.toBe("OPEN");
    expect(html(<>{g.detail}</>)).not.toContain("manual://");
    expect(html(<>{g.detail}</>)).toContain('href="#/todo"');
    const real = goNoGoGate({
      change: { state: "release-ready" },
      handoff: {
        state: "open",
        pr: "https://git.example.com/forge/forge-gq/pull/7",
        approvals: [],
      },
    });
    expect(real.value).toBe("OPEN");
  });

  it("Across changes' releases link a manual hand-off to its step, not to manual://", () => {
    const out = html(<>{handoffCell({ phase: "release", pr: MANUAL, state: "open" })}</>);
    expect(out).toContain('href="#/todo"');
    expect(out).toContain(esc(COPY.across.handOffManual("release")));
    expect(out).not.toContain("manual://");
  });
});
