import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Nav } from "../src/app/nav.js";
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
    expect(onboardingStep(view([repo("a", { lastScan: null })]), 0).command).toBe("atticus scan");
    expect(onboardingStep(view([repo("a")], 0), 0).command).toBe("atticus scan");
    const answer = onboardingStep(done, 2);
    expect(answer.link?.href).toBe("#/questions");
    expect(onboardingStep(done, 0).command).toBe("atticus scan review forge-ledger");
  });

  it("puts a change at the stage its state says, with that stage's command", () => {
    expect(["draft", "define", "returned"].map(stageOf)).toEqual(["feature", "feature", "feature"]);
    expect(stageOf("design")).toBe("architecture");
    expect(stageOf("plan")).toBe("stories");
    expect(stageOf("build")).toBe("tasks");
    expect(stageOf("released")).toBe("done");
    expect(stageStep("feature", change("add-limit", "define")).command).toBe(
      "atticus change draft add-limit",
    );
    const stories = stageStep("stories", change("add-limit", "plan"));
    expect(stories.command).toBe("atticus plan stories add-limit");
    expect(stories.slash?.command).toBe("/atticus-plan add-limit");
    const task = stageStep("tasks", change("add-limit", "build"), tasks);
    expect(task.command).toBe("atticus task run add-limit 1.2");
    expect(task.slash).toEqual({ command: "/atticus-task 1.2", where: "forge-ledger" });
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
    expect(architectureStep([change("a", "design")]).command).toBe("atticus change status a");
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

describe("the menu", () => {
  it("lists the six screens, then More, closed while a main screen is shown", () => {
    const out = html(<Nav current={screenOf("#/dashboard")} />);
    const order = [
      "Dashboard",
      "Onboarding",
      "Feature design",
      "Architecture",
      "Stories",
      "Tasks",
    ].map((l) => out.indexOf(`>${l}</a>`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(out).toContain('aria-expanded="false"');
    expect(out).toContain('aria-controls="nav-more"');
    expect(out).toMatch(/id="nav-more" hidden=""/);
    expect(out).toContain('href="#/dashboard" aria-current="page"');
  });

  it("opens More when the page shown is one of its pages", () => {
    const out = html(<Nav current={screenOf("#/scans")} />);
    expect(out).toContain('aria-expanded="true"');
    expect(out).not.toMatch(/id="nav-more" hidden/);
    expect(out).toContain('href="#/scans" aria-current="page"');
    expect(out).toContain('href="#/tasks"');
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
    expect(out).toContain("atticus change draft add-limit");
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
    expect(out).toContain("/atticus-task 1.1");
    expect(out).toContain("atticus task run add-limit 1.2");
    expect(out).toContain("atticus assistant-files --repo forge-ledger --change add-limit");
    expect(out).toContain(R.slashIn("forge-ledger"));
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
    expect(out).toContain("atticus change status a");
  });
});
