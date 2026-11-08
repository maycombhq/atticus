import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Api } from "@maycombhq/core";

/**
 * Ninth UX walk (no terminal in the daily path, wording): a saved stage correction says the file
 * goes with the stage's hand-off, a knowledge gap's step is answered on the change's page, a failed
 * hand-off says one state and each error once, a task's run goes on to the Task board, the Tasks
 * page follows the change's step, words that ran together, the drafted-by-AI chip once, paths in
 * their own case, a manual Git host's release PR waits on a person, and every repo's buttons name
 * the repo. Invented Forge data only (CLAUDE.md rule 3); no network (rule 5).
 */
vi.mock("../src/api/client.js", async () => ({
  ...(await vi.importActual<object>("../src/api/client.js")),
  useApi: () => ({ state: "loading", reload: () => {} }),
  useLiveEvents: () => undefined,
  useReloadOnFiles: () => undefined,
}));
const { COPY } = await import("../src/copy.js");
const { CorrectionSaved } = await import("../src/screens/work/StageDrafts.js");
const { stageStep } = await import("../src/screens/work/next.js");
const { RunNextPanel } = await import("../src/screens/work/RunNext.js");
const { afterRun, notListed, RunDetail } = await import("../src/screens/runs/Runs.js");
const { CockpitView } = await import("../src/screens/work/Cockpit.js");
const { edgeLabels } = await import("../src/app/flow.js");
const { PlacementView } = await import("../src/screens/work/Placement.js");
const { ReleasePrCell } = await import("../src/screens/run/Release.js");
const { RollbackLine } = await import("../src/screens/run/ReleaseViews.js");
const { RepoRow } = await import("../src/screens/run/Repos.js");
const { taskRunsShown } = await import("../src/screens/know/task-pr.js");

const D = COPY.stageDrafts;
const R = COPY.runNext;
const RU = COPY.runs;
const html = (el: ReactElement) => renderToStaticMarkup(el);
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
const count = (s: string, part: string) => s.split(part).length - 1;
const CHANGE = "let-tellers-lock-a-card";
const FILE = `openspec/changes/${CHANGE}/stage/corrections.yaml`;

describe("a saved stage correction rides the stage's hand-off", () => {
  const out = html(
    <CorrectionSaved
      text={D.saved("Step 2")}
      files={[FILE]}
      commit={`git add ${FILE}\ngit commit -m "Correct step 2"`}
    />,
  );

  it("says the file goes with the hand-off, and offers Propose outside one", () => {
    expect(out).toContain(esc(D.saved("Step 2")));
    expect(out).toContain(esc(D.ridesHandoff(FILE)));
    expect(out).toContain(esc(D.outsideHandoff));
    expect(out).toContain(esc(COPY.propose.propose));
  });

  it("keeps the git command only under Or in a terminal", () => {
    const terminal = out.indexOf(`<summary>${esc(R.orTerminal)}</summary>`);
    expect(terminal).toBeGreaterThan(0);
    expect(out.indexOf("git add")).toBeGreaterThan(terminal);
    expect(out).not.toContain("Commit the corrections file");
  });
});

const cockpit = (o: Partial<Api.ChangeCockpitT> = {}): Api.ChangeCockpitT => ({
  id: CHANGE,
  state: "design",
  nextStep: 'Finish the design work, then raise "Approve design".',
  reasons: [],
  risk: { level: "high", score: 7 },
  stages: [
    { stage: "feature", state: "done", drafts: 2, rounds: 2, openQuestions: 0 },
    { stage: "architecture", state: "done", drafts: 4, rounds: 4, openQuestions: 0 },
    { stage: "stories", state: "not-started", drafts: 0, rounds: 0, openQuestions: 0 },
  ],
  openQuestions: 0,
  repos: [],
  ...o,
});
const row = (state: string) => ({ id: CHANGE, title: "Let tellers lock a card", state });

