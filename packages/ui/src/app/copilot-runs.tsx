import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { Api } from "@maycombhq/core";
import { api, ApiError, useLiveEvents } from "../api/client.js";
import { hostBridge } from "../api/bridge.js";
import { COPY } from "../copy.js";

/**
 * ADR 0173: an unattended Copilot run started from the app. One provider keeps the run under way
 * (from GET /api/copilot-runs/current, then its live events, polled while it runs in case the
 * events don't reach this page, as in a VS Code panel); a button anywhere asks for it, a dialog
 * gets the person's yes, a strip under the top bar shows how far it is, and the Console at the
 * foot shows its lines, one tab per session.
 */

const T = COPY.copilotRuns;

export type StartAsk = Api.StartCopilotRunRequestT;
type Run = Api.CopilotRunViewT;

export interface Ctx {
  run: Run | null;
  allowed: boolean;
  why?: string;
  model?: string;
  /** Opens the dialog; the run starts on its yes. */
  ask(a: StartAsk): void;
  stop(): Promise<void>;
  stopping: boolean;
  consoleOpen: boolean;
  setConsoleOpen(open: boolean): void;
  /** Fetches a tab's lines from its first kept line (the poll only brings its last ones). */
  loadEarlier(tab: string): void;
  /** The run this page saw under way: only its end is news on the strip. */
  watched?: string;
}

/** Exported for tests, which render the strip and Console at a given run. */
export const RunsContext = createContext<Ctx | undefined>(undefined);
export const useCopilotRuns = () => useContext(RunsContext);

/** The tab after new lines at `at`: only the lines it doesn't have yet. */
export function withLines(run: Run, tab: string, title: string, at: number, lines: string[]): Run {
  const tabs = run.tabs.map((t) => ({ ...t }));
  let t = tabs.find((x) => x.id === tab);
  if (!t) {
    t = { id: tab, title, state: "running", from: at, lines: [] };
    tabs.push(t);
  }
  const have = t.from + t.lines.length;
  if (at > have) {
    // Lines were missed (a reconnect): the next poll fills them in; keep what is in order.
    return run;
  }
  const fresh = lines.slice(have - at);
  if (fresh.length) t.lines = [...t.lines, ...fresh];
  return { ...run, tabs };
}

/**
 * A polled run (each tab's last lines only) into the one the page has. Another run replaces it;
 * the same run keeps the lines it has and adds the new ones. A tab the poll is ahead of (lines
 * missed between polls) is named in `gaps`, from the line it has, for the page to fetch.
 */
export function mergePolled(
  old: Run | null,
  polled: Run | null,
): { run: Run | null; gaps: { tab: string; from: number }[] } {
  if (!polled || !old || old.runId !== polled.runId) return { run: polled, gaps: [] };
  const gaps: { tab: string; from: number }[] = [];
  const tabs = polled.tabs.map((p) => {
    const t = old.tabs.find((x) => x.id === p.id);
    if (!t) return p;
    const have = t.from + t.lines.length;
    if (p.from > have) {
      gaps.push({ tab: p.id, from: have });
      return { ...p, from: t.from, lines: t.lines };
    }
    const fresh = p.lines.slice(have - p.from);
    return { ...p, from: t.from, lines: fresh.length ? [...t.lines, ...fresh] : t.lines };
  });
  return { run: { ...old, ...polled, tabs }, gaps };
}

/** A tab's lines from `from` on (the tabs route's answer) put in place of the ones it has. */
export function withSpan(run: Run, tab: string, from: number, lines: string[]): Run {
  return {
    ...run,
    tabs: run.tabs.map((t) => {
      if (t.id !== tab) return t;
      const have = t.from + t.lines.length;
      const end = from + lines.length;
      // The server no longer keeps the lines between (it keeps a tab's last ones): the span
      // starts the tab again, or the page would ask for the same gap on every poll.
      if (from > have) return { ...t, from, lines };
      if (end < t.from) return t;
      // The lines before `from` that the tab had, the span, then any it has past the span.
      const before = from > t.from ? t.lines.slice(0, from - t.from) : [];
      const after = have > end ? t.lines.slice(end - t.from) : [];
      return { ...t, from: Math.min(from, t.from), lines: [...before, ...lines, ...after] };
    }),
  };
}

