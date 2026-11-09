import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { all, mount, text } from "./support/hooks.js";

/**
 * ADR 0188: the app offers a button for every step in the daily path. A command a page shows
 * becomes its button when the app can take the step (an AI step, Apply, a sync, the estate join,
 * a task's context, the history toggle), the command folded under "In a terminal"; a canvas
 * edit's "run this to redraw" is Apply and Propose; an empty catalog offers Map › Trust; the
 * stories refused over a person's files offer Draft the stories again. Everything is the invented
 * Forge estate (CLAUDE.md rule 3).
 */
vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
const calls: { path: string; method: string; body?: unknown }[] = [];
let handoffRefusal: string | undefined;
let proposeFiles: { path: string; status: string; proposed?: string }[] = [];
let applyFirst: string[] = [];
vi.mock("../src/api/client.js", async () => {
  const real = await vi.importActual<typeof import("../src/api/client.js")>("../src/api/client.js");
  return {
    ...real,
    api: async (path: string, o: { method?: string; body?: unknown } = {}) => {
      calls.push({ path, method: o.method ?? "GET", ...(o.body ? { body: o.body } : {}) });
      if (path.startsWith("/api/runs?")) return { runs: [], serverModel: null };
      if (path === "/api/runs/handoff") {
        if (handoffRefusal)
          throw new real.ApiError({
            type: "about:blank",
            status: 422,
            title: "No",
            detail: handoffRefusal,
          });
        return { runId: "run-7", lines: [] };
      }
      if (path.startsWith("/api/jobs/"))
        return { state: "done", errors: [], result: { code: 0, lines: ["forge-ledger: removed"] } };
      if (path.endsWith("/context")) return { markdown: "# Task 1.2\n\nThe ledger's limit." };
      if (o.method === "POST") return { jobId: "job-1" };
      return { on: false };
    },
    useApi: (path: string) =>
      path.startsWith("/api/propose")
        ? {
            state: "ready",
            data: { scope: "work", files: proposeFiles, branch: "b", title: "t", applyFirst },
            reload: () => {},
          }
        : { state: "loading", reload: () => {} },
  };
});
const { COPY } = await import("../src/copy.js");
const S = await import("../src/app/app-step.js");
const { stepArgs, forceAgain, RunStep, HandoffStep } = await import("../src/app/runstep.js");
const { Command } = await import("../src/screens/work/RunNext.js");
const { ApplyAndPropose, Propose } = await import("../src/app/propose.js");
const Q = await import("../src/screens/Questions.js");
const N = await import("../src/screens/work/next.js");
const { Note } = await import("../src/screens/know/common.js");
/** What the button's note says once it ends. */
const said = (tree: unknown) =>
  (all(tree).find((e) => e.type === Note)?.props.note as { text?: string } | undefined)?.text;
