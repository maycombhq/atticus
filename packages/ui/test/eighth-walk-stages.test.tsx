import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Api } from "@maycombhq/core";
import type { Task } from "../src/screens/Changes.js";

/**
 * Eighth UX walk (stage pages and access): the feature stage's placement on Feature design, the
 * in-app Prepare before the terminal, one path to write stories, focus kept after an action, each
 * repo's build button named, the brief editor's Cancel and the template's guidance, a task's PR
 * and tick said as they are, and who recorded a manual Git host's approval.
 */
const CHANGE = "let-tellers-lock-a-card";
let stories: Api.StageReviewViewT | undefined;
vi.mock("../src/api/client.js", async () => ({
  ...(await vi.importActual<object>("../src/api/client.js")),
  useApi: (path: string | undefined) => {
    if (path === `/api/changes/${CHANGE}/stages/stories` && stories)
      return { state: "ready", reload: () => {}, data: stories };
    if (path === `/api/changes/${CHANGE}/artifacts/brief`)
      return {
        state: "ready",
        reload: () => {},
        data: {
          artifact: "brief",
          path: `openspec/changes/${CHANGE}/brief.md`,
          content:
            "# Brief\n\n<!-- Who asked for it, and the problem they have. -->\n\n## Outcome\n\n<!-- What is true once it ships. -->\n",
          sha256: "a",
        },
      };
    return { state: "loading", reload: () => {} };
  },
  useLiveEvents: () => undefined,
  useReloadOnFiles: () => undefined,
}));

const { COPY } = await import("../src/copy.js");
const { PlacementView } = await import("../src/screens/work/Placement.js");
const { FilesTable, placementRows } = await import("../src/screens/work/Stage.js");
const { StageReviewView } = await import("../src/screens/work/StageReview.js");
const { ImpactView } = await import("../src/screens/work/Impact.js");
const { TargetList } = await import("../src/screens/flows/Flows.js");
const { StoriesAtTheStage } = await import("../src/screens/know/Phase.js");
const { DriftSummary } = await import("../src/screens/know/Phase.js");
const { focusIfLost } = await import("../src/app/ui.js");
const { BuildCommand } = await import("../src/screens/run/Repos.js");
const { ArtifactEditor, templateHints } = await import("../src/screens/Changes.js");
const { TaskRunState, TaskTick } = await import("../src/screens/know/task-pr.js");
const { StepDetail } = await import("../src/screens/run/Todo.js");

const W = COPY.work;
const S = COPY.stageReview;
const R = COPY.runNext;
const T = COPY.phase;
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
const REL = `openspec/changes/${CHANGE}`;

const placement = (o: Partial<Api.PlacementViewT> = {}): Api.PlacementViewT => ({
  change: CHANGE,
  present: true,
  file: `${REL}/feature.md`,
  content:
    "# Feature\n\nTellers lock a card from the branch.\n\n## Gaps\n\n- No unlock by tellers\n",
  source: `${REL}/feature.yaml`,
  sourceContent: "schemaVersion: 1\n",
  sha256: "b",
  drafted: { by: "ai" },
  ...o,
});

