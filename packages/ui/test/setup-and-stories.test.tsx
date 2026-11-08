import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * Seventh UX walk (setup and stories): what needed a file edit or a slash command has a place in
 * the app. A repo's build command on Repos, the org pack's owner on Home's setup, the spec step
 * where a repo's spec has no flows (and on the change diagram's "a step taken out"), AI proposing
 * answers on Questions, and the stories themselves on the Stories tab, each with Edit.
 */
vi.mock("../src/api/client.js", async () => ({
  ...(await vi.importActual<object>("../src/api/client.js")),
  useApi: (path: string | undefined) => {
    if (!path) return { state: "loading", reload: () => {} };
    if (path === "/api/setup")
      return {
        state: "ready",
        reload: () => {},
        data: {
          baselined: false,
          steps: [
            {
              id: "org-pack-owner",
              label: "The org pack has an owner",
              done: false,
              detail: "unassigned",
              fix: "Name the person who looks after the org pack.",
            },
          ],
        },
      };
    if (path.startsWith("/api/view/story-bar/"))
      return {
        state: "ready",
        reload: () => {},
        data: {
          code: 0,
          data: {
            change: "show-a-status",
            stories: [
              {
                id: "s1-read-status",
                path: "stories/s1-read-status.md",
                ready: true,
                problems: [],
              },
            ],
            ready: { passed: 1, total: 1, rate: 1, min: 0.9 },
            gaps: [],
            met: true,
          },
        },
      };
    if (path.startsWith("/api/changes/show-a-status/artifacts/stories"))
      return {
        state: "ready",
        reload: () => {},
        data: path.includes("?file=")
          ? {
              artifact: "stories",
              path: "openspec/changes/show-a-status/stories/s1-read-status.md",
              content: "# The ledger answers a status\n\nAs a teller I want …",
              sha256: "a",
            }
          : {
              artifact: "stories",
              path: "openspec/changes/show-a-status/stories.md",
              content: "# Stories\n",
              sha256: "b",
            },
      };
    return { state: "loading", reload: () => {} };
  },
}));

const { COPY } = await import("../src/copy.js");
const { FlowList } = await import("../src/screens/flows/Flows.js");
const { StrokeProblem } = await import("../src/screens/work/Sketch.js");
const { AskAiToPropose } = await import("../src/screens/Questions.js");
const { BuildCommand } = await import("../src/screens/run/Repos.js");
const { SetupChecklist } = await import("../src/screens/CommandCenter.js");
const { StoryFiles } = await import("../src/screens/know/Phase.js");

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

const repo = {
  id: "forge-teller",
  platform: "forge",
  url: "https://git.forge.example/forge/forge-teller.git",
  type: "react",
  owner: "team-branch",
  defaultBranch: "main",
  branches: [],
  scans: [],
};

describe("a repo's build command on Repos", () => {
  it("says a repo with none has its tasks unbuilt, and offers to set one", () => {
    const out = renderToStaticMarkup(<BuildCommand r={repo} />);
    expect(out).toContain(esc(COPY.repos.noBuild));
    expect(out).toContain(COPY.repos.setBuild);
    expect(out).toContain('aria-expanded="false"');
  });

  it("shows the command a repo has, with Change", () => {
    const out = renderToStaticMarkup(<BuildCommand r={{ ...repo, build: "npm ci && npm test" }} />);
    expect(out).toContain(esc("npm ci && npm test"));
    expect(out).toContain(COPY.repos.changeBuild);
  });

  it("is where the Task board sends a repo with no build command", () => {
    expect(COPY.phase.taskUnverified("forge-teller", "task/c/1.1", "change/c")).toContain(
      "set forge-teller's build command on Set up › Repos",
    );
  });
});

describe("the org pack's owner on Home's setup", () => {
  it("offers a labelled handle field under the step while no one owns the org pack", () => {
    const out = renderToStaticMarkup(<SetupChecklist />);
    expect(out).toContain(esc(COPY.commandCenter.ownerLabel));
    expect(out).toContain('for="org-pack-owner"');
    expect(out).toContain('id="org-pack-owner"');
    expect(out).toContain('aria-describedby="org-pack-owner-hint"');
    expect(out).toContain(COPY.commandCenter.ownerSave);
  });
});

describe("the spec step where a repo has no flows", () => {
  it("offers atticus spec draft on Flows for a repo whose spec is empty", () => {
    const out = renderToStaticMarkup(
      <FlowList
        spec={{ repo: "forge-teller", path: "specs/forge-teller", flows: [], problems: [] }}
        filter=""
        current={undefined}
      />,
    );
    expect(out).toContain(esc(COPY.flows.noFlows));
    expect(out).toContain(esc(COPY.flows.noFlowsSpec("forge-teller")));
    expect(out).toContain("atticus spec draft forge-teller");
  });

  it("offers it on the change diagram when a step can't be taken out of a flow not yet read", () => {
    const out = renderToStaticMarkup(
      <StrokeProblem problem="No flow of today's map is teller.pin: forge-teller's spec has no flows yet, so there is no step to take out. Its spec step writes them: atticus spec draft forge-teller" />,
    );
    expect(out).toContain('role="alert"');
    expect(out).toContain(esc("Its spec step writes them:"));
    expect(out).toContain("<code");
    expect(out).toContain("atticus spec draft forge-teller");
    expect(out).toContain('href="#/flows"');
    // Any other problem is said as it is.
    const other = renderToStaticMarkup(<StrokeProblem problem="teller has 2 flows: say which." />);
    expect(other).toContain("teller has 2 flows: say which.");
    expect(other).not.toContain("#/flows");
  });
});

describe("AI proposes answers on Questions", () => {
  it("names /atticus-propose and its command while questions are open, and nothing when none are", () => {
    const out = renderToStaticMarkup(<AskAiToPropose open={3} />);
    expect(out).toContain(COPY.questions.proposal.askTitle);
    expect(out).toContain("/atticus-propose");
    expect(out).toContain("atticus questions propose");
    expect(out).toContain('aria-labelledby="ask-ai-propose"');
    expect(renderToStaticMarkup(<AskAiToPropose open={0} />)).toBe("");
  });
});

describe("the stories on the Stories tab", () => {
  it("shows the index and each story's own text, each with Edit", () => {
    const out = renderToStaticMarkup(<StoryFiles change="show-a-status" listed />);
    expect(out).toContain(COPY.work.storiesIndex);
    expect(out).toContain(COPY.work.storyFile("s1-read-status"));
    expect(out).toContain("openspec/changes/show-a-status/stories/s1-read-status.md");
    expect(out).toContain("The ledger answers a status");
    expect(out.match(new RegExp(`>${COPY.phase.edit}<`, "g"))?.length ?? 0).toBeGreaterThan(1);
  });
});
