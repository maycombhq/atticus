import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Nav } from "../src/app/nav.js";
import { SectionTabs } from "../src/app/tabs.js";
import { screenOf } from "../src/app/screens.js";
import { COPY } from "../src/copy.js";
import type { QuestionListView } from "../src/screens/Questions.js";
import { DashboardPage } from "../src/screens/work/Dashboard.js";
import {
  architectureStep,
  dashboardStep,
  onboardingStep,
  pickChange,
  stageOf,
  stageStep,
  type ChangeRow,
  type OnboardingData,
  type TaskRow,
} from "../src/screens/work/next.js";
import { OnboardingPage } from "../src/screens/work/Onboarding.js";
import { RunNextPanel } from "../src/screens/work/RunNext.js";
import { ArchitectureStep, StagePage, type ChangeDetailView } from "../src/screens/work/Stage.js";

const html = (el: ReactElement) => renderToStaticMarkup(el);
/** Text as React writes it into HTML. */
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
const W = COPY.work;
const R = COPY.runNext;

const repo = (id: string, o: Partial<OnboardingData["repos"][number]> = {}) => ({
  id,
  platform: "forge",
  type: "forge-service",
  owner: "team-ledger",
  manifest: "org-pack/profiles/forge/repos.manifest.yaml",
  cloned: true,
  scanSettings: { path: `org-pack/scan/${id}.yaml`, present: true },
  lastScan: { records: 4, kinds: { Endpoint: 3, Table: 1 }, commit: "abc1234def" },
  ...o,
});

const view = (repos: OnboardingData["repos"], records = 4): OnboardingData => ({
  manifests: repos.length
    ? [
        {
          platform: "forge",
          path: "org-pack/profiles/forge/repos.manifest.yaml",
          repos: repos.length,
        },
      ]
    : [],
  repos,
  sources: {
    path: "org-pack/sources.yaml",
    present: true,
    wikis: [{ id: "forge-wiki", type: "markdown-folder", location: "wiki", spaces: ["Ledger"] }],
    absorbed: [],
  },
  catalog: { records },
  problems: [],
});

const done = view([repo("forge-ledger"), repo("forge-portal-bff")]);
const noQuestions: QuestionListView = { questions: [], problems: [] };
const change = (id: string, state: string): ChangeRow => ({ id, title: `Title of ${id}`, state });
const tasks: TaskRow[] = [
  { id: "1.1", repo: "forge-ledger", description: "Add the limit table", done: true },
  { id: "1.2", repo: "forge-ledger", description: "Check the limit", done: false },
];