describe("a knowledge gap on Architecture's Run next is answered in the app", () => {
  const gap = cockpit({
    reasons: [
      {
        code: "open-gap",
        message:
          "Knowledge gap g-unlock on the design gate (round 2) needs an answer or a fix: who may unlock a card.",
      },
    ],
  });

  it("is a gap step of the change, with its link on the change's page", () => {
    const step = stageStep("architecture", row("design"), undefined, gap);
    expect(step).toMatchObject({ kind: "gap", change: CHANGE });
    const out = html(<RunNextPanel step={step} />);
    expect(out).toContain(`href="#/changes/${CHANGE}"`);
    expect(out).toContain(esc(R.answerGap));
    expect(out).toContain(esc(R.answerGapSay));
    // The command only under Or in a terminal; never "No slash command does this step yet".
    expect(out).not.toContain(esc(R.noSlash));
    expect(out.indexOf(`atticus change status ${CHANGE}`)).toBeGreaterThan(out.indexOf("<details"));
  });
});

describe("the Tasks page follows the change's step once the stories are done", () => {
  it("says the stories stage is done and offers its hand-off, not 'at the stories stage'", () => {
    const c = cockpit({
      state: "plan",
      nextStep: 'Ready to raise "Plan ready".',
      reasons: [{ code: "no-handoff", message: 'No hand-off PR yet: raise "Plan ready".' }],
      stages: [
        { stage: "feature", state: "done", drafts: 2, rounds: 2, openQuestions: 0 },
        { stage: "architecture", state: "done", drafts: 4, rounds: 4, openQuestions: 0 },
        { stage: "stories", state: "done", drafts: 3, rounds: 3, openQuestions: 0 },
      ],
    });
    const step = stageStep("tasks", row("plan"), [], c);
    expect(step.why).not.toBe(COPY.work.stageIs(COPY.work.stage.stories!));
    expect(step.kind).toBe("handoff");
    expect(step.command).toBe(`atticus change handoff ${CHANGE} --approve`);
  });
});

const runItem = (o: Partial<Api.RunListItem> = {}): Api.RunListItem =>
  ({
    schemaVersion: 1,
    runId: "run-20261108224350-0001",
    change: CHANGE,
    agent: "critic",
    runtime: "hand-off",
    state: "failed",
    startedAt: "2026-11-08T22:43:50Z",
    contextManifestSha256: "a",
    errors: ["The security lens's section has no findings list.", "The data lens is missing."],
    attempt: 1,
    ...o,
  }) as Api.RunListItem;
const transcript = (run: Api.RunListItem): Api.RunTranscript =>
  ({
    run,
    prompt: "# Task: the critic's lenses\n",
    rounds: [run],
    previous: [],
    handedBack: [],
  }) as never;

describe("a failed hand-off says one state and each error once", () => {
  it("asks to fix the answer and press Done again, never 'waits for its answer'", () => {
    const t = transcript(runItem());
    const out = html(<RunDetail of={{ state: "ready", data: t }} />);
    expect(out).toContain(esc(RU.failedAgainSay));
    expect(out).not.toContain(esc(RU.waitingSay));
    for (const e of t.run.errors) expect(count(out, esc(e))).toBe(1);
  });

  it("Done's refusal says only what the page doesn't list already", () => {
    const errors = runItem().errors;
    expect(
      notListed([...errors, "Fix the answer, then press Done again."].join("\n"), errors),
    ).toBe("Fix the answer, then press Done again.");
    expect(notListed(errors.join("\n"), errors)).toBe(RU.failedStill);
  });
});

describe("a task's run goes on to the Task board after Done", () => {
  const changes = new Set([CHANGE]);
  it("even when the run view lost its task run, or another run waits", () => {
    const done = runItem({ agent: "task-runner", state: "validated", errors: [] });
    expect(afterRun(transcript(done), [done], changes)).toEqual({
      href: `#/tasks?change=${CHANGE}`,
      label: RU.toTaskBoardAny,
    });
    const other = runItem({ runId: "run-20261108225018-0001", state: "waiting", errors: [] });
    const task = runItem({
      agent: "task-runner",
      state: "validated",
      errors: [],
      taskRun: { task: "1.1" } as never,
    });
    expect(afterRun(transcript(task), [task, other], changes)).toEqual({
      href: `#/tasks?change=${CHANGE}`,
      label: RU.toTaskBoard("1.1"),
    });
  });

  it("counts a task run still with the assistant among the AI task runs", () => {
    const waiting = runItem({ agent: "task-prompt", state: "waiting", errors: [] });
    const critic = runItem({ runId: "run-x", agent: "critic" });
    expect(taskRunsShown([waiting, critic], [{ run: waiting.runId }]).map((r) => r.runId)).toEqual([
      waiting.runId,
    ]);
  });
});

