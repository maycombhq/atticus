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
import { CopilotRunTabs, matching, RunStrip, TAB_LINES, useCopilotRuns } from "./copilot-runs.js";

/**
 * ADR 0187: the Console. Everything Atticus is doing or did lately on this metarepo, wherever it
 * was started (this app, a terminal, VS Code, IntelliJ, a Copilot session, the person's
 * assistant), newest first, with what each printed. One provider keeps the list (GET
 * /api/activity, then its live events, polled as well, since a VS Code panel gets no events) and
 * the lines of the entry shown; the strip under the top bar says what runs; the Console at the
 * foot is always there to open. A Copilot run keeps its own tabs (ADR 0173) inside it.
 */

const T = COPY.activity;

type Entry = Api.ActivityEntryT;
export interface Lines {
  from: number;
  lines: string[];
  /**
   * The entry's start, so a server's restart (job-1 again) never mixes two entries, with the
   * version of its lines when it has one (linesKey).
   */
  startedAt: string;
  /** Lines the server no longer had, between what was held and these (its log kept its last). */
  dropped?: number;
}

export interface ActivityCtx {
  state: "loading" | "ready" | "error";
  error?: string;
  entries: Entry[];
  lines: Record<string, Lines>;
  linesState: Record<string, "loading" | "error" | undefined>;
  selected?: string;
  /** The person picked it (a new run doesn't take the Console from it). */
  select(id: string, picked?: boolean): void;
  open: boolean;
  setOpen(open: boolean): void;
  /** Open the Console at an entry (a job a screen started). */
  show(id: string): void;
  stop(e: Entry): Promise<void>;
  stopping?: string;
  stopError?: string;
  reload(): void;
  loadEarlier(id: string): void;
  /** What a screen reader hears, politely: new lines, an end. */
  said: string;
}

export const ActivityContext = createContext<ActivityCtx | undefined>(undefined);
export const useActivity = () => useContext(ActivityContext);

/** The name of an entry: its own words, else its kind's. */
export const titleOf = (e: Entry): string => e.title ?? T.kinds[e.kind] ?? e.kind;

/** The list with one entry put in (new or changed), newest first. */
export function upsert(entries: Entry[], e: Entry): Entry[] {
  const rest = entries.filter((x) => x.id !== e.id);
  return [e, ...rest].sort(
    (a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id),
  );
}

const cap = (l: Lines): Lines =>
  l.lines.length > TAB_LINES
    ? { ...l, from: l.from + l.lines.length - TAB_LINES, lines: l.lines.slice(-TAB_LINES) }
    : l;

/**
 * New lines at `at` put after the ones held: only those not held yet; lines before the held
 * ones are put in front. A gap in a live event (lines missed) is left for the next fetch; a gap
 * in a fetch's answer (`gap`: the server answered from a later line than asked, as it dropped
 * the ones between) is taken: its lines are held from there on, saying how many were dropped.
 */
export function withActivityLines(
  have: Lines | undefined,
  at: number,
  lines: string[],
  startedAt: string,
  o: { gap?: boolean } = {},
): Lines {
  if (!have || have.startedAt !== startedAt) return cap({ from: at, lines, startedAt });
  const end = have.from + have.lines.length;
  if (at > end) {
    if (!o.gap) return have;
    return cap({ from: at, lines, startedAt, dropped: at - end });
  }
  if (at < have.from) {
    const before = lines.slice(0, have.from - at);
    const after = lines.slice(have.from - at + have.lines.length);
    return cap({ ...have, from: at, lines: [...before, ...have.lines, ...after] });
  }
  const fresh = lines.slice(end - at);
  return fresh.length ? cap({ ...have, lines: [...have.lines, ...fresh] }) : have;
}

/**
 * What the lines held of an entry are kept under: its start (a server's restart, job-1 again,
 * never mixes two entries) and, review of beta.23, the version of its lines (`rev`): a hand-off
 * run's are rewritten once Done ran, so lines held of the old version go rather than being
 * added to (the entry said "Waiting for your assistant" after Done).
 */
export const linesKey = (e: Pick<Entry, "startedAt" | "rev">): string =>
  e.rev ? `${e.startedAt}#${e.rev}` : e.startedAt;