const T = COPY.appStep;
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("which commands the app takes itself", () => {
  it("reads the AI steps, Apply and the local steps; nothing with a placeholder or a stray option", () => {
    expect(S.appStep("atticus map forge-ledger")).toEqual({
      kind: "ai",
      args: ["map", "forge-ledger"],
    });
    expect(S.appStep("atticus change small add-a-limit")).toEqual({
      kind: "ai",
      args: ["change", "small", "add-a-limit"],
    });
    expect(S.appStep("atticus map --all --repos forge-ledger")).toEqual({
      kind: "ai",
      args: ["map", "forge-ledger"],
    });
    expect(S.appStep("atticus verify forge-ledger --write")).toEqual({
      kind: "apply",
      repo: "forge-ledger",
    });
    expect(S.appStep("atticus verify forge-ledger")).toEqual({
      kind: "apply",
      repo: "forge-ledger",
    });
    expect(S.appStep("atticus verify --all --write")).toEqual({ kind: "apply-all" });
    expect(S.appStep("atticus task context add-a-limit 1.2")).toEqual({
      kind: "task-context",
      change: "add-a-limit",
      task: "1.2",
    });
    const path = (c: string) => {
      const s = S.appStep(c);
      return s?.kind === "call" ? `${s.method} ${s.path} ${JSON.stringify(s.body ?? {})}` : s;
    };
    expect(path("atticus workspace sync")).toBe("POST /api/workspace/sync {}");
    expect(path("atticus sources sync")).toBe("POST /api/knowledge/sources/sync {}");
    expect(path("atticus estate join")).toBe("POST /api/estate/join {}");
    expect(path("atticus workspace prune")).toBe("POST /api/workspace/prune {}");
    expect(path("atticus workspace prune add-a-limit")).toBe(
      'POST /api/workspace/prune {"change":"add-a-limit"}',
    );
    expect(path("atticus history off")).toBe('PUT /api/history/recording {"on":false}');
    expect(path("atticus history on")).toBe('PUT /api/history/recording {"on":true}');
    for (const no of [
      "atticus map <repo>",
      "atticus map forge-ledger --estimate",
      "atticus map render forge-ledger",
      "atticus verify forge-ledger --write --verbose",
      "atticus repos discover <folder>",
      "atticus change status add-a-limit",
      "atticus sources sync --source wiki",
      "/atticus-map forge-ledger",
    ])
      expect(S.appStep(no), no).toBeUndefined();
  });

  it("starts plan stories with --force, and no other step with an option", () => {
    expect(stepArgs("atticus plan stories add-a-limit --force")).toEqual([
      "plan",
      "stories",
      "add-a-limit",
      "--force",
    ]);
    expect(stepArgs("atticus change feature add-a-limit --force")).toBeUndefined();
    expect(stepArgs("atticus map forge-ledger --force")).toBeUndefined();
    expect(stepArgs("atticus map forge-ledger")).toEqual(["map", "forge-ledger"]);
    expect(stepArgs("atticus change small add-a-limit")).toEqual([
      "change",
      "small",
      "add-a-limit",
    ]);
  });
});