export function CopilotRunsProvider({ children }: { children: ReactNode }) {
  const [run, setRun] = useState<Run | null>(null);
  const [allowed, setAllowed] = useState(false);
  const [why, setWhy] = useState<string | undefined>();
  const [model, setModel] = useState<string | undefined>();
  const [asking, setAsking] = useState<StartAsk | undefined>();
  const [stopping, setStopping] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const runNow = useRef<Run | null>(null);
  runNow.current = run;
  const [watched, setWatched] = useState<string | undefined>();
  const runningId = run?.state === "running" ? run.runId : undefined;
  useEffect(() => {
    if (runningId) setWatched(runningId);
  }, [runningId]);

  /** A tab's lines from a line on, fetched and put in place (catching up, or earlier lines). */
  const span = useCallback(async (runId: string, tab: string, from: number, quiet = false) => {
    try {
      const r = await api<{ from: number; lines: string[] }>(
        `/api/copilot-runs/${encodeURIComponent(runId)}/tabs/${encodeURIComponent(tab)}?from=${from}`,
        { quiet },
      );
      setRun((old) => (old && old.runId === runId ? withSpan(old, tab, r.from, r.lines) : old));
    } catch {
      // The run is gone (the server restarted): the next poll says so.
    }
  }, []);

  const refresh = useCallback(
    async (quiet = false) => {
      try {
        const c = await api<Api.CopilotRunCurrentT>("/api/copilot-runs/current", { quiet });
        // The gaps from the run as it is now; the state takes the merge at its own turn.
        const { gaps } = mergePolled(runNow.current, c.run);
        setRun((old) => mergePolled(old, c.run).run);
        if (c.run) for (const g of gaps) void span(c.run.runId, g.tab, g.from, true);
        setAllowed(c.allowed);
        setWhy(c.why);
        setModel(c.model);
      } catch {
        // An older server has no runs: the buttons stay hidden.
      }
    },
    [span],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const running = run?.state === "running";
  useEffect(() => {
    if (!running) {
      setStopping(false);
      return;
    }
    // When it ends, one more look: lines missed while it ran come back with it.
    const last = () => void refresh(true);
    // Polled as well as heard, so a page whose events don't come (a VS Code panel) still moves.
    const t = setInterval(() => void refresh(true), hostBridge() ? 1000 : 3000);
    return () => {
      clearInterval(t);
      last();
    };
  }, [running, refresh]);

  useLiveEvents((e) => {
    if (e.type === "copilot-run.state") {
      const s = e.run as Omit<Run, "tabs">;
      setRun((old) =>
        old && old.runId === s.runId
          ? { ...old, ...s }
          : { ...s, tabs: [{ id: "run", title: "Run", state: "running", from: 0, lines: [] }] },
      );
    } else if (e.type === "copilot-run.lines") {
      setRun((old) =>
        old && old.runId === e.runId
          ? withLines(
              old,
              String(e.tab),
              String(e.title),
              Number(e.at),
              (e.lines as string[]) ?? [],
            )
          : old,
      );
    }
  });

  const stop = useCallback(async () => {
    if (!run) return;
    setStopping(true);
    try {
      await api(`/api/copilot-runs/${encodeURIComponent(run.runId)}/stop`, { method: "POST" });
    } catch {
      setStopping(false);
    }
    void refresh();
  }, [run, refresh]);

  const value = useMemo<Ctx>(
    () => ({
      run,
      allowed,
      ...(why ? { why } : {}),
      ...(model ? { model } : {}),
      ask: setAsking,
      stop,
      stopping,
      consoleOpen,
      setConsoleOpen,
      loadEarlier: (tab: string) => {
        if (run) void span(run.runId, tab, 0);
      },
      ...(watched ? { watched } : {}),
    }),
    [run, allowed, why, model, stop, stopping, consoleOpen, span, watched],
  );
  return (
    <RunsContext.Provider value={value}>
      {children}
      {asking && (
        <ConfirmRun
          ask={asking}
          {...(model ? { model } : {})}
          onClose={() => setAsking(undefined)}
          onStarted={(r) => {
            setRun(r);
            setAsking(undefined);
            setConsoleOpen(true);
          }}
        />
      )}
    </RunsContext.Provider>
  );
}

/** The person's yes, with what the run reads, the model and what a session may do. */
export function ConfirmRun(p: {
  ask: StartAsk;
  model?: string;
  onClose(): void;
  onStarted(r: Run): void;
  start?: (a: StartAsk) => Promise<Run>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const yes = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    yes.current?.focus();
    return () => before?.focus?.();
  }, []);
  const named = (p.ask.repos ?? []).join(", ");
  // Stale or gaps narrowed to some repos says which.
  const what =
    p.ask.kind === "repos"
      ? T.confirm.what.repos(named, !!p.ask.force)
      : named && p.ask.kind === "stale"
        ? T.confirm.what.staleRepos(named)
        : named && p.ask.kind === "gaps"
          ? T.confirm.what.gapsRepos(named)
          : T.confirm.what[p.ask.kind];
  const go = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const r = p.start
        ? await p.start(p.ask)
        : await api<Run>("/api/copilot-runs", { method: "POST", body: p.ask });
      p.onStarted(r);
    } catch (e) {
      setError(
        e instanceof ApiError
          ? (e.problem.detail ?? e.message)
          : e instanceof Error
            ? e.message
            : String(e),
      );
      setBusy(false);
    }
  };
  // Esc closes; Tab stays inside the dialog.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !busy) {
      e.preventDefault();
      p.onClose();
    }
    if (e.key === "Tab" && box.current) {
      const f = [...box.current.querySelectorAll<HTMLElement>("button:not([disabled])")];
      if (!f.length) return;
      const first = f[0]!;
      const last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  return (
    <div className="run-dialog-back">
      <div
        ref={box}
        className="run-dialog panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="run-dialog-title"
        aria-describedby="run-dialog-what"
        onKeyDown={onKey}
      >
        <h2 id="run-dialog-title" className="h" style={{ marginTop: 0, fontSize: 16 }}>
          {T.confirm.title}
        </h2>
        <p id="run-dialog-what">{what}</p>
        <p className="work-say">{T.confirm.model(p.model)}</p>
        <p className="work-say">{T.confirm.may}</p>
        <p className="work-say">{T.confirm.long}</p>
        {error && (
          <p className="state error" role="alert">
            {T.failedToStart(error)}
          </p>
        )}
        <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={p.onClose} disabled={busy}>
            {T.confirm.no}
          </button>
          <button
            ref={yes}
            type="button"
            className="btn primary"
            onClick={() => void go()}
            disabled={busy}
            aria-busy={busy}
          >
            {busy ? T.starting : T.confirm.yes}
          </button>
        </div>
      </div>
    </div>
  );
}