describe("Feature design shows where the feature lands", () => {
  it("renders feature.md with Edit, marked as drafted by AI at the feature stage", () => {
    const html = renderToStaticMarkup(
      <PlacementView of={{ state: "ready", data: placement() }} onEdit={() => {}} />,
    );
    expect(html).toContain(esc(W.placementTitle));
    expect(html).toContain("Tellers lock a card from the branch.");
    expect(html).toContain("No unlock by tellers");
    expect(html).toContain(esc(W.draftedByAi));
    expect(html).toContain(esc(W.draftedByAiWhy));
    expect(html).toContain(`aria-label="${esc(W.editPlacementLabel)}"`);
    expect(html).toContain(`${REL}/feature.md`);
  });

  it("says who edited it once a person saved it, and no AI chip", () => {
    const html = renderToStaticMarkup(
      <PlacementView
        of={{
          state: "ready",
          data: placement({
            drafted: { by: "person", who: "Priya Nair", at: "2026-11-08T10:00:00Z" },
          }),
        }}
        onEdit={() => {}}
      />,
    );
    expect(html).not.toContain(esc(W.draftedByAi));
    expect(html).toContain(esc(W.editedBy("Priya Nair")));
    expect(html).toContain(esc(W.editedByWhy("Priya Nair", "2026-11-08")));
  });

  it("has loading, error and not-placed-yet states", () => {
    expect(renderToStaticMarkup(<PlacementView of={{ state: "loading" }} />)).toContain(
      'aria-busy="true"',
    );
    expect(
      renderToStaticMarkup(<PlacementView of={{ state: "error", error: "boom" }} />),
    ).toContain('role="alert"');
    const none = renderToStaticMarkup(
      <PlacementView
        of={{
          state: "ready",
          data: placement({ present: false, content: "", sourceContent: "" }),
        }}
      />,
    );
    expect(none).toContain(esc(W.placementNotYet));
    expect(none).not.toContain(esc(W.editPlacementLabel));
  });

  it("lists feature.md and feature.yaml among the change's files", () => {
    const html = renderToStaticMarkup(
      <FilesTable
        detail={{
          id: CHANGE,
          title: "Let tellers lock a card",
          state: "define",
          artifacts: [
            {
              artifact: "brief",
              path: `${REL}/brief.md`,
              status: "done",
              written: true,
              openFindings: 0,
            },
          ],
        }}
        stage="feature"
        extra={placementRows(placement())}
      />,
    );
    expect(html).toContain(`${REL}/brief.md`);
    expect(html).toContain(`${REL}/feature.md`);
    expect(html).toContain(`${REL}/feature.yaml`);
    expect(placementRows(placement({ present: false, content: "" }))).toEqual([]);
  });
});

const review = (o: Partial<Api.StageReviewViewT> = {}): Api.StageReviewViewT => ({
  change: CHANGE,
  stage: "stories",
  gate: "plan",
  round: 1,
  loop: { file: `${REL}/stage/stories.yaml`, present: true, state: "questions", iteration: 1 },
  findings: [],
  questions: [],
  next: { command: `atticus plan stories ${CHANGE}`, slash: `/atticus-stories ${CHANGE}` },
  problems: [],
  ...o,
});
const TERMINAL = '<details class="work-terminal">';

describe("the in-app Prepare comes before the terminal", () => {
  it("in the critic panel's not-run state, the command is folded under Or in a terminal", () => {
    const html = renderToStaticMarkup(
      <StageReviewView
        of={{
          state: "ready",
          data: review({ loop: { file: `${REL}/stage/stories.yaml`, present: false } }),
        }}
      />,
    );
    expect(html).toContain(TERMINAL);
    expect(html).toContain(esc(R.orTerminal));
    expect(html.indexOf(esc(R.slash))).toBeLessThan(html.indexOf(TERMINAL));
    expect(html.indexOf(TERMINAL)).toBeLessThan(html.indexOf(esc(R.terminal)));
    expect(html.indexOf(TERMINAL)).toBeLessThan(html.indexOf(`atticus plan stories ${CHANGE}`));
  });

  it("under Then run the stage again too", () => {
    const html = renderToStaticMarkup(<StageReviewView of={{ state: "ready", data: review() }} />);
    expect(html).toContain(esc(S.next));
    expect(html.indexOf(esc(S.next))).toBeLessThan(html.indexOf(TERMINAL));
    expect(html.indexOf(TERMINAL)).toBeLessThan(html.indexOf(esc(R.terminal)));
  });

  it("offers a fresh run of a stage that is done only under Run the stage again", () => {
    const html = renderToStaticMarkup(
      <StageReviewView
        of={{
          state: "ready",
          data: review({
            loop: { file: `${REL}/stage/stories.yaml`, present: true, state: "done" },
          }),
        }}
      />,
    );
    expect(html).toMatch(new RegExp(`<details[^>]*><summary>${esc(S.runAgain)}</summary>`));
    expect(html).toContain(esc(S.runAgainWhy));
    expect(html).not.toContain(`>${esc(S.next)}<`);
  });

  it("in the breaks panel and the target flows' empty states", () => {
    const impact = renderToStaticMarkup(
      <ImpactView i={{ change: CHANGE, flows: 0 } as unknown as Api.ChangeImpactT} />,
    );
    expect(impact).toContain(TERMINAL);
    expect(impact.indexOf(TERMINAL)).toBeLessThan(
      impact.indexOf(`atticus change architecture ${CHANGE}`),
    );
    const flows = renderToStaticMarkup(
      <TargetList list={{ change: CHANGE, flows: [], problems: [] }} current={undefined} />,
    );
    expect(flows).toContain(esc(COPY.flows.noTargets(CHANGE)));
    expect(flows).toContain(TERMINAL);
    expect(flows).toContain(`/atticus-architecture ${CHANGE}`);
    expect(flows.indexOf(TERMINAL)).toBeLessThan(
      flows.indexOf(`atticus change architecture ${CHANGE}</code>`),
    );
  });
});