describe("what to run next (plan 4.5)", () => {
  it("walks onboarding in order: pick, clone, survey, scan, answer, review", () => {
    expect(onboardingStep(view([]), 0).command).toBe("atticus repos discover <folder>");
    expect(onboardingStep(view([repo("a", { cloned: false }), repo("b")]), 0)).toMatchObject({
      command: "atticus workspace sync",
      why: W.why.sync(1),
    });
    expect(
      onboardingStep(
        view([repo("a"), repo("b", { scanSettings: { path: "x", present: false } })]),
        0,
      ).command,
    ).toBe("atticus scan survey b");
    // ADR 0086: the AI steps have their slash commands now.
    expect(
      onboardingStep(
        view([repo("a"), repo("b", { scanSettings: { path: "x", present: false } })]),
        0,
      ).slash?.command,
    ).toBe("/atticus-survey b");
    expect(onboardingStep(view([repo("a", { lastScan: null })]), 0).command).toBe("atticus scan");
    expect(onboardingStep(view([repo("a")], 0), 0).command).toBe("atticus scan");
    const answer = onboardingStep(done, 2);
    expect(answer.link?.href).toBe("#/questions");
    expect(answer.slash?.command).toBe("/atticus-answer");
    expect(onboardingStep(done, 0).command).toBe("atticus scan review forge-ledger");
  });

  it("puts a change at the stage its state says, with that stage's command", () => {
    expect(["draft", "define", "returned"].map(stageOf)).toEqual(["feature", "feature", "feature"]);
    expect(stageOf("design")).toBe("architecture");
    expect(stageOf("plan")).toBe("stories");
    expect(stageOf("build")).toBe("tasks");
    expect(stageOf("released")).toBe("done");
    expect(stageStep("feature", change("add-limit", "define")).command).toBe(
      "atticus change feature add-limit",
    );
    expect(stageStep("feature", change("add-limit", "define")).slash?.command).toBe(
      "/atticus-feature add-limit",
    );
    const stories = stageStep("stories", change("add-limit", "plan"));
    expect(stories.command).toBe("atticus plan stories add-limit");
    expect(stories.slash?.command).toBe("/atticus-stories add-limit");
    const task = stageStep("tasks", change("add-limit", "build"), tasks);
    expect(task.command).toBe("atticus task run add-limit 1.2");
    // ADR 0113: /atticus-task loads the task's context in the metarepo.
    expect(task.slash).toEqual({ command: "/atticus-task add-limit 1.2", where: "the metarepo" });
  });

  it("gives a small change the fast path's one step until it is built (ADR 0113)", () => {
    const small = { ...change("fix-label", "plan"), fastPath: true };
    const s = stageStep("stories", small);
    expect(s.command).toBe("atticus change small fix-label");
    expect(s.slash?.command).toBe("/atticus-small fix-label");
    expect(s.after?.map((a) => a.command)).toEqual(["atticus change handoff fix-label --approve"]);
    // Every planning page shows it, wherever the change's state is among them.
    expect(stageStep("feature", small).command).toBe("atticus change small fix-label");
    const built = stageStep("tasks", { ...change("fix-label", "build"), fastPath: true }, tasks);
    expect(built.command).toBe("atticus task run fix-label 1.2");
  });

  it("points a stage page at the page a change is really at", () => {
    const s = stageStep("feature", change("add-limit", "plan"));
    expect(s.command).toBe("atticus change status add-limit");
    expect(s.link?.href).toBe("#/stories?change=add-limit");
  });

  it("opens a stage page on the change in the route, else the first at that stage", () => {
    const list = [change("a", "define"), change("b", "plan"), change("c", "released")];
    expect(pickChange(list, "c", "stories")?.id).toBe("c");
    expect(pickChange(list, undefined, "stories")?.id).toBe("b");
    expect(pickChange(list, undefined, "tasks")?.id).toBe("a");
    expect(pickChange([], undefined, "tasks")).toBeUndefined();
  });

  it("has the dashboard finish onboarding first, then follow a change, then start one", () => {
    expect(dashboardStep(view([]), 0, []).link?.href).toBe("#/onboarding");
    const c = dashboardStep(done, 0, [change("old", "released"), change("add-limit", "plan")]);
    expect(c.command).toBe("atticus plan stories add-limit");
    expect(c.link?.href).toBe("#/stories?change=add-limit");
    expect(dashboardStep(done, 0, []).command).toBe('atticus change new "<title>" --type <type>');
  });

  it("has the Architecture page follow a change at the design stage, else rescan", () => {
    expect(architectureStep([change("a", "design")]).command).toBe("atticus change architecture a");
    expect(architectureStep([change("a", "plan")]).command).toBe("atticus scan");
  });
});

describe("Run next", () => {
  it("shows the command with a labelled copy button, and the slash command where one exists", () => {
    const out = html(
      <RunNextPanel
        step={{
          command: "atticus plan stories add-limit",
          why: W.why.stories,
          slash: { command: "/atticus-plan add-limit", where: W.slashWhere.metarepo },
        }}
      />,
    );
    expect(out).toContain(R.title);
    expect(out).toContain("atticus plan stories add-limit");
    expect(out).toContain(`aria-label="${R.copy}: atticus plan stories add-limit"`);
    expect(out).toContain("/atticus-plan add-limit");
    expect(out).toContain(R.slash);
  });

  it("says when no slash command does the step", () => {
    const out = html(<RunNextPanel step={{ command: "atticus scan", why: W.why.scan }} />);
    expect(out).toContain(esc(R.noSlash));
  });
});