/** A button that asks for a run; hidden where the app can't start Copilot, or no provider is. */
export function RunWithCopilot(p: { ask: StartAsk; label: string; className?: string }) {
  const c = useCopilotRuns();
  if (!c?.allowed) return null;
  const busy = c.run?.state === "running";
  return (
    <button
      type="button"
      className={p.className ?? "btn"}
      onClick={() => c.ask(p.ask)}
      disabled={busy}
      title={busy ? T.strip.running : T.hint}
    >
      {p.label}
    </button>
  );
}

/** How far the run is: under the top bar while it runs, and its end until dismissed. */
const DISMISSED = "atticus.copilotRun.dismissed";
const dismissedNow = (): string | undefined => {
  try {
    return sessionStorage.getItem(DISMISSED) ?? undefined;
  } catch {
    return undefined;
  }
};

export function RunStrip() {
  const c = useCopilotRuns();
  const [dismissed, setDismissedState] = useState<string | undefined>(dismissedNow);
  const setDismissed = (k: string) => {
    setDismissedState(k);
    try {
      sessionStorage.setItem(DISMISSED, k);
    } catch {
      // Kept for this page only.
    }
  };
  const run = c?.run;
  if (!c || !run || dismissed === `${run.runId}:${run.state}`) return null;
  // An ended run is news only to a page that saw it under way (not after a reload, or a day on).
  if (run.state !== "running" && c.watched !== run.runId) return null;
  const p = run.progress;
  const t = run.totals;
  const running = run.state === "running";
  const head = running
    ? p.repo
      ? T.strip.repo(p.repoIndex, p.repos, p.repo)
      : T.strip.planning
    : run.state === "done"
      ? T.strip.done
      : run.state === "stopped"
        ? T.strip.stopped
        : T.strip.failed(run.message ?? "");
  return (
    <section
      className={`run-strip ${running ? "" : run.state === "failed" ? "failed" : "ended"}`}
      aria-label={T.strip.running}
    >
      {running && (
        <div
          className="run-strip-bar"
          role="progressbar"
          aria-label={T.strip.running}
          aria-valuemin={0}
          aria-valuemax={Math.max(p.repos, 1)}
          aria-valuenow={Math.max(p.repoIndex - 1, 0)}
          aria-valuetext={head}
        >
          <span
            style={{ width: `${p.repos ? (Math.max(p.repoIndex - 1, 0) / p.repos) * 100 : 0}%` }}
          />
        </div>
      )}
      <div className="row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <strong role="status">{head}</strong>
        {running && p.session && <span className="work-say">{T.strip.session(p.session)}</span>}
        <span className="work-say">{T.strip.totals(t.kept, t.rejected, t.tokens)}</span>
        <span style={{ flex: 1 }} />
        {!c.consoleOpen && (
          <button type="button" className="btn" onClick={() => c.setConsoleOpen(true)}>
            {T.strip.showConsole}
          </button>
        )}
        {running ? (
          <button
            type="button"
            className="btn danger"
            onClick={() => void c.stop()}
            disabled={c.stopping}
          >
            {c.stopping ? T.strip.stopping : T.strip.stop}
          </button>
        ) : (
          <button
            type="button"
            className="btn"
            onClick={() => setDismissed(`${run.runId}:${run.state}`)}
          >
            {T.strip.dismiss}
          </button>
        )}
      </div>
    </section>
  );
}

