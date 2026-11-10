import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import {
  ActivityConsole,
  ActivityContext,
  ActivityStrip,
  ShowInConsole,
  titleOf,
  upsert,
  withActivityLines,
  type ActivityCtx,
} from "../src/app/activity.js";
import { RunsContext, type Ctx } from "../src/app/copilot-runs.js";

/**
 * ADR 0187: the Console. Everything Atticus is doing or did lately, wherever it was started,
 * with its lines; the strip says what runs. Rendered as markup at a given list.
 */

const T = COPY.activity;

const entry = (o: Partial<Api.ActivityEntryT> = {}): Api.ActivityEntryT => ({
  id: "job-1",
  kind: "scan",
  title: "Scan",
  where: "app",
  state: "running",
  startedAt: "2026-11-09T10:00:00.000Z",
  progress: { done: 1, total: 4, message: "forge-ledger" },
  lines: 2,
  from: 0,
  stop: "/api/jobs/job-1/cancel",
  jobId: "job-1",
  ...o,
});

const command = entry({
  id: "term-20261109-100500-42-ab12",
  kind: "command",
  title: "atticus map forge-ledger --handoff",
  where: "terminal",
  state: "running",
  startedAt: "2026-11-09T10:05:00.000Z",
  progress: undefined,
  stop: undefined,
  jobId: undefined,
  runId: "20261109-100500-42-ab12",
});
const handoff = entry({
  id: "run-abc1",
  kind: "handoff",
  title: "c1: critic",
  where: "assistant",
  state: "waiting",
  progress: undefined,
  stop: undefined,
  jobId: undefined,
  handoff: { runId: "run-abc1", change: "c1", promptPath: ".runs/c1/run-abc1/prompt.md" },
});

const ctx = (o: Partial<ActivityCtx> = {}): ActivityCtx => ({
  state: "ready",
  entries: [command, entry(), handoff],
  lines: {
    "job-1": {
      from: 0,
      lines: ["Scanning forge-ledger", "12 records"],
      startedAt: entry().startedAt,
    },
  },
  linesState: {},
  selected: "job-1",
  select: () => undefined,
  open: true,
  setOpen: () => undefined,
  show: () => undefined,
  stop: async () => undefined,
  reload: () => undefined,
  loadEarlier: () => undefined,
  said: "",
  ...o,
});

const unescape = (h: string) =>
  h
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
const html = (a: ActivityCtx, node: React.ReactNode, c?: Ctx) =>
  unescape(
    renderToStaticMarkup(
      <RunsContext.Provider value={c}>
        <ActivityContext.Provider value={a}>{node}</ActivityContext.Provider>
      </RunsContext.Provider>,
    ),
  );

describe("the Console", () => {
  it("is always there to open, and closed shows only its button", () => {
    const out = html(ctx({ open: false }), <ActivityConsole />);
    expect(out).toContain(T.open);
    expect(out).toContain('aria-expanded="false"');
    expect(out).not.toContain('role="log"');
    expect(html(ctx({ open: false, entries: [] }), <ActivityConsole />)).toContain(T.open);
  });

  it("lists what ran, newest first, with its kind, where it started, state and time", () => {
    const out = html(ctx(), <ActivityConsole />);
    expect(out).toContain('role="tablist"');
    expect(out).toContain('aria-orientation="vertical"');
    expect((out.match(/role="tab"/g) ?? []).length).toBe(3);
    expect(out).toContain("atticus map forge-ledger --handoff");
    expect(out).toContain(T.kinds.command);
    expect(out).toContain(T.from(T.where.terminal!));
    expect(out).toContain(T.from(T.where.assistant!));
    expect(out).toContain(T.states.waiting);
    expect(out).toContain(T.runningCount(2));
    // The one shown: its lines, Stop, and a polite announcement region, no focus moved.
    expect(out).toContain("Scanning forge-ledger\n12 records");
    expect(out).toContain('role="log"');
    expect(out).toContain('aria-live="polite"');
    expect(out).toContain(T.stop);
    expect(out).toContain(T.follow);
  });

  it("says a terminal's run stops in its terminal, and one gone without saying ended so", () => {
    const out = html(ctx({ selected: command.id }), <ActivityConsole />);
    expect(out).toContain(T.stopTerminal);
    const ended = { ...command, state: "ended" as const };
    expect(html(ctx({ entries: [ended], selected: ended.id }), <ActivityConsole />)).toContain(
      T.endedWithoutSaying,
    );
  });

  it("says a hand-off waits for the assistant", () => {
    expect(html(ctx({ selected: handoff.id }), <ActivityConsole />)).toContain(T.handoffWaits);
  });

  it("shows a Copilot run's own tabs inside it", () => {
    const run: Api.CopilotRunViewT = {
      runId: "copilot-run-1",
      jobId: "job-9",
      kind: "stale",
      state: "running",
      startedAt: "2026-11-09T11:00:00.000Z",
      progress: { repos: 1, repoIndex: 1, sessions: 1 },
      totals: { kept: 0, rejected: 0, tokens: 0 },
      tabs: [{ id: "run", title: "Run", state: "running", from: 0, lines: ["The estate"] }],
    };
    const c: Ctx = {
      run,
      allowed: true,
      ask: () => undefined,
      stop: async () => undefined,
      stopping: false,
      consoleOpen: true,
      setConsoleOpen: () => undefined,
      loadEarlier: () => undefined,
    };
    const e = entry({ id: run.runId, kind: "copilot", title: undefined, copilotRunId: run.runId });
    const out = html(ctx({ entries: [e], selected: e.id }), <ActivityConsole />, c);
    expect(out).toContain(T.kinds.copilot);
    expect(out).toContain("console-tab-run");
    expect(out).toContain("The estate");
  });

  it("has empty, loading and error states", () => {
    const empty = html(ctx({ entries: [] }), <ActivityConsole />);
    expect(empty).toContain(T.empty);
    expect(empty).toContain(T.emptyHint);
    expect(html(ctx({ entries: [], state: "loading" }), <ActivityConsole />)).toContain(T.loading);
    const err = html(ctx({ entries: [], state: "error", error: "offline" }), <ActivityConsole />);
    expect(err).toContain(T.failed("offline"));
    expect(err).toContain('role="alert"');
    expect(err).toContain(T.retry);
    // An entry's lines loading, or failing.
    expect(
      html(ctx({ lines: {}, linesState: { "job-1": "loading" } }), <ActivityConsole />),
    ).toContain(T.linesLoading);
    expect(
      html(ctx({ lines: {}, linesState: { "job-1": "error" } }), <ActivityConsole />),
    ).toContain(T.linesFailed);
  });
});

