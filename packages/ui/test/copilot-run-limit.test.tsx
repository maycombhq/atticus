import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Api } from "@maycombhq/core";
import { all, mount, text } from "./support/hooks.js";

/**
 * Beta.27: what a person hit starting a Copilot run from Map › Trust in a Copilot-only metarepo.
 * The dialog asks for the model's limit when Atticus doesn't know it (filled with the last one
 * given on this machine), sends it with the start, says when the assistant files are out of date
 * and refuses to start while one is edited by hand; the strip and Problems say which repo the run
 * stopped on and what verify rejected. Rendered with the tiny hooks runtime, no DOM.
 */

vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
vi.mock("../src/api/client.js", async () => {
  const real = await vi.importActual<typeof import("../src/api/client.js")>("../src/api/client.js");
  return {
    ...real,
    api: async () => {
      throw new Error("no request in this test");
    },
    useLiveEvents: () => undefined,
  };
});

const { COPY } = await import("../src/copy.js");
const { ConfirmRun, limitOf, StoppedOn } = await import("../src/app/copilot-runs.js");
const { problemsOf, ProblemsList } = await import("../src/app/shell/BottomPanel.js");

const T = COPY.copilotRuns;
type Run = Api.CopilotRunViewT;
type El = { type: unknown; props: Record<string, unknown> };

// The dialog's effect puts focus back where it was: a stand-in for the page's document.
const g = globalThis as { document?: unknown };
const hadDocument = "document" in g;
beforeAll(() => {
  if (!hadDocument) g.document = { activeElement: null, getElementById: () => null };
});
afterAll(() => {
  if (!hadDocument) delete g.document;
});

const els = (t: unknown) => all(t) as El[];
const field = (t: unknown) => els(t).find((e) => e.props.id === "run-dialog-limit");
const yes = (t: unknown) => els(t).find((e) => text(e) === T.confirm.yes);

const started = (): Run => ({
  runId: "copilot-run-1",
  jobId: "job-1",
  kind: "repos",
  state: "running",
  startedAt: "2026-11-12T10:00:00.000Z",
  progress: { repos: 1, repoIndex: 0, sessions: 0 },
  totals: { kept: 0, rejected: 0, tokens: 0 },
  tabs: [],
});

describe("the limit the dialog asks for (beta.27)", () => {
  it("reads a number of tokens, with commas or spaces, 1,000 or more", () => {
    expect(limitOf("128000")).toBe(128000);
    expect(limitOf(" 128,000 ")).toBe(128000);
    expect(limitOf("200 000")).toBe(200000);
    expect(limitOf("")).toBeUndefined();
    expect(limitOf("128k")).toBeUndefined();
    expect(limitOf("999")).toBeUndefined();
    expect(limitOf("1.5")).toBeUndefined();
  });

  it("asks for it, filled with the last one given here, and sends it with the start", async () => {
    const sent: Api.StartCopilotRunRequestT[] = [];
    const m = mount(ConfirmRun, {
      ask: { kind: "repos", repos: ["forge-ledger"], force: true },
      model: "claude-sonnet-5",
      limit: { known: false, tokens: 128000, from: "last" },
      onClose: () => undefined,
      onStarted: () => undefined,
      start: async (a: Api.StartCopilotRunRequestT) => {
        sent.push(a);
        return started();
      },
    });
    const input = field(m.tree)!;
    expect(input).toBeDefined();
    expect(input.props.value).toBe("128000");
    expect(input.props.inputMode).toBe("numeric");
    const label = els(m.tree).find((e) => e.props.htmlFor === "run-dialog-limit")!;
    expect(text(label)).toBe(T.confirm.limit.label);
    expect(text(m.tree)).toContain(T.confirm.limit.last);
    expect(input.props["aria-describedby"]).toBe("run-dialog-limit-hint");
    // Changed, then Start: the run is asked for with the limit as --max-tokens.
    (input.props.onChange as (e: unknown) => void)({ target: { value: "200,000" } });
    m.render();
    await (yes(m.tree)!.props.onClick as () => Promise<void>)();
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual([
      { kind: "repos", repos: ["forge-ledger"], force: true, maxTokens: 200000 },
    ]);
  });

  it("says what is wrong with a limit it can't read, and starts nothing", async () => {
    const sent: unknown[] = [];
    const m = mount(ConfirmRun, {
      ask: { kind: "all" },
      limit: { known: false },
      onClose: () => undefined,
      onStarted: () => undefined,
      start: async (a: unknown) => {
        sent.push(a);
        return started();
      },
    });
    expect(field(m.tree)!.props.value).toBe("");
    (yes(m.tree)!.props.onClick as () => void)();
    await new Promise((r) => setTimeout(r, 0));
    m.render();
    expect(sent).toEqual([]);
    const alert = els(m.tree).find((e) => e.props.id === "run-dialog-limit-bad")!;
    expect(alert.props.role).toBe("alert");
    expect(text(alert)).toBe(T.confirm.limit.bad);
    expect(field(m.tree)!.props["aria-invalid"]).toBe(true);
    expect(field(m.tree)!.props["aria-describedby"]).toBe(
      "run-dialog-limit-hint run-dialog-limit-bad",
    );
  });

  it("asks nothing where the limit is known, and says it", async () => {
    const sent: Api.StartCopilotRunRequestT[] = [];
    const m = mount(ConfirmRun, {
      ask: { kind: "stale" },
      limit: { known: true, tokens: 64000, from: "runtime.yaml" },
      onClose: () => undefined,
      onStarted: () => undefined,
      start: async (a: Api.StartCopilotRunRequestT) => {
        sent.push(a);
        return started();
      },
    });
    expect(field(m.tree)).toBeUndefined();
    expect(text(m.tree)).toContain(T.confirm.limit.known(64000, "runtime.yaml"));
    await (yes(m.tree)!.props.onClick as () => Promise<void>)();
    expect(sent).toEqual([{ kind: "stale" }]);
  });
});