describe("the menu: six entries (the Surfaces design)", () => {
  const ENTRIES = ["Home", "Map", "Change", "Questions", "Knowledge", "Set up"];

  it("lists the six in order, each opening on its first tab, the entry shown marked", () => {
    const out = html(<Nav current={screenOf("#/flows")} />);
    const order = ENTRIES.map((l) => out.indexOf(`>${l}</a>`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(out).toContain('href="#/canvas" aria-current="page"');
    expect(out).toContain('href="#/feature-design"');
    expect(out).toContain('href="#/repos"');
    expect(out).not.toContain(">Atticus</a>");
    expect(out).not.toContain("nav-more");
    expect(out).not.toContain('aria-expanded="');
  });

  it("adds Atticus's own pages as a seventh entry with --full", () => {
    const out = html(<Nav current={screenOf("#/runs")} full />);
    expect(out).toContain('href="#/runs" aria-current="page">Atticus</a>');
    expect(out).toContain('href="#/changes">Change</a>');
  });

  it("marks the entry of the page shown, also one behind --full opened by its address", () => {
    expect(html(<Nav current={screenOf("#/scans")} />)).toContain(
      'href="#/repos" aria-current="page"',
    );
    expect(html(<Nav current={screenOf("#/questions")} />)).toContain(
      'href="#/questions" aria-current="page"',
    );
    expect(html(<Nav current={screenOf("#/cockpit?change=x")} />)).toContain(
      'href="#/feature-design" aria-current="page"',
    );
  });
});

describe("an entry's tabs", () => {
  it("shows where you are and the entry's tabs only, the page shown marked", () => {
    const out = html(<SectionTabs current={screenOf("#/trust")} hash="#/trust" />);
    expect(out).toContain('aria-label="You are here"');
    expect(out).toContain('aria-label="Map pages"');
    expect(out).toContain('href="#/trust" aria-current="page"');
    for (const id of ["canvas", "flows", "contracts", "impact"]) expect(out).toContain(`#/${id}"`);
    for (const id of ["map", "features", "explore", "systems"])
      expect(out).not.toContain(`href="#/${id}"`);
  });

  it("gives Change its four stage tabs, keeping the change, with no phase groups", () => {
    const hash = "#/stories?change=add-fraud-check";
    const out = html(<SectionTabs current={screenOf(hash)} hash={hash} />);
    expect(out).toContain("change add-fraud-check");
    expect(out).toContain('href="#/stories?change=add-fraud-check" aria-current="page"');
    for (const id of ["feature-design", "architecture", "task-list"])
      expect(out).toContain(`href="#/${id}?change=add-fraud-check"`);
    expect(out).not.toContain('href="#/brief');
    expect(out).not.toContain('aria-label="Define"');
  });

  it("with --full groups a change's pages by phase, the list's tab named for the change", () => {
    const hash = "#/estimate?change=add-fraud-check";
    const out = html(<SectionTabs current={screenOf(hash)} hash={hash} full />);
    for (const g of ["Define", "Design", "Plan", "Build", "Release"])
      expect(out).toContain(`aria-label="${g}"`);
    expect(out).toContain('href="#/estimate?change=add-fraud-check" aria-current="page"');
    expect(out).toContain('href="#/brief?change=add-fraud-check"');
    expect(out).toContain('href="#/changes/add-fraud-check"');
    // The list's tab doesn't repeat the entry's name.
    expect(out).toContain(">This change</a>");
    const list = html(<SectionTabs current={screenOf("#/changes")} hash="#/changes" full />);
    expect(list).toContain(">All changes</a>");
  });

  it("shows no tabs for a one-page entry, but says where a page reached by a link is", () => {
    expect(html(<SectionTabs current={screenOf("#/questions")} hash="#/questions" />)).toBe("");
    expect(html(<SectionTabs current={screenOf("#/home")} hash="#/home" />)).toBe("");
    const words = html(<SectionTabs current={screenOf("#/words")} hash="#/words" />);
    expect(words).toContain('aria-label="You are here"');
    expect(words).not.toContain('aria-label="Home pages"');
    const glance = html(
      <SectionTabs current={screenOf("#/cockpit?change=x")} hash="#/cockpit?change=x" />,
    );
    expect(glance).toContain('aria-current="location">At a glance</span>');
    expect(glance).not.toContain('aria-current="page"');
  });
});

describe("the Dashboard", () => {
  it("has loading and error states", () => {
    expect(
      html(
        <DashboardPage
          onboarding={{ state: "loading" }}
          changes={{ state: "loading" }}
          questions={{ state: "loading" }}
        />,
      ),
    ).toContain('aria-busy="true"');
    expect(
      html(
        <DashboardPage
          onboarding={{ state: "error", error: "boom" }}
          changes={{ state: "ready", data: [] }}
          questions={{ state: "ready", data: noQuestions }}
        />,
      ),
    ).toContain('role="alert"');
  });

  it("shows coverage, changes in flight with their stage, open questions and the slash commands", () => {
    const out = html(
      <DashboardPage
        onboarding={{ state: "ready", data: done }}
        changes={{
          state: "ready",
          data: [change("add-limit", "plan"), change("gone", "archived")],
        }}
        questions={{
          state: "ready",
          data: {
            questions: [
              {
                schemaVersion: 1,
                id: "q-a4a06bcb15a5",
                askedBy: {
                  step: "scan-survey",
                  command: "atticus scan survey forge-ledger",
                  at: "2026-10-21T12:00:00.000Z",
                },
                repo: "forge-ledger",
                question: "Is docs/ part of the product?",
                options: [],
                evidence: ["docs/x.js:1"],
                scope: { level: "repo", id: "forge-ledger" },
                state: "open",
                rerun: "atticus scan survey forge-ledger --force",
              },
            ],
            problems: [],
          },
        }}
      />,
    );
    expect(out).toContain(W.coverage);
    expect(out).toContain("2 of 2 scanned");
    expect(out).toContain('href="#/stories?change=add-limit"');
    expect(out).not.toContain(">gone<");
    expect(out).toContain('href="#/questions/q-a4a06bcb15a5"');
    // Onboarding isn't done while a question waits: Run next sends the person to answer it.
    expect(out).toContain("atticus questions list --state open");
    for (const c of R.commands) expect(out).toContain(c.name);
    // ADR 0105: the commands are in Copilot Chat and, through the plugin, in Claude Code.
    expect(W.slashTitle).toMatch(/Copilot Chat.*Claude Code/);
    expect(out).toContain("atticus assistant-files");
    expect(out).toContain("/plugin marketplace add maycombhq/atticus");
    expect(out).toContain("/plugin install atticus@maycombhq");
  });

  it("says when nothing is in flight or waiting", () => {
    const out = html(
      <DashboardPage
        onboarding={{ state: "ready", data: done }}
        changes={{ state: "ready", data: [] }}
        questions={{ state: "ready", data: noQuestions }}
      />,
    );
    expect(out).toContain(esc(W.noQuestions));
    expect(out).toContain("atticus change new");
  });
});

describe("Onboarding", () => {
  it("has loading and error states", () => {
    const q = { state: "ready", data: noQuestions } as const;
    expect(html(<OnboardingPage of={{ state: "loading" }} questions={q} />)).toContain(
      'aria-busy="true"',
    );
    expect(html(<OnboardingPage of={{ state: "error", error: "boom" }} questions={q} />)).toContain(
      'role="alert"',
    );
  });

  it("says what to do when no manifest lists a repo", () => {
    const out = html(
      <OnboardingPage
        of={{
          state: "ready",
          data: { ...view([]), sources: { ...view([]).sources, present: false } },
        }}
        questions={{ state: "ready", data: noQuestions }}
      />,
    );
    expect(out).toContain(esc(W.noRepos));
    expect(out).toContain(esc(W.stepPickNone));
    expect(out).toContain("atticus repos discover &lt;folder&gt;");
    expect(out).toContain(esc(W.sourcesMissing("org-pack/sources.yaml")));
  });

  it("shows the manifest file, each repo's clone, scan settings, type command and last scan, and the steps", () => {
    const v = view([
      repo("forge-ledger"),
      repo("forge-portal-bff", {
        cloned: false,
        scanSettings: { path: "org-pack/scan/forge-portal-bff.yaml", present: false },
        lastScan: null,
      }),
    ]);
    const out = html(
      <OnboardingPage
        of={{ state: "ready", data: v }}
        questions={{ state: "ready", data: noQuestions }}
      />,
    );
    expect(out).toContain("org-pack/profiles/forge/repos.manifest.yaml");
    expect(out).toContain("org-pack/scan/forge-ledger.yaml");
    expect(out).toContain(W.settingsMissing);
    expect(out).toContain("atticus repo-type detect forge-ledger");
    // The survey is an AI step: its runs are a link away (ADR 0106).
    expect(out).toContain('href="#/runs?q=survey"');
    expect(out).toContain(COPY.runs.surveys);
    expect(out).toContain(W.recordCount(4));
    expect(out).toContain(W.atCommit("abc1234def"));
    expect(out).toContain("Endpoint 3, Table 1");
    expect(out).toContain(W.notScanned);
    expect(out).toContain("forge-wiki");
    expect(out).toContain('href="#/questions"');
    // Run next: one repo isn't cloned.
    expect(out).toContain(esc(W.why.sync(1)));
    const steps = [
      "atticus workspace sync",
      "atticus scan survey forge-portal-bff",
      "atticus scan</code>",
      "atticus scan review forge-ledger",
    ];
    const at = steps.map((s) => out.lastIndexOf(s));
    expect(at.every((i) => i > 0)).toBe(true);
  });

  it("names a file it couldn't read", () => {
    const v = {
      ...view([]),
      problems: [{ file: "org-pack/profiles/forge/repos.manifest.yaml", message: "bad" }],
    };
    const out = html(
      <OnboardingPage
        of={{ state: "ready", data: v }}
        questions={{ state: "ready", data: noQuestions }}
      />,
    );
    expect(out).toContain(esc(W.unreadable));
  });
});

const detail: ChangeDetailView = {
  ...change("add-limit", "build"),
  artifacts: [
    {
      artifact: "brief",
      path: "openspec/changes/add-limit/brief.md",
      status: "done",
      openFindings: 0,
    },
    {
      artifact: "tasks",
      path: "openspec/changes/add-limit/tasks.md",
      status: "done",
      openFindings: 0,
    },
  ],
};

describe("Feature design, Stories and Tasks", () => {
  it("has loading, error and empty states", () => {
    expect(
      html(
        <StagePage
          stage="feature"
          list={{ state: "loading" }}
          detail={undefined}
          tasks={undefined}
        />,
      ),
    ).toContain('aria-busy="true"');
    expect(
      html(
        <StagePage
          stage="feature"
          list={{ state: "error", error: "boom" }}
          detail={undefined}
          tasks={undefined}
        />,
      ),
    ).toContain('role="alert"');
    expect(
      html(
        <StagePage
          stage="stories"
          list={{ state: "ready", data: [] }}
          detail={undefined}
          tasks={undefined}
        />,
      ),
    ).toContain(esc(W.noChangeYet));
  });

  it("shows the feature stage's files and its command", () => {
    const out = html(
      <StagePage
        stage="feature"
        list={{ state: "ready", data: [change("add-limit", "define")] }}
        detail={{ state: "ready", data: { ...detail, state: "define" } }}
        tasks={undefined}
      />,
    );
    expect(out).toContain("openspec/changes/add-limit/brief.md");
    expect(out).not.toContain("openspec/changes/add-limit/tasks.md");
    expect(out).toContain("atticus change feature add-limit");
    expect(out).toContain('<label for="pick-feature-design"');
  });

  it("lists each task with its command and the slash command for Copilot Chat", () => {
    const out = html(
      <StagePage
        stage="tasks"
        list={{ state: "ready", data: [change("add-limit", "build")] }}
        detail={{ state: "ready", data: detail }}
        tasks={{ state: "ready", data: tasks }}
      />,
    );
    expect(out).toContain("atticus task run add-limit 1.1");
    expect(out).toContain("/atticus-task add-limit 1.1");
    expect(out).toContain("atticus task run add-limit 1.2");
    expect(out).toContain("/atticus-task add-limit 1.2");
  });

  it("says when a change has no tasks yet", () => {
    const out = html(
      <StagePage
        stage="tasks"
        list={{ state: "ready", data: [change("add-limit", "build")] }}
        detail={{ state: "ready", data: detail }}
        tasks={{ state: "ready", data: [] }}
      />,
    );
    expect(out).toContain(esc(W.noTasks.replace("<change>", "add-limit")));
  });

  it("gives the Architecture page a Run next", () => {
    const out = html(<ArchitectureStep list={{ state: "ready", data: [change("a", "design")] }} />);
    expect(out).toContain(R.title);
    expect(out).toContain("atticus change architecture a");
  });
});

describe("where the slash commands are (ADR 0104, 0105)", () => {
  /** Every string the copy file holds, functions called with a placeholder. */
  const words = (v: unknown): string[] =>
    typeof v === "string"
      ? [v]
      : typeof v === "function"
        ? words((v as (...a: string[]) => unknown)("x", "x", "x", "x"))
        : v && typeof v === "object"
          ? Object.values(v).flatMap(words)
          : [];

  it("never says they are only in Copilot Chat: Claude Code has them too", () => {
    const only = words(COPY).filter((t) => /Copilot Chat/.test(t) && !/Claude Code/.test(t));
    expect(only).toEqual([]);
  });
});