/** The lines of a tab that have every word of the search. */
export function matching(lines: string[], q: string): string[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return lines;
  return lines.filter((l) => {
    const low = l.toLowerCase();
    return words.every((w) => low.includes(w));
  });
}

/** The collapsible Console at the foot of the app: the run's tab first, then one per session. */
export function RunConsole() {
  const c = useCopilotRuns();
  const [tab, setTab] = useState("run");
  const [follow, setFollow] = useState(true);
  const [q, setQ] = useState("");
  const [copied, setCopied] = useState(false);
  const log = useRef<HTMLPreElement>(null);
  const run = c?.run;
  const tabs = run?.tabs ?? [];
  const shown = tabs.find((t) => t.id === tab) ?? tabs[0];
  // A new session's tab is shown when it starts, while following.
  const last = tabs.at(-1)?.id;
  // Another run starts on its own Run tab, following, with no search.
  const runId = run?.runId;
  useEffect(() => {
    setTab("run");
    setFollow(true);
    setQ("");
  }, [runId]);
  useEffect(() => {
    if (follow && last) setTab(last);
  }, [last, follow]);
  const lines = useMemo(() => (shown ? matching(shown.lines, q) : []), [shown, q]);
  useEffect(() => {
    if (follow && log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [lines.length, follow, tab]);
  if (!c) return null;
  if (!run && !c.consoleOpen) return null;
  const onTabsKey = (e: KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.id === shown?.id);
    const to =
      e.key === "ArrowRight"
        ? tabs[(i + 1) % tabs.length]
        : e.key === "ArrowLeft"
          ? tabs[(i - 1 + tabs.length) % tabs.length]
          : e.key === "Home"
            ? tabs[0]
            : e.key === "End"
              ? tabs.at(-1)
              : undefined;
    if (!to) return;
    e.preventDefault();
    setFollow(false);
    setTab(to.id);
    document.getElementById(`console-tab-${to.id}`)?.focus();
  };
  return (
    <section className={`run-console ${c.consoleOpen ? "open" : ""}`} aria-label={T.console.title}>
      <div className="run-console-head row" style={{ gap: 8, alignItems: "center" }}>
        <button
          type="button"
          className="btn"
          aria-expanded={c.consoleOpen}
          aria-controls="run-console-body"
          onClick={() => c.setConsoleOpen(!c.consoleOpen)}
        >
          {c.consoleOpen ? T.console.close : T.console.open}
        </button>
        <strong>{T.console.title}</strong>
        {run && (
          <span className="work-say">
            {run.state === "running" ? T.strip.running : T.console.states.ended}
          </span>
        )}
      </div>
      {c.consoleOpen && (
        <div id="run-console-body" className="run-console-body">
          {!run ? (
            <p className="work-say">{T.console.empty}</p>
          ) : (
            <>
              <div
                role="tablist"
                aria-label={T.console.tabs}
                className="run-console-tabs"
                onKeyDown={onTabsKey}
              >
                {tabs.map((t) => (
                  <button
                    key={t.id}
                    id={`console-tab-${t.id}`}
                    type="button"
                    role="tab"
                    aria-selected={t.id === shown?.id}
                    aria-controls="run-console-log"
                    tabIndex={t.id === shown?.id ? 0 : -1}
                    className={`run-console-tab ${t.state}`}
                    onClick={() => {
                      setFollow(t.id === last);
                      setTab(t.id);
                    }}
                    title={t.ended ?? T.console.states[t.state]}
                  >
                    {t.title}
                    {t.id !== "run" && <span className="sr"> ({T.console.states[t.state]})</span>}
                  </button>
                ))}
              </div>
              <div className="row" style={{ gap: 8, alignItems: "center", margin: "6px 0" }}>
                <label className="row" style={{ gap: 4 }}>
                  <input
                    type="checkbox"
                    checked={follow}
                    onChange={(e) => setFollow(e.target.checked)}
                  />
                  {T.console.follow}
                </label>
                <label htmlFor="run-console-search" className="sr">
                  {T.console.search}
                </label>
                <input
                  id="run-console-search"
                  className="field"
                  type="search"
                  placeholder={T.console.search}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  style={{ height: 26, fontSize: 12 }}
                />
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    void navigator.clipboard
                      ?.writeText(lines.join("\n"))
                      .then(() => {
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                      })
                      .catch(() => undefined);
                  }}
                >
                  {copied ? T.console.copied : T.console.copy}
                </button>
              </div>
              <div
                role="tabpanel"
                id="run-console-log"
                aria-labelledby={`console-tab-${shown?.id ?? "run"}`}
              >
                {shown && shown.from > 0 && (
                  <p className="work-say row" style={{ gap: 8, alignItems: "center" }}>
                    {T.console.earlier(shown.from)}
                    <button type="button" className="btn" onClick={() => c.loadEarlier(shown.id)}>
                      {T.console.loadEarlier}
                    </button>
                  </p>
                )}
                <pre ref={log} className="run-console-log" role="log" aria-live="off" tabIndex={0}>
                  {lines.length ? lines.join("\n") : q ? T.console.noMatch(q) : T.console.noLines}
                </pre>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
