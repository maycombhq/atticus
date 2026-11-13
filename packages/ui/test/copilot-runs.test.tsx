import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import {
  ConfirmRun,
  matching,
  CopilotRunTabs,
  RunsContext,
  RunStrip,
  RunWithCopilot,
  mergePolled,
  scrolledUp,
  TAB_LINES,
  withLines,
  withSpan,
  type Ctx,
} from "../src/app/copilot-runs.js";

/**
 * ADR 0173: an unattended Copilot run started from the app: the yes it asks for, the strip that
 * says how far it is, and the Console with a tab per session. Rendered as markup at given runs.
 */

const T = COPY.copilotRuns;

const run = (o: Partial<Api.CopilotRunViewT> = {}): Api.CopilotRunViewT => ({
  runId: "copilot-run-1",
  jobId: "job-1",
  kind: "stale",
  state: "running",
  startedAt: "2026-11-06T18:00:00.000Z",
  progress: {
    repos: 4,
    repoIndex: 2,
    repo: "forge-ledger",
    session: "forge-ledger, part 1 of 3",
    sessions: 2,
  },
  totals: { kept: 120, rejected: 2, tokens: 45000 },
  tabs: [
    { id: "run", title: "Run", state: "running", from: 0, lines: ["The estate at 100,000 tokens"] },
    {
      id: "s1",
      title: "forge-teller, one session",
      repo: "forge-teller",
      state: "ended",
      ended: "end_turn",
      from: 0,
      lines: ["  · Read TellerController.java", "forge-teller: 80 facts kept, 0 rejected"],
    },
    {
      id: "s2",
      title: "forge-ledger, part 1 of 3",
      repo: "forge-ledger",
      state: "running",
      from: 0,
      lines: ["  · Read AccountController.java"],
    },
  ],
  ...o,
});

const ctx = (o: Partial<Ctx> = {}): Ctx => ({
  run: run(),
  allowed: true,
  model: "claude-sonnet-5",
  ask: () => undefined,
  stop: async () => undefined,
  stopping: false,
  consoleOpen: true,
  setConsoleOpen: () => undefined,
  loadEarlier: () => undefined,
  ...o,
});

const unescape = (h: string) =>
  h
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
const html = (c: Ctx, node: React.ReactNode) =>
  unescape(renderToStaticMarkup(<RunsContext.Provider value={c}>{node}</RunsContext.Provider>));

describe("the Console's lines", () => {
  it("adds only the lines a tab doesn't have, and opens a tab it hears of first", () => {
    const r = run();
    const a = withLines(r, "s2", "forge-ledger, part 1 of 3", 0, [
      "  · Read AccountController.java",
      "  · Wrote facts/forge-ledger.jsonl",
    ]);
    expect(a.tabs[2]!.lines).toEqual([
      "  · Read AccountController.java",
      "  · Wrote facts/forge-ledger.jsonl",
    ]);
    const b = withLines(a, "s3", "forge-ledger, part 2 of 3", 0, ["  · Read Batch.java"]);
    expect(b.tabs.map((t) => t.id)).toEqual(["run", "s1", "s2", "s3"]);
    // Lines past a gap wait for the next poll rather than leave a hole.
    expect(withLines(b, "s3", "x", 5, ["late"])).toBe(b);
  });

  it("searches by every word, in any case", () => {
    const lines = ["forge-ledger: 12 facts kept", "  · Read Ledger.java", "forge-teller: 3 kept"];
    expect(matching(lines, "LEDGER kept")).toEqual(["forge-ledger: 12 facts kept"]);
    expect(matching(lines, "")).toEqual(lines);
  });
});