describe("one path to write stories", () => {
  it("Breakdown links to the stories stage and offers no run of its own", () => {
    stories = review({ loop: { file: `${REL}/stage/stories.yaml`, present: false } });
    const html = renderToStaticMarkup(<StoriesAtTheStage change={CHANGE} />);
    expect(html).toContain(`href="#/stories?change=${CHANGE}"`);
    expect(html).toContain(esc(T.storiesAtTheStage));
    expect(html).not.toContain(esc(T.writeStoriesWithAi));
    expect(html).not.toContain("<button");
  });

  it("says the stage is done once it is", () => {
    stories = review({ loop: { file: `${REL}/stage/stories.yaml`, present: true, state: "done" } });
    const html = renderToStaticMarkup(<StoriesAtTheStage change={CHANGE} />);
    expect(html).toContain(esc(T.storiesStageDone));
    expect(html).not.toContain("<button");
  });
});

describe("focus after an action", () => {
  const doc = (active: unknown) => ({ body: "BODY", activeElement: active });
  it("moves to the result when the control used was disabled or taken away", () => {
    let focused = 0;
    const el = { focus: () => void focused++ };
    expect(focusIfLost(el, doc("BODY") as never)).toBe(true);
    expect(focusIfLost(el, doc(null) as never)).toBe(true);
    expect(focused).toBe(2);
  });
  it("stays where the person put it", () => {
    let focused = 0;
    const el = { focus: () => void focused++ };
    expect(focusIfLost(el, doc({ id: "elsewhere" }) as never)).toBe(false);
    expect(focusIfLost(null, doc("BODY") as never)).toBe(false);
    expect(focused).toBe(0);
  });
});

describe("Set up › Repos", () => {
  it("names the repo in each build button", () => {
    const repo = (id: string, build?: string) =>
      ({
        id,
        defaultBranch: "main",
        branches: ["main"],
        ...(build ? { build } : {}),
      }) as never;
    expect(renderToStaticMarkup(<BuildCommand r={repo("forge-card-vault")} />)).toContain(
      `aria-label="${esc(COPY.repos.setBuildFor("forge-card-vault"))}"`,
    );
    expect(
      renderToStaticMarkup(<BuildCommand r={repo("forge-teller-app", "npm test")} />),
    ).toContain(`aria-label="${esc(COPY.repos.changeBuildFor("forge-teller-app"))}"`);
  });
});