/**
 * How often the Console's list is asked for. Review of beta.23: a page no one sees (a panel in a
 * background tab, a window minimised) asks seldom, as each ask in an editor panel goes through
 * the extension, and it reads at once when shown again.
 */
export function activityPollMs(o: {
  running: boolean;
  open: boolean;
  bridge: boolean;
  hidden: boolean;
}): number {
  if (o.hidden) return 60_000;
  return o.running || o.open ? (o.bridge ? 1500 : 3000) : o.bridge ? 5000 : 15000;
}

/** Whether the page is hidden now (document.visibilityState), heard as it changes. */
function usePageHidden(): boolean {
  const [hidden, setHidden] = useState(() => pageHidden());
  useEffect(() => {
    if (typeof document === "undefined" || typeof document.addEventListener !== "function") return;
    const f = () => setHidden(pageHidden());
    document.addEventListener("visibilitychange", f);
    return () => document.removeEventListener("visibilitychange", f);
  }, []);
  return hidden;
}
const pageHidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

/** A Copilot run the page knows of, as an entry, when the list hasn't brought it yet. */
function copilotEntry(run: Api.CopilotRunViewT): Entry {
  return {
    id: run.runId,
    kind: "copilot",
    where: "app",
    state:
      run.state === "running"
        ? "running"
        : run.state === "stopped"
          ? "cancelled"
          : run.state === "failed"
            ? "failed"
            : "done",
    startedAt: run.startedAt,
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    lines: 0,
    from: 0,
    copilotRunId: run.runId,
    jobId: run.jobId,
  };
}

const errText = (e: unknown) =>
  e instanceof ApiError
    ? (e.problem.detail ?? e.message)
    : e instanceof Error
      ? e.message
      : String(e);

