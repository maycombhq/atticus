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
type Limit = NonNullable<Api.CopilotRunCurrentT["limit"]>;
type Files = NonNullable<Api.CopilotRunCurrentT["assistantFiles"]>;

export interface Ctx {
  run: Run | null;
  allowed: boolean;
  why?: string;
  model?: string;
  /** Beta.27: the model's limit, known or to ask for; and whether the assistant files are current. */
  limit?: Limit;
  assistantFiles?: Files;
  /** Opens the dialog; the run starts on its yes. */
  ask(a: StartAsk): void;
  stop(): Promise<void>;
  stopping: boolean;
  consoleOpen: boolean;
  setConsoleOpen(open: boolean): void;
  /** Fetches a tab's lines from its first kept line (the poll only brings its last ones). */
  loadEarlier(tab: string): void;
  /** The tabs (`runId:tab`) whose earlier lines the server no longer keeps. */
  notKept?: ReadonlySet<string>;
  /** Why Stop didn't go through, when it didn't. */
  stopError?: string;
  /** The run this page saw under way: only its end is news on the strip. */
  watched?: string;
}

/** Exported for tests, which render the strip and Console at a given run. */
export const RunsContext = createContext<Ctx | undefined>(undefined);
export const useCopilotRuns = () => useContext(RunsContext);

/** As many lines of a tab as the server keeps (its last ones): the page holds no more. */
export const TAB_LINES = 5000;
const capped = <T extends { from: number; lines: string[] }>(t: T): T =>
  t.lines.length > TAB_LINES
    ? { ...t, from: t.from + t.lines.length - TAB_LINES, lines: t.lines.slice(-TAB_LINES) }
    : t;

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
  if (fresh.length) Object.assign(t, capped({ ...t, lines: [...t.lines, ...fresh] }));
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
    return capped({ ...p, from: t.from, lines: fresh.length ? [...t.lines, ...fresh] : t.lines });
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
      return capped({
        ...t,
        from: Math.min(from, t.from),
        lines: [...before, ...lines, ...after],
      });
    }),
  };
}