describe("the assistant files each session reads (beta.27)", () => {
  it("says the run writes them first when they are out of date", () => {
    const m = mount(ConfirmRun, {
      ask: { kind: "stale" },
      assistantFiles: { upToDate: false, stale: ["a", "b"], edited: [] },
      onClose: () => undefined,
      onStarted: () => undefined,
    });
    expect(text(m.tree)).toContain(T.confirm.files.stale(2));
    expect(yes(m.tree)!.props.disabled).toBe(false);
  });

  it("won't start while one is edited by hand, and says why and where it is put right", () => {
    const m = mount(ConfirmRun, {
      ask: { kind: "stale" },
      assistantFiles: {
        upToDate: false,
        stale: [],
        edited: [".github/prompts/atticus-map.prompt.md"],
      },
      onClose: () => undefined,
      onStarted: () => undefined,
    });
    const alert = els(m.tree).find((e) => e.props.role === "alert")!;
    expect(text(alert)).toContain(
      T.confirm.files.edited(".github/prompts/atticus-map.prompt.md", 1),
    );
    expect(text(alert)).toContain(T.confirm.files.editedHow);
    expect(yes(m.tree)!.props.disabled).toBe(true);
  });
});

describe("a repo the run stopped on (beta.27)", () => {
  const problems: NonNullable<Run["problems"]> = [
    {
      repo: "forge-ledger",
      part: 1,
      total: 6,
      message: "forge-ledger part 1 of 6: two Copilot sessions added nothing to it",
      rejected: [{ code: "claim-not-on-line", message: "e-get-account: line 3 doesn't say it" }],
      rejectedCount: 3,
    },
  ];

  it("is said on the strip with what verify rejected and why", () => {
    const m = mount(StoppedOn, { problems });
    const t = text(m.tree);
    expect(t).toContain(T.strip.stoppedOn(1));
    expect(t).toContain(T.strip.stoppedRepo("forge-ledger", 1, 6));
    expect(t).toContain(T.strip.rejected(3));
    expect(t).toContain("e-get-account: line 3 doesn't say it");
    expect(t).toContain(T.strip.moreRejected(2));
    expect(mount(StoppedOn, { problems: [] }).tree).toBeNull();
  });

  it("is a Problem, shown in the Console", () => {
    const p = problemsOf({ entries: [], copilot: { runId: "copilot-run-1", problems } });
    expect(p.stopped).toEqual([
      {
        runId: "copilot-run-1",
        repo: "forge-ledger",
        title: T.strip.stoppedRepo("forge-ledger", 1, 6),
        rejectedCount: 3,
      },
    ]);
    const shown: string[] = [];
    const m = mount(ProblemsList, {
      problems: p,
      findings: { state: "ready", data: [] },
      trust: { state: "ready", data: { repos: [] } },
      onShow: (id: string) => shown.push(id),
      onRetry: () => undefined,
    });
    const t = text(m.tree);
    expect(t).toContain(COPY.bottomPanel.problems.copilotStopped);
    expect(t).toContain(COPY.bottomPanel.problems.copilotStoppedMeta(3));
    const show = els(m.tree).find(
      (e) =>
        e.props["aria-label"] ===
        COPY.bottomPanel.problems.showLabel(T.strip.stoppedRepo("forge-ledger", 1, 6)),
    )!;
    (show.props.onClick as () => void)();
    expect(shown).toEqual(["copilot-run-1"]);
    expect(problemsOf({ entries: [] }).stopped).toEqual([]);
  });
});