describe("a polled run", () => {
  const tab = (from: number, lines: string[]) => ({
    id: "s1",
    title: "forge-teller",
    state: "running" as const,
    from,
    lines,
  });
  it("keeps the lines it has and adds the new ones from a tail", () => {
    const old = run({ tabs: [tab(0, ["a", "b", "c"])] });
    const m = mergePolled(old, run({ tabs: [tab(1, ["b", "c", "d"])] }));
    expect(m.gaps).toEqual([]);
    expect(m.run?.tabs[0]).toMatchObject({ from: 0, lines: ["a", "b", "c", "d"] });
  });
  it("names a tab it is behind on, from the line it has, and keeps what it has", () => {
    const old = run({ tabs: [tab(0, ["a"])] });
    const m = mergePolled(old, run({ tabs: [tab(5, ["f"])] }));
    expect(m.gaps).toEqual([{ tab: "s1", from: 1 }]);
    expect(m.run?.tabs[0]).toMatchObject({ from: 0, lines: ["a"] });
    // The fetched span fills it in.
    const filled = withSpan(m.run!, "s1", 1, ["b", "c", "d", "e", "f"]);
    expect(filled.tabs[0]).toMatchObject({ from: 0, lines: ["a", "b", "c", "d", "e", "f"] });
  });
  it("starts a tab again when the lines it lacks are no longer kept", () => {
    const r = run({ tabs: [tab(0, ["a"])] });
    expect(withSpan(r, "s1", 6000, ["x", "y"]).tabs[0]).toMatchObject({
      from: 6000,
      lines: ["x", "y"],
    });
  });
  it("keeps a tab's last lines only, as the server does", () => {
    const many = Array.from({ length: TAB_LINES + 10 }, (_, i) => `l${i}`);
    const t = withLines(run({ tabs: [tab(0, [])] }), "s1", "forge-teller", 0, many).tabs[0]!;
    expect(t.lines.length).toBe(TAB_LINES);
    expect(t.from).toBe(10);
    expect(t.lines[0]).toBe("l10");
  });
  it("says earlier lines are no longer kept, with no button, once the server has none", () => {
    const r = run({ tabs: [{ ...tab(10, ["x"]), id: "run" }] });
    const out = html(ctx({ run: r, notKept: new Set([`${r.runId}:run`]) }), <CopilotRunTabs />);
    expect(unescape(out)).toContain(T.console.notKept(10));
    expect(out).not.toContain(T.console.loadEarlier);
  });
  it("takes another run whole", () => {
    const next = run({ runId: "copilot-run-2", tabs: [tab(3, ["x"])] });
    expect(mergePolled(run(), next)).toEqual({ run: next, gaps: [] });
  });
  it("puts earlier lines before the ones it has, keeping the newer ones", () => {
    const r = run({ tabs: [tab(3, ["d", "e"])] });
    expect(withSpan(r, "s1", 0, ["a", "b", "c", "d"]).tabs[0]).toMatchObject({
      from: 0,
      lines: ["a", "b", "c", "d", "e"],
    });
  });
});

describe("asking for a run", () => {
  it("shows the button only where the app can start Copilot", () => {
    const b = <RunWithCopilot ask={{ kind: "gaps" }} label={T.start.gaps} />;
    expect(renderToStaticMarkup(b)).toBe("");
    expect(html(ctx({ allowed: false }), b)).toBe("");
    expect(html(ctx({ run: null }), b)).toContain(T.start.gaps);
    // One run at a time: the button waits while one is under way.
    expect(html(ctx(), b)).toContain("disabled");
  });

  it("names what it reads, the model and what a session may do, in a labelled dialog", () => {
    const out = unescape(
      renderToStaticMarkup(
        <ConfirmRun
          ask={{ kind: "repos", repos: ["forge-ledger"], force: true }}
          model="claude-sonnet-5"
          onClose={() => undefined}
          onStarted={() => undefined}
        />,
      ),
    );
    expect(out).toContain('role="dialog"');
    expect(out).toContain('aria-modal="true"');
    expect(out).toContain('aria-labelledby="run-dialog-title"');
    expect(out).toContain(T.confirm.what.repos("forge-ledger", true));
    expect(out).toContain(T.confirm.model("claude-sonnet-5"));
    expect(out).toContain(T.confirm.may);
    expect(out).toContain(T.confirm.yes);
  });

  it("says which repos a stale run narrowed to some repos reads", () => {
    const out = unescape(
      renderToStaticMarkup(
        <ConfirmRun
          ask={{ kind: "stale", repos: ["forge-ledger", "forge-teller"] }}
          onClose={() => undefined}
          onStarted={() => undefined}
        />,
      ),
    );
    expect(out).toContain(T.confirm.what.staleRepos("forge-ledger, forge-teller"));
  });
});