export function ActivityProvider({ children }: { children: ReactNode }) {
  const copilot = useCopilotRuns();
  const [state, setState] = useState<ActivityCtx["state"]>("loading");
  const [error, setError] = useState<string | undefined>();
  const [listed, setListed] = useState<Entry[]>([]);
  const [lines, setLines] = useState<Record<string, Lines>>({});
  const [linesState, setLinesState] = useState<ActivityCtx["linesState"]>({});
  const [selected, setSelected] = useState<string | undefined>();
  const picked = useRef(false);
  const [ownOpen, setOwnOpen] = useState(false);
  const open = copilot ? copilot.consoleOpen : ownOpen;
  const setOpen = copilot ? copilot.setConsoleOpen : setOwnOpen;
  const [stopping, setStopping] = useState<string | undefined>();
  const [stopError, setStopError] = useState<string | undefined>();
  const [said, setSaid] = useState("");
  const lastSaid = useRef(0);

  // The Copilot run the page knows of is in the list, whatever the list says yet.
  const run = copilot?.run;
  const entries = useMemo(() => {
    if (!run) return listed;
    const known = listed.find((e) => e.id === run.runId);
    const mine = copilotEntry(run);
    return upsert(listed, known ? { ...known, state: mine.state } : mine);
  }, [listed, run]);
  const entriesNow = useRef(entries);
  entriesNow.current = entries;
  const linesNow = useRef(lines);
  linesNow.current = lines;

  const refresh = useCallback(async () => {
    try {
      const l = await api<Api.ActivityListT>("/api/activity", { quiet: true });
      setListed(l.entries);
      setState("ready");
      setError(undefined);
    } catch (e) {
      // An older server has no Console list: said once, the Console stays usable for Copilot.
      setState((s) => (s === "ready" ? s : "error"));
      setError(errText(e));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Polled as well as heard: a VS Code panel gets no live events, and a missed one is caught.
  const running = entries.some((e) => e.state === "running");
  const hidden = usePageHidden();
  useEffect(() => {
    const ms = activityPollMs({ running, open, bridge: !!hostBridge(), hidden });
    const t = setInterval(() => void refresh(), ms);
    return () => clearInterval(t);
  }, [running, open, hidden, refresh]);
  // Shown again: read at once rather than at the slow pace's next tick.
  const wasHidden = useRef(hidden);
  useEffect(() => {
    if (wasHidden.current && !hidden) void refresh();
    wasHidden.current = hidden;
  }, [hidden, refresh]);

  const soon = useRef<ReturnType<typeof setTimeout>>(undefined);
  const refreshSoon = useCallback(() => {
    clearTimeout(soon.current);
    soon.current = setTimeout(() => void refresh(), 300);
  }, [refresh]);
  useEffect(() => () => clearTimeout(soon.current), []);

  const announce = useCallback((text: string, force = false) => {
    const now = Date.now();
    if (!force && now - lastSaid.current < 10_000) return;
    lastSaid.current = now;
    setSaid(text);
  }, []);

  useLiveEvents((e) => {
    if (e.type === "activity.changed") {
      const entry = e.entry as Entry;
      const was = entriesNow.current.find((x) => x.id === entry.id);
      if (was && was.state === "running" && entry.state !== "running")
        announce(T.changed(titleOf(entry), T.states[entry.state] ?? entry.state), true);
      setListed((old) => upsert(old, entry));
      setState("ready");
    } else if (e.type === "activity.lines") {
      const id = String(e.id);
      const entry = entriesNow.current.find((x) => x.id === id);
      const got = (e.lines as string[]) ?? [];
      // Only an entry whose lines the page holds: the others are fetched when shown.
      if (entry && linesNow.current[id]) {
        setLines((old) => ({
          ...old,
          [id]: withActivityLines(old[id], Number(e.at), got, linesKey(entry)),
        }));
        if (id === selected && open) announce(T.newLines(got.length, titleOf(entry)));
      }
    } else if (
      e.type === "job.done" ||
      e.type === "run.changed" ||
      (e.type === "job.progress" && !entriesNow.current.some((x) => x.id === e.jobId))
    ) {
      refreshSoon();
    }
  });

  // What is shown: the one picked, else the newest running, else the newest.
  useEffect(() => {
    if (picked.current && selected && entries.some((e) => e.id === selected)) return;
    const next = entries.find((e) => e.state === "running") ?? entries[0];
    if (next && next.id !== selected) setSelected(next.id);
  }, [entries, selected]);
  // A Copilot run that starts is shown, as before the Console listed everything.
  const runningCopilot = run?.state === "running" ? run.runId : undefined;
  useEffect(() => {
    if (runningCopilot) {
      picked.current = false;
      setSelected(runningCopilot);
    }
  }, [runningCopilot]);

  // The lines of the entry shown, while the Console is open: what it hasn't got yet.
  const shown = entries.find((e) => e.id === selected);
  const shownId = shown?.id;
  const shownKind = shown?.kind;
  const shownTotal = shown?.lines ?? 0;
  const shownStart = shown ? linesKey(shown) : undefined;
  // Where the lines held end: an answer short of the total (past a read's cap) asks on.
  const heldLines = shownId ? lines[shownId] : undefined;
  const heldEnd =
    heldLines && heldLines.startedAt === shownStart
      ? heldLines.from + heldLines.lines.length
      : undefined;
  useEffect(() => {
    if (!open || !shownId || !shownStart || shownKind === "copilot") return;
    const have = linesNow.current[shownId];
    const valid = have && have.startedAt === shownStart ? have : undefined;
    const end = valid ? valid.from + valid.lines.length : undefined;
    if (valid && end !== undefined && end >= shownTotal) return;
    let gone = false;
    if (!valid) setLinesState((s) => ({ ...s, [shownId]: "loading" }));
    api<Api.ActivityLinesT>(
      `/api/activity/${encodeURIComponent(shownId)}/lines${end !== undefined ? `?from=${end}` : ""}`,
      { quiet: true },
    ).then(
      (l) => {
        if (gone) return;
        // The server answers from the first line it still has: an answer from a later line
        // than asked is lines it dropped, taken as a gap (else the log froze, asking again).
        setLines((old) => ({
          ...old,
          [shownId]: withActivityLines(
            old[shownId]?.startedAt === shownStart ? old[shownId] : undefined,
            l.from,
            l.lines,
            shownStart,
            { gap: true },
          ),
        }));
        setLinesState((s) => ({ ...s, [shownId]: undefined }));
      },
      () => {
        if (gone) return;
        if (!valid) setLinesState((s) => ({ ...s, [shownId]: "error" }));
      },
    );
    return () => {
      gone = true;
    };
  }, [open, shownId, shownKind, shownTotal, shownStart, heldEnd]);

  const stop = useCallback(
    async (e: Entry) => {
      if (!e.stop) return;
      setStopping(e.id);
      setStopError(undefined);
      try {
        await api(e.stop, { method: "POST" });
      } catch (x) {
        setStopError(T.stopFailed(errText(x)));
      }
      setStopping(undefined);
      void refresh();
    },
    [refresh],
  );

  const loadEarlier = useCallback((id: string) => {
    const e = entriesNow.current.find((x) => x.id === id);
    if (!e) return;
    void api<Api.ActivityLinesT>(`/api/activity/${encodeURIComponent(id)}/lines?from=0`, {
      quiet: true,
    }).then(
      (l) =>
        setLines((old) => ({
          ...old,
          [id]: withActivityLines(old[id], l.from, l.lines, linesKey(e)),
        })),
      () => undefined,
    );
  }, []);

  const value = useMemo<ActivityCtx>(
    () => ({
      state,
      ...(error ? { error } : {}),
      entries,
      lines,
      linesState,
      ...(selected ? { selected } : {}),
      select: (id, p = true) => {
        picked.current = p;
        setSelected(id);
      },
      open,
      setOpen,
      show: (id) => {
        picked.current = true;
        setSelected(id);
        setOpen(true);
        refreshSoon();
      },
      stop,
      ...(stopping ? { stopping } : {}),
      ...(stopError ? { stopError } : {}),
      reload: () => {
        setState("loading");
        void refresh();
      },
      loadEarlier,
      said,
    }),
    [
      state,
      error,
      entries,
      lines,
      linesState,
      selected,
      open,
      setOpen,
      refreshSoon,
      stop,
      stopping,
      stopError,
      refresh,
      loadEarlier,
      said,
    ],
  );
  return <ActivityContext.Provider value={value}>{children}</ActivityContext.Provider>;
}

const timeOf = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
};

/**
 * Under the top bar while anything runs: a Copilot run's own strip (ADR 0173), and what else
 * runs, how far, a link to its Console entry and Stop where the app can stop it.
 */
export function ActivityStrip() {
  const a = useActivity();
  const copilot = useCopilotRuns();
  const others = (a?.entries ?? []).filter((e) => e.state === "running" && e.kind !== "copilot");
  const first = others[0];
  return (
    <>
      {copilot && <RunStrip />}
      {a && first && (
        <section className="run-strip activity-strip" aria-label={T.strip.label}>
          {first.progress && first.progress.total > 0 && (
            <div
              className="run-strip-bar"
              role="progressbar"
              aria-label={titleOf(first)}
              aria-valuemin={0}
              aria-valuemax={first.progress.total}
              aria-valuenow={first.progress.done}
              aria-valuetext={first.progress.message}
            >
              <span style={{ width: `${(first.progress.done / first.progress.total) * 100}%` }} />
            </div>
          )}
          <div className="row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <strong>{T.strip.running(titleOf(first))}</strong>
            <span className="work-say">
              {T.from(T.where[first.where] ?? first.where)}
              {first.progress?.message && first.progress.message !== "Starting"
                ? ` · ${first.progress.message}`
                : ""}
              {first.progress && first.progress.total > 1
                ? ` · ${T.strip.step(first.progress.done, first.progress.total)}`
                : ""}
            </span>
            {others.length > 1 && (
              <span className="work-say">{T.strip.more(others.length - 1)}</span>
            )}
            <span style={{ flex: 1 }} />
            <button
              type="button"
              className="btn"
              onClick={() => {
                a.select(first.id);
                a.setOpen(true);
              }}
            >
              {T.strip.show}
            </button>
            {first.stop ? (
              <button
                type="button"
                className="btn danger"
                onClick={() => void a.stop(first)}
                disabled={a.stopping === first.id}
              >
                {a.stopping === first.id ? T.stopping : T.stop}
              </button>
            ) : first.kind === "command" ? (
              <span className="work-say">{T.stopTerminal}</span>
            ) : null}
          </div>
          {a.stopError && (
            <p role="alert" className="state error">
              {a.stopError}
            </p>
          )}
        </section>
      )}
    </>
  );
}

/** One entry's lines: follow the end, search, copy, earlier lines. */
export function LogView(p: {
  entry: Entry;
  lines?: Lines;
  state?: "loading" | "error";
  onEarlier(): void;
}) {
  const [follow, setFollow] = useState(true);
  const [q, setQ] = useState("");
  const [copied, setCopied] = useState<"yes" | "failed" | undefined>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const log = useRef<HTMLPreElement>(null);
  const all = p.lines?.lines ?? [];
  const shown = useMemo(() => matching(all, q), [all, q]);
  useEffect(() => {
    if (follow && log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [shown.length, follow, p.entry.id]);
  const saidCopied = (v: "yes" | "failed") => {
    setCopied(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(undefined), 2000);
  };
  const copyWord = copied === "yes" ? T.copied : copied === "failed" ? T.copyFailed : T.copy;
  return (
    <>
      <div className="row" style={{ gap: 8, alignItems: "center", margin: "6px 0" }}>
        <label className="row" style={{ gap: 4 }}>
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          {T.follow}
        </label>
        <label htmlFor="activity-search" className="sr">
          {T.search}
        </label>
        <input
          id="activity-search"
          className="field"
          type="search"
          placeholder={T.search}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ height: 26, fontSize: 12 }}
        />
        <button
          type="button"
          className="btn"
          onClick={() => {
            if (!navigator.clipboard) return saidCopied("failed");
            void navigator.clipboard.writeText(shown.join("\n")).then(
              () => saidCopied("yes"),
              () => saidCopied("failed"),
            );
          }}
        >
          {copyWord}
        </button>
        <span role="status" className="sr">
          {copied ? copyWord : ""}
        </span>
      </div>
      {p.lines && p.lines.from > 0 && (
        <p className="work-say row" style={{ gap: 8, alignItems: "center" }}>
          {T.earlier(p.lines.from)}
          {p.lines.from > p.entry.from && (
            <button type="button" className="btn" onClick={p.onEarlier}>
              {T.loadEarlier}
            </button>
          )}
        </p>
      )}
      {p.lines?.dropped ? <p className="work-say">{T.dropped(p.lines.dropped)}</p> : null}
      {p.state === "error" && !p.lines ? (
        <p className="state error" role="alert">
          {T.linesFailed}
        </p>
      ) : (
        <pre
          ref={log}
          className="run-console-log"
          role="log"
          aria-live="off"
          aria-busy={p.state === "loading"}
          aria-label={titleOf(p.entry)}
          tabIndex={0}
        >
          {p.state === "loading" && !p.lines
            ? T.linesLoading
            : shown.length
              ? shown.join("\n")
              : q
                ? T.noMatch(q)
                : T.noLines}
        </pre>
      )}
    </>
  );
}

/** The Console at the foot of the app: always there, open or closed. */
export function ActivityConsole() {
  const a = useActivity();
  const copilot = useCopilotRuns();
  if (!a) return null;
  const running = a.entries.filter((e) => e.state === "running").length;
  const shown = a.entries.find((e) => e.id === a.selected) ?? a.entries[0];
  const onListKey = (e: KeyboardEvent) => {
    const list = a.entries;
    const i = list.findIndex((x) => x.id === shown?.id);
    const to =
      e.key === "ArrowDown"
        ? list[(i + 1) % list.length]
        : e.key === "ArrowUp"
          ? list[(i - 1 + list.length) % list.length]
          : e.key === "Home"
            ? list[0]
            : e.key === "End"
              ? list.at(-1)
              : undefined;
    if (!to) return;
    e.preventDefault();
    a.select(to.id);
    document.getElementById(`activity-${to.id}`)?.focus();
  };
  return (
    <section className={`run-console ${a.open ? "open" : ""}`} aria-label={T.title}>
      <div className="run-console-head row" style={{ gap: 8, alignItems: "center" }}>
        <button
          id="run-console-toggle"
          type="button"
          className="btn"
          aria-expanded={a.open}
          aria-controls="run-console-body"
          onClick={() => a.setOpen(!a.open)}
        >
          {a.open ? T.close : T.open}
        </button>
        <strong>{T.title}</strong>
        {running > 0 && <span className="work-say">{T.runningCount(running)}</span>}
        <span className="sr" role="status" aria-live="polite">
          {a.said}
        </span>
      </div>
      {a.open && (
        <div id="run-console-body" className="run-console-body">
          {a.state === "loading" && !a.entries.length ? (
            <p className="work-say" role="status">
              {T.loading}
            </p>
          ) : a.state === "error" && !a.entries.length ? (
            <div className="row" style={{ gap: 8, alignItems: "center" }}>
              <p className="state error" role="alert">
                {T.failed(a.error ?? "")}
              </p>
              <button type="button" className="btn" onClick={a.reload}>
                {T.retry}
              </button>
            </div>
          ) : !a.entries.length ? (
            <div>
              <p>{T.empty}</p>
              <p className="work-say">{T.emptyHint}</p>
            </div>
          ) : (
            <div className="activity">
              <div
                role="tablist"
                aria-orientation="vertical"
                aria-label={T.list}
                className="activity-list"
                onKeyDown={onListKey}
              >
                {a.entries.map((e) => (
                  <button
                    key={e.id}
                    id={`activity-${e.id}`}
                    type="button"
                    role="tab"
                    aria-selected={e.id === shown?.id}
                    aria-controls="activity-panel"
                    tabIndex={e.id === shown?.id ? 0 : -1}
                    className={`activity-item ${e.state}`}
                    onClick={() => a.select(e.id)}
                  >
                    <span className="activity-kind">{T.kinds[e.kind] ?? e.kind}</span>
                    <span className="activity-title">{titleOf(e)}</span>
                    <span className="activity-meta">
                      <span className={`activity-state ${e.state}`}>
                        {T.states[e.state] ?? e.state}
                      </span>
                      {" · "}
                      {T.from(T.where[e.where] ?? e.where)}
                      {" · "}
                      {T.at(timeOf(e.startedAt))}
                    </span>
                  </button>
                ))}
              </div>
              <div
                role="tabpanel"
                id="activity-panel"
                className="activity-panel"
                aria-labelledby={shown ? `activity-${shown.id}` : undefined}
              >
                {shown && (
                  <>
                    <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <strong>{titleOf(shown)}</strong>
                      <span className="work-say">
                        {T.states[shown.state] ?? shown.state}
                        {shown.exitCode !== undefined && shown.state !== "done"
                          ? ` (${T.exitCode(shown.exitCode)})`
                          : ""}
                        {" · "}
                        {T.from(T.where[shown.where] ?? shown.where)}
                        {" · "}
                        {T.at(timeOf(shown.startedAt))}
                      </span>
                      <span style={{ flex: 1 }} />
                      {shown.state === "running" && shown.stop && shown.kind !== "copilot" && (
                        <button
                          type="button"
                          className="btn danger"
                          onClick={() => void a.stop(shown)}
                          disabled={a.stopping === shown.id}
                        >
                          {a.stopping === shown.id ? T.stopping : T.stop}
                        </button>
                      )}
                      {shown.state === "running" && shown.kind === "command" && (
                        <span className="work-say">{T.stopTerminal}</span>
                      )}
                    </div>
                    {shown.state === "ended" && <p className="work-say">{T.endedWithoutSaying}</p>}
                    {shown.state === "waiting" && <p className="work-say">{T.handoffWaits}</p>}
                    {shown.kind === "copilot" && copilot?.run?.runId === shown.id ? (
                      <CopilotRunTabs />
                    ) : (
                      <LogView
                        key={`${shown.id}:${shown.startedAt}`}
                        entry={shown}
                        {...(a.lines[shown.id]?.startedAt === linesKey(shown)
                          ? { lines: a.lines[shown.id]! }
                          : {})}
                        {...(a.linesState[shown.id] ? { state: a.linesState[shown.id]! } : {})}
                        onEarlier={() => a.loadEarlier(shown.id)}
                      />
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** A screen's link to the Console entry of the job it started (ADR 0187). */
export function ShowInConsole(p: { id: string | undefined }) {
  const a = useActivity();
  if (!a || !p.id) return null;
  return (
    <button type="button" className="btn" onClick={() => a.show(p.id!)}>
      {T.strip.show}
    </button>
  );
}