export function CopilotRunsProvider({ children }: { children: ReactNode }) {
  const [run, setRun] = useState<Run | null>(null);
  const [allowed, setAllowed] = useState(false);
  const [why, setWhy] = useState<string | undefined>();
  const [model, setModel] = useState<string | undefined>();
  const [limit, setLimit] = useState<Limit | undefined>();
  const [files, setFiles] = useState<Files | undefined>();
  const [asking, setAsking] = useState<StartAsk | undefined>();
  const [stopping, setStopping] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const runNow = useRef<Run | null>(null);
  runNow.current = run;
  const [watched, setWatched] = useState<string | undefined>();
  const runningId = run?.state === "running" ? run.runId : undefined;
  useEffect(() => {
    if (runningId) setWatched(runningId);
    // A run starting says nothing of an earlier one's Stop.
    setStopError(undefined);
  }, [runningId]);

  /** A tab's lines from a line on, fetched and put in place (catching up, or earlier lines). */
  const span = useCallback(
    async (
      runId: string,
      tab: string,
      from: number,
      quiet = false,
    ): Promise<number | undefined> => {
      try {
        const r = await api<{ from: number; lines: string[] }>(
          `/api/copilot-runs/${encodeURIComponent(runId)}/tabs/${encodeURIComponent(tab)}?from=${from}`,
          { quiet },
        );
        setRun((old) => (old && old.runId === runId ? withSpan(old, tab, r.from, r.lines) : old));
        return r.from;
      } catch {
        // The run is gone (the server restarted): the next poll says so.
        return undefined;
      }
    },
    [],
  );
  // The tabs whose earlier lines the server no longer keeps (asked for, none came): `run:tab`.
  const [notKept, setNotKept] = useState<ReadonlySet<string>>(new Set());
  const [stopError, setStopError] = useState<string | undefined>();

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
        setLimit(c.limit);
        setFiles(c.assistantFiles);
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
          : {
              ...s,
              tabs: [{ id: "run", title: T.console.runTab, state: "running", from: 0, lines: [] }],
            },
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
    setStopError(undefined);
    try {
      await api(`/api/copilot-runs/${encodeURIComponent(run.runId)}/stop`, { method: "POST" });
    } catch (e) {
      setStopping(false);
      setStopError(
        T.strip.stopFailed(
          e instanceof ApiError ? (e.problem.detail ?? e.message) : (e as Error).message,
        ),
      );
    }
    void refresh();
  }, [run, refresh]);

  const value = useMemo<Ctx>(
    () => ({
      run,
      allowed,
      ...(why ? { why } : {}),
      ...(model ? { model } : {}),
      ...(limit ? { limit } : {}),
      ...(files ? { assistantFiles: files } : {}),
      ask: (a: StartAsk) => {
        setAsking(a);
        // What the dialog says of the limit and the files is read again as it opens.
        void refresh(true);
      },
      stop,
      stopping,
      consoleOpen,
      setConsoleOpen,
      loadEarlier: (tab: string) => {
        if (!run) return;
        const had = run.tabs.find((t) => t.id === tab)?.from ?? 0;
        void span(run.runId, tab, 0).then((from) => {
          if (from !== undefined && from >= had)
            setNotKept((s) => new Set(s).add(`${run.runId}:${tab}`));
        });
      },
      notKept,
      ...(stopError ? { stopError } : {}),
      ...(watched ? { watched } : {}),
    }),
    [
      run,
      allowed,
      why,
      model,
      limit,
      files,
      refresh,
      stop,
      stopping,
      consoleOpen,
      span,
      watched,
      notKept,
      stopError,
    ],
  );
  return (
    <RunsContext.Provider value={value}>
      {children}
      {asking && (
        <ConfirmRun
          ask={asking}
          {...(model ? { model } : {})}
          {...(limit ? { limit } : {})}
          {...(files ? { assistantFiles: files } : {})}
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
/** Beta.27: the limit typed, as a number of tokens (digits, with commas or spaces between). */
export function limitOf(text: string): number | undefined {
  const t = text.trim().replace(/[\s,_]/g, "");
  if (!/^\d+$/.test(t)) return undefined;
  const n = Number(t);
  return Number.isSafeInteger(n) && n >= 1000 && n <= 10_000_000 ? n : undefined;
}

export function ConfirmRun(p: {
  ask: StartAsk;
  model?: string;
  /** Beta.27: not known here, the dialog asks for it, filled with what it was last time. */
  limit?: Limit;
  assistantFiles?: Files;
  onClose(): void;
  onStarted(r: Run): void;
  start?: (a: StartAsk) => Promise<Run>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const askLimit = p.limit?.known === false;
  const [tokens, setTokens] = useState(askLimit && p.limit?.tokens ? String(p.limit.tokens) : "");
  const [badLimit, setBadLimit] = useState(false);
  const edited = p.assistantFiles?.edited ?? [];
  const stale = p.assistantFiles?.stale ?? [];
  const shared = p.assistantFiles?.shared ?? [];
  // Start is off while an assistant file is edited by hand.
  const blocked = edited.length > 0;
  const yes = useRef<HTMLButtonElement>(null);
  const no = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    // Review of fix/b27-copilot (WCAG 2.4.3): never on a button that is off.
    (field.current ?? (blocked ? no.current : yes.current) ?? box.current)?.focus();
    // Back where it was; that button is off once a run is under way, so then the Console's.
    return () => {
      const back =
        before?.isConnected && !(before as HTMLButtonElement).disabled
          ? before
          : document.getElementById("run-console-toggle");
      back?.focus?.();
    };
  }, []);
  // Review of fix/b27-copilot: the limit asked for only once a refresh says it isn't known is
  // filled with the value to offer, and takes the focus.
  const asked = useRef(askLimit);
  useEffect(() => {
    if (askLimit && !asked.current) {
      if (!tokens && p.limit?.tokens) setTokens(String(p.limit.tokens));
      field.current?.focus();
    }
    asked.current = askLimit;
  }, [askLimit]);
  // A refresh that turns Start off under the focus (it goes to the page): Not now takes it.
  useEffect(() => {
    if (!blocked) return;
    const at = document.activeElement;
    if (!at || at === yes.current || at === document.body) no.current?.focus();
  }, [blocked]);
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
    if (edited.length) return;
    const maxTokens = askLimit ? limitOf(tokens) : undefined;
    if (askLimit && maxTokens === undefined) {
      setBadLimit(true);
      field.current?.focus();
      return;
    }
    setBadLimit(false);
    // Both buttons are off while it starts: the dialog holds the focus meanwhile.
    box.current?.focus();
    setBusy(true);
    setError(undefined);
    const ask: StartAsk = maxTokens !== undefined ? { ...p.ask, maxTokens } : p.ask;
    try {
      const r = p.start
        ? await p.start(ask)
        : await api<Run>("/api/copilot-runs", { method: "POST", body: ask });
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
      const f = [
        ...box.current.querySelectorAll<HTMLElement>(
          "input:not([disabled]), button:not([disabled])",
        ),
      ];
      // Nothing to move to while it starts: the focus stays on the dialog.
      if (!f.length) {
        e.preventDefault();
        return;
      }
      const first = f[0]!;
      const last = f[f.length - 1]!;
      // On the dialog itself (while it started, or Start turned off): into it, either way.
      if (document.activeElement === box.current) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && document.activeElement === first) {
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
        id="run-dialog"
        tabIndex={-1}
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
        {p.limit?.known && p.limit.tokens && p.limit.from !== "last" && (
          <p className="work-say">
            {T.confirm.limit.known(p.limit.tokens, p.limit.from ?? "runtime.yaml")}
          </p>
        )}
        {askLimit && (
          <div className="field">
            <label htmlFor="run-dialog-limit">{T.confirm.limit.label}</label>
            <input
              ref={field}
              id="run-dialog-limit"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={tokens}
              disabled={busy}
              aria-invalid={badLimit}
              aria-describedby={`run-dialog-limit-hint${badLimit ? " run-dialog-limit-bad" : ""}`}
              onChange={(e) => {
                setTokens(e.target.value);
                if (badLimit) setBadLimit(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void go();
                }
              }}
            />
            <p id="run-dialog-limit-hint" className="work-say">
              {T.confirm.limit.hint}
              {p.limit?.tokens && p.limit.from === "last" ? ` ${T.confirm.limit.last}` : ""}
              {p.limit?.tokens && p.limit.from === "probe" ? ` ${T.confirm.limit.probe}` : ""}
            </p>
            {badLimit && (
              <p id="run-dialog-limit-bad" className="state error" role="alert">
                {T.confirm.limit.bad}
              </p>
            )}
          </div>
        )}
        <p className="work-say">{T.confirm.may}</p>
        <p className="work-say">{T.confirm.long}</p>
        {edited.length > 0 ? (
          <div role="alert" className="state error">
            <p>{T.confirm.files.edited(edited.slice(0, 3).join(", "), edited.length)}</p>
            <details>
              <summary>{COPY.appStep.inTerminal}</summary>
              <p>{T.confirm.files.editedHow}</p>
            </details>
          </div>
        ) : (
          stale.length > 0 && (
            <>
              <p className="work-say">{T.confirm.files.stale(stale.length)}</p>
              {/* Review of fix/b27-copilot: a file of yours it adds to is named, not counted. */}
              {shared.length > 0 && (
                <p className="work-say">{T.confirm.files.shared(shared.join(", "))}</p>
              )}
            </>
          )
        )}
        {error && (
          <p className="state error" role="alert">
            {T.failedToStart(error)}
          </p>
        )}
        <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
          <button
            ref={no}
            id="run-dialog-no"
            type="button"
            className="btn"
            onClick={p.onClose}
            disabled={busy}
          >
            {T.confirm.no}
          </button>
          <button
            ref={yes}
            id="run-dialog-yes"
            type="button"
            className="btn primary"
            onClick={() => void go()}
            disabled={busy || edited.length > 0}
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
      {running && c.stopError && (
        <p role="alert" className="state error">
          {c.stopError}
        </p>
      )}
      <StoppedOn problems={run.problems ?? []} />
    </section>
  );
}

/** Beta.27: the repos the run stopped on, each with what verify rejected and why. */
export function StoppedOn({ problems }: { problems: NonNullable<Run["problems"]> }) {
  if (!problems.length) return null;
  return (
    <div className="run-strip-problems" role="status">
      <p className="work-say">{T.strip.stoppedOn(problems.length)}</p>
      <ul>
        {problems.map((x) => (
          <li key={`${x.repo}:${x.part ?? 0}`}>
            <strong>{T.strip.stoppedRepo(x.repo, x.part, x.total)}</strong>{" "}
            {x.rejectedCount ? T.strip.rejected(x.rejectedCount) : T.strip.noRejected}
            {x.rejected.length > 0 && (
              <ul>
                {x.rejected.map((r, i) => (
                  <li key={i}>
                    <code>{r.code}</code> {r.message}
                  </li>
                ))}
                {x.rejectedCount > x.rejected.length && (
                  <li>{T.strip.moreRejected(x.rejectedCount - x.rejected.length)}</li>
                )}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
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

/** What a log box's scroll is: where it is, how tall its lines are and how much shows. */
export interface LogScroll {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * beta.28: whether the person scrolled a log up from where it was (`before`), away from its end:
 * then it stops following the end. Lines added below, or a search that leaves fewer (the box
 * clamped to its new end), are not a scroll up.
 */
export function scrolledUp(before: number, el: LogScroll): boolean {
  const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
  return el.scrollTop < before - 1 && !atEnd;
}

/**
 * A Copilot run's tabs in the Console (ADR 0173, inside ADR 0187's Console): the run's tab first,
 * then one per session, following the newest unless the person picks one.
 */
export function CopilotRunTabs() {
  const c = useCopilotRuns();
  const [tab, setTab] = useState("run");
  const [follow, setFollow] = useState(true);
  const [q, setQ] = useState("");
  const [copied, setCopied] = useState<"yes" | "failed" | undefined>();
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);
  const saidCopied = (v: "yes" | "failed") => {
    setCopied(v);
    clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(undefined), 2000);
  };
  const log = useRef<HTMLPreElement>(null);
  const top = useRef(0);
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
    if (follow && log.current) {
      log.current.scrollTop = log.current.scrollHeight;
      top.current = log.current.scrollTop;
    }
  }, [lines.length, follow, tab]);
  if (!c || !run) return null;
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
    <div className="run-console-copilot">
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
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
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
            if (!navigator.clipboard) return saidCopied("failed");
            void navigator.clipboard.writeText(lines.join("\n")).then(
              () => saidCopied("yes"),
              () => saidCopied("failed"),
            );
          }}
        >
          {copied === "yes"
            ? T.console.copied
            : copied === "failed"
              ? T.console.copyFailed
              : T.console.copy}
        </button>
        <span role="status" className="sr">
          {copied === "yes" ? T.console.copied : copied === "failed" ? T.console.copyFailed : ""}
        </span>
      </div>
      <div
        role="tabpanel"
        id="run-console-log"
        className="run-console-panel"
        aria-labelledby={`console-tab-${shown?.id ?? "run"}`}
      >
        {shown && shown.from > 0 && (
          <p className="work-say row" style={{ gap: 8, alignItems: "center" }}>
            {c.notKept?.has(`${run.runId}:${shown.id}`) ? (
              T.console.notKept(shown.from)
            ) : (
              <>
                {T.console.earlier(shown.from)}
                <button type="button" className="btn" onClick={() => c.loadEarlier(shown.id)}>
                  {T.console.loadEarlier}
                </button>
              </>
            )}
          </p>
        )}
        <pre
          ref={log}
          className="run-console-log"
          role="log"
          aria-live="off"
          tabIndex={0}
          onScroll={(e) => {
            // beta.28: scrolling up to read earlier lines stops following the end.
            if (follow && scrolledUp(top.current, e.currentTarget)) setFollow(false);
            top.current = e.currentTarget.scrollTop;
          }}
        >
          {lines.length ? lines.join("\n") : q ? T.console.noMatch(q) : T.console.noLines}
        </pre>
      </div>
    </div>
  );
}