describe("the brief editor", () => {
  it("shows the template's guidance outside the text, and offers Close", () => {
    expect(
      templateHints(
        "<!-- Generated by atticus change feature. -->\n# Brief\n<!-- Who asked for it. -->\n<!--\n  What is true\n  once it ships.\n-->\n",
      ),
    ).toEqual(["Who asked for it.", "What is true once it ships."]);
    const html = renderToStaticMarkup(
      <ArtifactEditor change={CHANGE} artifact="brief" onClose={() => {}} />,
    );
    expect(html).toContain(esc(COPY.changes.templateAsks));
    expect(html).toContain("Who asked for it, and the problem they have.");
    expect(html).toMatch(/<textarea[^>]*aria-describedby="[^"]*hints/);
    expect(html).toContain(`>${esc(COPY.changes.close)}<`);
  });
});

const run = (o: Record<string, unknown>) =>
  ({
    id: "1.1",
    repo: "forge-card-vault",
    description: "Add the entry step",
    done: false,
    taskRun: {
      state: "pr-open",
      level: "pr",
      branch: `task/${CHANGE}/1.1`,
      notes: [],
      ...o,
    },
  }) as Task;

describe("a task's PR and its tick, as they are", () => {
  it("a manual host's PR not opened yet waits on you, once", () => {
    const html = renderToStaticMarkup(
      <TaskRunState
        change={CHANGE}
        task={run({ pr: { number: 11, url: "manual://git-host/forge-card-vault/pull/11" } })}
      />,
    );
    expect(html).toContain(esc(T.taskPrToOpen));
    expect(html).toContain(esc(T.taskPrWaitsOnYou));
    expect(html).not.toContain(esc(T.taskState["pr-open"]!));
    expect(html).not.toContain(esc(T.taskPrOpen));
  });

  it("a recorded PR is open, by its number", () => {
    const html = renderToStaticMarkup(
      <TaskRunState
        change={CHANGE}
        task={run({ pr: { number: 11, url: "https://git.forge.example/pull/11" } })}
      />,
    );
    expect(html).toContain(esc(T.taskPrOpenChip(11)));
    expect(html).toContain(esc(T.taskPrOpen));
    expect(html).not.toContain(esc(T.manualPrWaits));
  });

  it("a task a person ticked after Atticus did says who ticked it", () => {
    const ticked = "2026-11-08T09:00:00Z";
    const marked = { done: true, by: "pat", at: "2026-11-08T10:00:00Z" };
    const html = renderToStaticMarkup(
      <TaskTick change={CHANGE} task={{ ...run({ ticked, marked }), done: true }} />,
    );
    expect(html).toContain(esc(T.markedDoneBy("pat", "2026-11-08")));
    expect(html).not.toContain(esc(T.tickedByMerge));
    const merged = renderToStaticMarkup(
      <TaskTick change={CHANGE} task={{ ...run({ ticked }), done: true }} />,
    );
    expect(merged).toContain(esc(T.tickedByMerge));
  });

  it("Design vs plans vs code says no code yet before any task has run", () => {
    const none = renderToStaticMarkup(<DriftSummary open={[]} codeYet={false} />);
    expect(none).toContain(esc(T.noCodeYet));
    expect(none).not.toContain(esc(T.inSync));
    expect(renderToStaticMarkup(<DriftSummary open={[]} codeYet />)).toContain(esc(T.inSync));
  });
});

describe("a manual Git host's reviews step", () => {
  it("says who recorded the approval beside it", () => {
    const html = renderToStaticMarkup(
      <StepDetail
        step={
          {
            id: "s-3",
            change: CHANGE,
            system: "git-host",
            action: "report-pull-request",
            state: "done",
            title: "Record the reviews",
            where: "Git host",
            fields: [],
            instructions: [],
            result: [],
            waitsFor: [],
            recorded: {
              by: "dana",
              at: "2026-11-08T10:00:00Z",
              values: { approvers: ["pat"], checksPassing: true },
              via: "app",
            },
            runs: [],
            executors: [],
          } as never
        }
        done={() => {}}
      />,
    );
    expect(html).toContain(esc(COPY.todo.approvalRecordedBy("pat", "dana")));
  });
});