describe("a command on a page", () => {
  it("shows the step's button first and folds the command under In a terminal", () => {
    const out = renderToStaticMarkup(
      <Command text="atticus verify forge-ledger --write" label="Copy" />,
    );
    expect(out).toContain(COPY.propose.apply("forge-ledger").replace(/'/g, "&#x27;"));
    expect(out).toContain(`<summary>${T.inTerminal}</summary>`);
    expect(out.indexOf("<button")).toBeLessThan(out.indexOf("<details"));
    expect(out.indexOf("<details")).toBeLessThan(out.indexOf("atticus verify forge-ledger"));
  });

  it("keeps a command the app can't take on its own line, and noRun's too", () => {
    for (const out of [
      renderToStaticMarkup(<Command text="atticus repos discover <folder>" label="Copy" />),
      renderToStaticMarkup(<Command text="atticus workspace sync" label="Copy" noRun />),
    ]) {
      expect(out).not.toContain("<details");
      expect(out).toContain('class="work-cmd"');
    }
  });

  it("gives an AI step its Run or Prepare, and the read of a repo is Read with my assistant", async () => {
    const tree = Command({ text: "atticus map forge-ledger", label: "Copy" }) as never;
    const step = all(tree).find((e) => e.type === S.AppStep)!;
    expect(step.props.step).toEqual({ kind: "ai", args: ["map", "forge-ledger"] });
    const m = mount(HandoffStep as never, { args: ["map", "forge-ledger"] } as never);
    const b = all(m.tree).find((e) => e.type === "button")!;
    expect(text(b.props.children)).toBe(COPY.runStep.handoffRead);
    calls.length = 0;
    (b.props.onClick as () => void)();
    await tick();
    m.render();
    expect(calls).toEqual([
      { path: "/api/runs/handoff", method: "POST", body: { args: ["map", "forge-ledger"] } },
    ]);
    expect(all(m.tree).find((e) => e.type === "a")!.props.href).toBe("#/runs?run=run-7");
  });
});

describe("the local steps' buttons", () => {
  it("runs the step as a job and shows what it printed", async () => {
    const step = S.appStep("atticus workspace prune")!;
    const m = mount(S.CallButton as never, { step } as never);
    const b = all(m.tree).find((e) => e.type === "button")!;
    expect(text(b.props.children)).toBe(T.prune);
    expect(text(m.tree)).toContain(T.pruneSay);
    calls.length = 0;
    (b.props.onClick as () => void)();
    await tick();
    await tick();
    m.render();
    expect(calls[0]).toEqual({ path: "/api/workspace/prune", method: "POST", body: {} });
    expect(text(m.tree)).toContain("forge-ledger: removed");
    expect(said(m.tree)).toBe(T.pruned);
  });

  it("turns this machine's recording off with a PUT", async () => {
    const m = mount(S.CallButton as never, { step: S.appStep("atticus history off")! } as never);
    const b = all(m.tree).find((e) => e.type === "button")!;
    expect(text(b.props.children)).toBe(T.historyOff);
    calls.length = 0;
    (b.props.onClick as () => void)();
    await tick();
    m.render();
    expect(calls).toEqual([{ path: "/api/history/recording", method: "PUT", body: { on: false } }]);
    expect(said(m.tree)).toBe(T.historyNowOff);
  });

  it("copies the task's context for the person's assistant", async () => {
    const wrote: string[] = [];
    vi.stubGlobal("navigator", {
      clipboard: { writeText: async (t: string) => void wrote.push(t) },
    });
    const m = mount(S.TaskContext as never, { change: "add-a-limit", task: "1.2" } as never);
    const b = all(m.tree).find((e) => e.type === "button")!;
    expect(text(b.props.children)).toBe(T.taskContext);
    (b.props.onClick as () => void)();
    await tick();
    await tick();
    m.render();
    expect(calls.at(-1)?.path).toBe("/api/changes/add-a-limit/tasks/1.2/context");
    expect(wrote).toEqual(["# Task 1.2\n\nThe ledger's limit."]);
    expect(said(m.tree)).toBe(T.taskContextCopied);
    vi.unstubAllGlobals();
  });
});

describe("a canvas edit, once written", () => {
  it("offers Apply for its repo, then Propose; the commands folded", () => {
    const tree = S.WrittenNext({
      said: COPY.declare.written,
      verify: "atticus verify forge-ledger --write",
      commit: 'git add facts/forge-ledger.corrections.jsonl\ngit commit -m "x"',
    });
    const step = all(tree).find((e) => e.type === S.AppStep)!;
    expect(step.props).toEqual({
      step: { kind: "apply", repo: "forge-ledger" },
      scope: "corrections",
    });
    const out = renderToStaticMarkup(tree);
    expect(out).toContain(COPY.declare.written);
    expect(out).not.toMatch(/Run this to redraw/);
    expect(out).toContain(`<summary>${T.inTerminal}</summary>`);
    expect(out).toContain("git add facts/forge-ledger.corrections.jsonl");
  });

  it("applies a declaration to every repo's map, then proposes the app's work", () => {
    const tree = S.WrittenNext({ said: "x", verify: "atticus verify --all --write", commit: "" });
    expect(all(tree).find((e) => e.type === S.AppStep)!.props.step).toEqual({ kind: "apply-all" });
    const m = mount(S.ApplyAll as never, {} as never);
    expect(text(all(m.tree).find((e) => e.type === "button")!.props.children)).toBe(T.applyAll);
    expect(all(m.tree).find((e) => e.type === Propose)?.props.scope).toBe("work");
  });
});

describe("an empty catalog", () => {
  it("offers Map › Trust, where a repo is read, never a command", () => {
    const out = renderToStaticMarkup(<S.CatalogEmpty text={COPY.explore.theCatalogIsEmpty} />);
    expect(out).toContain('href="#/trust"');
    expect(out).toContain(T.openTrust.replace(/›/g, "›"));
    expect(COPY.explore.theCatalogIsEmpty).not.toMatch(/atticus /);
    expect(COPY.know.theCatalogIsEmpty).not.toMatch(/atticus /);
    expect(COPY.design.noSystemToDraw).not.toMatch(/atticus /);
  });
});

describe("Draft the stories again", () => {
  it("offers the stories step with --force once it refused over a person's files", async () => {
    const said =
      "add-a-limit already has planning files a person wrote: stories.md. Re-run with --force to replace them.";
    expect(forceAgain(["plan", "stories", "add-a-limit"], said)).toEqual([
      "plan",
      "stories",
      "add-a-limit",
      "--force",
    ]);
    expect(forceAgain(["change", "feature", "add-a-limit"], said)).toBeUndefined();
    expect(forceAgain(["plan", "stories", "add-a-limit", "--force"], said)).toBeUndefined();
    handoffRefusal = said;
    const m = mount(HandoffStep as never, { args: ["plan", "stories", "add-a-limit"] } as never);
    (all(m.tree).find((e) => e.type === "button")!.props.onClick as () => void)();
    await tick();
    m.render();
    handoffRefusal = undefined;
    expect(text(m.tree)).toContain(COPY.app.forceStories("add-a-limit"));
    expect(text(m.tree)).not.toContain("--force");
    const again = all(m.tree).find((e) => e.type === HandoffStep)!;
    expect(again.props.args).toEqual(["plan", "stories", "add-a-limit", "--force"]);
    const n = mount(HandoffStep as never, again.props as never);
    expect(text(all(n.tree).find((e) => e.type === "button")!.props.children)).toBe(T.storiesAgain);
  });

  it("is a RunStep for the model and Copilot paths too", () => {
    expect(typeof RunStep).toBe("function");
  });
});

describe("an answer, applied and proposed from its question", () => {
  it("applies an answer to a read's question without reading the repo again", () => {
    expect(Q.applyRepoOf("atticus map forge-ledger")).toBe("forge-ledger");
    expect(Q.applyRepoOf("atticus verify forge-ledger --write")).toBe("forge-ledger");
    expect(Q.applyRepoOf("atticus change feature add-a-limit")).toBeUndefined();
  });

  it("keeps Propose on the question while its file isn't proposed, after Apply", () => {
    applyFirst = [];
    proposeFiles = [{ path: "questions/q-1.yaml", status: "M" }];
    const m = mount(
      Q.ApplyPending as never,
      {
        repo: "forge-ledger",
        file: "questions/q-1.yaml",
      } as never,
    );
    expect(text(m.tree)).toContain(COPY.questions.notProposed);
    expect(all(m.tree).find((e) => e.type === ApplyAndPropose)?.props).toEqual({
      scope: "answers",
    });
    proposeFiles = [{ path: "questions/q-1.yaml", status: "M", proposed: "PR 4" }];
    const n = mount(
      Q.ApplyPending as never,
      {
        repo: "forge-ledger",
        file: "questions/q-1.yaml",
      } as never,
    );
    expect(n.tree).toBeNull();
  });
});

describe("the step model in the app's words", () => {
  it("drops the commands from a reason the server wrote for the command line", () => {
    expect(
      S.inAppWords(
        "Blocked. Ask its owner (atticus finding c f-1 ask --asked-of <who>), or fill it in (atticus finding c f-1 edit-and-apply).",
      ),
    ).toBe("Blocked. Ask its owner, or fill it in.");
    expect(
      S.inAppWords(
        "Say which repo on the Git host is the metarepo: pass --repo, or set metarepo under adapters.gitHost.settings in runtime.yaml.",
      ),
    ).not.toContain("--repo");
  });

  it("sends a finding that holds the gate to the change's page", () => {
    const c = { id: "add-a-limit", title: "t", state: "design" };
    const ask = N.cockpitStep(c, {
      step: "finding",
      command: "atticus finding add-a-limit f-1 ask",
      why: "Ask its owner (atticus finding add-a-limit f-1 ask --asked-of <who>).",
    } as never);
    expect(ask.kind).toBe("gap");
    expect(ask.why).not.toMatch(/atticus/);
    const fix = N.cockpitStep(c, {
      step: "finding",
      command: "atticus finding add-a-limit f-1 edit-and-apply",
      why: "Fix it.",
    } as never);
    expect(fix.kind).toBe("findings");
  });

  it("points a stage that hasn't run to its own tab, not a terminal", () => {
    const step = N.stageStep(
      "feature",
      { id: "add-a-limit", title: "t", state: "design" },
      undefined,
      {
        id: "add-a-limit",
        stages: [{ stage: "feature", state: "done" }],
        reasons: [
          {
            code: "stage-not-done",
            message:
              "The architecture stage hasn't run yet: run atticus change architecture add-a-limit.",
          },
        ],
        nextStep: "architecture",
      } as never,
    );
    expect(step.link?.href).toBe("#/architecture?change=add-a-limit");
    expect(step.command).toBe("atticus change architecture add-a-limit");
    expect(step.why).not.toMatch(/run atticus/);
  });
});