describe("the strip", () => {
  it("says what runs, how far, links to its Console entry and offers Stop", () => {
    const out = html(ctx(), <ActivityStrip />);
    expect(out).toContain(T.strip.running("atticus map forge-ledger --handoff"));
    expect(out).toContain(T.strip.more(1));
    expect(out).toContain(T.strip.show);
    expect(out).toContain(T.stopTerminal);
    const job = html(ctx({ entries: [entry()] }), <ActivityStrip />);
    expect(job).toContain('role="progressbar"');
    expect(job).toContain(T.strip.step(1, 4));
    expect(job).toContain(T.stop);
  });

  it("is gone when nothing runs", () => {
    expect(html(ctx({ entries: [handoff, entry({ state: "done" })] }), <ActivityStrip />)).toBe("");
  });
});

describe("the Console's lines", () => {
  const at = "2026-11-09T10:00:00.000Z";
  it("adds only the lines it doesn't have, waits past a gap, and puts earlier ones first", () => {
    const a = withActivityLines(undefined, 0, ["a", "b"], at);
    const b = withActivityLines(a, 1, ["b", "c"], at);
    expect(b).toEqual({ from: 0, lines: ["a", "b", "c"], startedAt: at });
    expect(withActivityLines(b, 9, ["z"], at)).toBe(b);
    const late = withActivityLines(undefined, 3, ["d"], at);
    expect(withActivityLines(late, 0, ["a", "b", "c", "d", "e"], at)).toMatchObject({
      from: 0,
      lines: ["a", "b", "c", "d", "e"],
    });
    // Another entry by the same id (a server's restart) starts again.
    expect(withActivityLines(b, 0, ["x"], "2026-11-10T00:00:00.000Z").lines).toEqual(["x"]);
  });

  it("takes the server's answer past a gap (lines it dropped), says so, and goes on", () => {
    const at = "2026-11-09T10:00:00.000Z";
    const held = withActivityLines(undefined, 0, ["a", "b", "c"], at);
    // Asked from line 3; the server kept lines from 9 on only.
    const next = withActivityLines(held, 9, ["j", "k"], at, { gap: true });
    expect(next).toEqual({ from: 9, lines: ["j", "k"], startedAt: at, dropped: 6 });
    // Then on from there as before.
    expect(withActivityLines(next, 11, ["l"], at)).toMatchObject({
      from: 9,
      lines: ["j", "k", "l"],
    });
    // A live event past a gap still waits for the fetch (the lines may be there).
    expect(withActivityLines(held, 9, ["j"], at)).toBe(held);
    // Said in the log, above the lines.
    const shown = { ...entry(), lines: 11, from: 9 };
    const out = html(
      ctx({ entries: [shown], selected: shown.id, lines: { [shown.id]: next } }),
      <ActivityConsole />,
    );
    expect(out).toContain(T.dropped(6));
  });

  it("keeps the list newest first, and names an entry by its kind when it has no title", () => {
    const l = upsert([entry()], command);
    expect(l.map((e) => e.id)).toEqual([command.id, "job-1"]);
    expect(upsert(l, entry({ state: "done" })).find((e) => e.id === "job-1")!.state).toBe("done");
    expect(titleOf(entry({ title: undefined, kind: "sync" }))).toBe(T.kinds.sync);
  });
});

describe("a screen's link to its job's Console entry", () => {
  it("shows where there is a Console and a job", () => {
    expect(html(ctx(), <ShowInConsole id="job-1" />)).toContain(T.strip.show);
    expect(html(ctx(), <ShowInConsole id={undefined} />)).toBe("");
    expect(renderToStaticMarkup(<ShowInConsole id="job-1" />)).toBe("");
  });
});