describe("the strip and the Console", () => {
  it("says how far the run is, with the session and Stop", () => {
    const out = html(ctx({ consoleOpen: false }), <RunStrip />);
    expect(out).toContain(T.strip.repo(2, 4, "forge-ledger"));
    expect(out).toContain(T.strip.session("forge-ledger, part 1 of 3"));
    expect(out).toContain(T.strip.totals(120, 2, 45000));
    expect(out).toContain('role="progressbar"');
    expect(out).toContain(T.strip.stop);
    expect(out).toContain(T.strip.showConsole);
  });

  it("says how it ended, and says nothing of a run that ended before the page opened", () => {
    const done = run({ state: "done", finishedAt: "2026-11-06T19:00:00.000Z" });
    const seen = { watched: "copilot-run-1" };
    expect(html(ctx({ run: done, ...seen }), <RunStrip />)).toContain(T.strip.done);
    const failed = run({ state: "failed", finishedAt: "t", message: "sign in to Copilot" });
    expect(html(ctx({ run: failed, ...seen }), <RunStrip />)).toContain(
      T.strip.failed("sign in to Copilot"),
    );
    // Not seen under way by this page (opened or reloaded after it ended): nothing to say.
    expect(html(ctx({ run: done }), <RunStrip />)).toBe("");
    expect(html(ctx({ run: null }), <RunStrip />)).toBe("");
  });

  it("shows a tab per session, the newest while following, as a labelled tab list and log", () => {
    const out = html(ctx(), <CopilotRunTabs />);
    expect(out).toContain('role="tablist"');
    expect((out.match(/role="tab"/g) ?? []).length).toBe(3);
    expect(out).toContain("forge-teller, one session");
    expect(out).toContain('role="log"');
    expect(out).toContain(T.console.follow);
    expect(out).toContain(T.console.copy);
  });

  it("draws nothing without a run (the Console says what ran, ADR 0187)", () => {
    expect(html(ctx({ run: null }), <CopilotRunTabs />)).toBe("");
  });
});

describe("the Console's log scrolls (beta.28)", () => {
  // Field report: during a run the log box in the panel at the foot had no scrollbar, so the
  // earlier lines couldn't be reached and the run looked stuck.
  const css = readFileSync(new URL("../src/app/shell/bottom-panel.css", import.meta.url), "utf8");
  const rule = (sel: string) => {
    const at = css.indexOf(`${sel} {`);
    expect(at, sel).toBeGreaterThanOrEqual(0);
    return css.slice(at, css.indexOf("}", at));
  };

  it("bounds the log inside the panel, each box between them a flex column that can shrink", () => {
    const out = html(ctx(), <CopilotRunTabs />);
    expect(out).toMatch(/<div class="run-console-copilot">/);
    expect(out).toMatch(/role="tabpanel" id="run-console-log" class="run-console-panel"/);
    expect(out).toMatch(/<pre class="run-console-log" role="log"/);
    for (const sel of [
      ".bp-panel-console .run-console-copilot",
      ".bp-panel-console .run-console-panel",
    ]) {
      const r = rule(sel);
      expect(r).toMatch(/display: flex;/);
      expect(r).toMatch(/flex-direction: column;/);
      expect(r).toMatch(/flex: 1;/);
      expect(r).toMatch(/min-height: 0;/);
    }
    const log = rule(".bp-panel-console .run-console-log");
    expect(log).toMatch(/overflow-y: auto;/);
    expect(log).toMatch(/min-height: 3em;/);
  });

  it("stops following once the person scrolls up, not when lines are added or a search shrinks it", () => {
    const el = (scrollTop: number, scrollHeight = 1000, clientHeight = 200) => ({
      scrollTop,
      scrollHeight,
      clientHeight,
    });
    // Scrolled up from the end: stop following.
    expect(scrolledUp(800, el(500))).toBe(true);
    // At the end (Atticus put it there), or lines added below: still following.
    expect(scrolledUp(800, el(800))).toBe(false);
    expect(scrolledUp(800, el(800, 1400))).toBe(false);
    // A search left fewer lines: the box clamped to its new end, still the end.
    expect(scrolledUp(800, el(300, 500))).toBe(false);
  });
});