describe("At a glance's words and repos", () => {
  const manual = "manual://git-host/forge/forge-card-vault/pull/3";
  const out = html(
    <CockpitView
      c={cockpit({
        state: "build",
        repos: ["forge-card-vault", "forge-proxy-core-v1", "forge-teller-app"].map((id) => ({
          id,
          branch: `change/${CHANGE}`,
          base: "main",
          pr: manual,
        })),
      })}
    />,
  );

  it("keeps a space between a stage's mark and its drafts", () => {
    expect(out).not.toMatch(/done<\/a><span/);
    expect(out).toMatch(/done<\/a> <span/);
  });

  it("says a manual Git host's PR waits on you once, not once per repo", () => {
    expect(count(out, esc(COPY.phase.manualPrWaits))).toBe(1);
  });
});

describe("words that read wrong", () => {
  it("gives a box's edges no empty brackets", () => {
    expect(edgeLabels([])).toBe("");
    expect(edgeLabels([undefined, ""])).toBe("");
    expect(edgeLabels(["PUT /cards/{id}/lock"])).toBe(" (PUT /cards/{id}/lock)");
  });

  it("chips feature.md as drafted by AI once on Feature design: The drafts does it", () => {
    const out = html(
      <PlacementView
        of={{
          state: "ready",
          data: {
            change: CHANGE,
            present: true,
            file: `openspec/changes/${CHANGE}/feature.md`,
            content: "# Feature\n",
            source: `openspec/changes/${CHANGE}/feature.yaml`,
            sourceContent: "",
            sha256: "a",
            drafted: { by: "ai" },
          } as Api.PlacementViewT,
        }}
      />,
    );
    expect(out).not.toContain("chip ai");
    expect(out).not.toMatch(/Drafted by AI\s*Drafted by AI/);
    expect(out).toContain(esc(COPY.work.draftedByAiWhy));
  });

  it("keeps the rollback's label apart from its words, and its source in its own case", () => {
    const out = html(
      <RollbackLine
        rollback={{ gap: "No rollback step judged for forge-card-vault yet." }}
        label="Rollback"
      />,
    );
    expect(out).toMatch(/Rollback<\/span> <span/);
    const cited = html(
      <RollbackLine
        rollback={{ text: "Redeploy the previous version.", source: "design.md:45" }}
      />,
    );
    expect(cited).toContain('class="hud cite"');
  });

  it("never upper-cases a path: a cite or a mono inside a HUD label keeps its case", () => {
    const css = readFileSync(new URL("../src/styles/hud.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.hud \.mono,[\s\S]*?\.cite\s*\{[^}]*text-transform:\s*none/);
  });

  it("draws the Ask Atticus field's own focus ring", () => {
    const css = readFileSync(new URL("../src/styles/hud.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.ask-form input:focus-visible\s*\{[^}]*outline:\s*2px solid/);
  });
});

describe("a manual Git host's release PR waits on a person", () => {
  it("says it waits on you to open it, never '#103 DRAFT'", () => {
    const out = html(
      <ReleasePrCell
        pr={{ number: 103, state: "draft", url: "manual://git-host/forge-card-vault/pull/103" }}
      />,
    );
    expect(out).toContain(esc(COPY.release.prToOpen));
    expect(out).toContain('href="#/todo"');
    expect(out).not.toContain("#103");
    const real = html(
      <ReleasePrCell
        pr={{ number: 12, state: "open", url: "https://git.example.com/forge/x/pull/12" }}
      />,
    );
    expect(real).toContain("#12 OPEN");
  });
});

describe("Set up › Repos names each repo in its buttons", () => {
  it("labels Confirm, change or drop, Drop it, Confirm it and Edit branches with the repo", () => {
    const R = COPY.repos;
    const out = html(
      <RepoRow
        r={
          {
            id: "forge-notes",
            platform: "forge",
            url: "https://git.example.com/forge/forge-notes.git",
            type: "spring-boot",
            owner: "team-notes",
            defaultBranch: "main",
            branches: [],
            scans: [],
            description: { text: "Notes on cards", by: "copilot", trust: "suggested" },
          } as never
        }
      />,
    );
    for (const label of [
      R.editAboutDraftFor("forge-notes"),
      R.rejectAboutFor("forge-notes"),
      R.acceptAboutFor("forge-notes"),
      R.editFor("forge-notes"),
    ])
      expect(out).toContain(`aria-label="${esc(label)}"`);
  });
});
