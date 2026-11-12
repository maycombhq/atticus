import {
  useEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import type { Api } from "@maycombhq/core";
import { useApi, useReloadOnFiles, type Loaded } from "../../api/client.js";
import { COPY } from "../../copy.js";
import { inboxOf, type InboxData, type InboxItem } from "../inbox.js";
import {
  openStepQuestions,
  OWNER_QUESTIONS_PATH,
  questionsToAnswerOf,
  type OwnerQuestionsAnswer,
} from "../question-counts.js";
import {
  ActivityEntryView,
  ActivityStates,
  EntryMeta,
  timeOf,
  titleOf,
  useActivity,
  type ActivityCtx,
} from "../activity.js";
import "./bottom-panel.css";

/**
 * The shell's bottom panel (beta.26), as an editor's: tabs for the Console (ADR 0187: the lines
 * of the run shown, with follow, search, copy and Stop), the open questions, what needs attention
 * (failed runs, blocking findings, facts the verifier rejected) and the recent runs. It holds no
 * list of its own for the Console: the ActivityProvider's is the one the classic layout shows.
 * Questions and Problems are read only once their tab is first shown, so Home's first load asks
 * the server nothing more (packages/cli/test/home-speed.test.ts pins those requests).
 */

const P = COPY.bottomPanel;
const T = COPY.activity;

type Entry = Api.ActivityEntryT;

export const PANEL_TABS = ["console", "questions", "problems", "runs"] as const;
export type PanelTab = (typeof PANEL_TABS)[number];

/** Heard by the panel: show this tab (`detail`), opening the panel (Ctrl+K's panel commands). */
export const PANEL_EVENT = "atticus:panel";

/** Show a tab of the bottom panel, from anywhere (it opens the panel); nothing is read or run. */
export function showPanelTab(tab: PanelTab): void {
  try {
    globalThis.dispatchEvent?.(new CustomEvent(PANEL_EVENT, { detail: tab }));
  } catch {
    // No window (a test): nothing to tell.
  }
}

/** Where the panel's height is kept, per viewer (this browser, or this editor's panel). */
export const PANEL_HEIGHT_KEY = "atticus.panel.height";
export const MIN_HEIGHT = 120;
export const DEFAULT_HEIGHT = 240;
/** How far one arrow key moves the panel's top edge; Page Up and Page Down move five times it. */
export const HEIGHT_STEP = 16;

/** The least the page above the panel keeps: the panel never squeezes it under this. */
export const MIN_PAGE_HEIGHT = 180;

/**
 * The tallest the panel goes: the room the page and the panel share in the page's column (the
 * column less its bars), less the page's least; never under the panel's shortest. Unknown room
 * (no column to measure): the window's height, else 900.
 */
export function maxPanelHeight(room: number | undefined): number {
  const v = typeof room === "number" && room > 0 ? room : 900;
  return Math.max(MIN_HEIGHT, Math.round(v - MIN_PAGE_HEIGHT));
}

type Measured = { offsetHeight: number; id?: string };

/**
 * The room the page and the panel share: the panel's column's height less everything else in
 * it but the page (#main), such as the tab strip; `viewport` when there is no column to measure.
 */
export function roomFor(
  section: (Measured & { parentElement?: unknown }) | null | undefined,
  viewport: number | undefined,
): number | undefined {
  const col = section?.parentElement as
    { clientHeight: number; children: ArrayLike<Measured> } | null | undefined;
  if (!col || !(col.clientHeight > 0)) return viewport;
  let bars = 0;
  for (const c of Array.from(col.children))
    if (c !== section && c.id !== "main") bars += c.offsetHeight || 0;
  return col.clientHeight - bars;
}

export const clampHeight = (h: number, max: number): number =>
  Math.round(Math.min(Math.max(h, MIN_HEIGHT), Math.max(MIN_HEIGHT, max)));

type Store = Pick<Storage, "getItem" | "setItem">;

/** The browser's localStorage, or undefined where even asking for it throws. */
function browserStore(): Store | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** The height the viewer left the panel at; undefined until they chose, or storage refuses. */
export function readPanelHeight(store: Store | undefined = browserStore()): number | undefined {
  try {
    const v = Number(store?.getItem(PANEL_HEIGHT_KEY));
    return Number.isFinite(v) && v > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

export function savePanelHeight(h: number, store: Store | undefined = browserStore()): void {
  try {
    store?.setItem(PANEL_HEIGHT_KEY, String(Math.round(h)));
  } catch {
    // Storage blocked: the height lasts until the page reloads.
  }
}

/** The height a key on the panel's edge asks for (undefined: not a key it takes). */
export function resizeByKey(key: string, h: number, max: number): number | undefined {
  const to =
    key === "ArrowUp"
      ? h + HEIGHT_STEP
      : key === "ArrowDown"
        ? h - HEIGHT_STEP
        : key === "PageUp"
          ? h + HEIGHT_STEP * 5
          : key === "PageDown"
            ? h - HEIGHT_STEP * 5
            : key === "Home"
              ? MIN_HEIGHT
              : key === "End"
                ? max
                : undefined;
  return to === undefined ? undefined : clampHeight(to, max);
}

/** The tab a key on the tab list moves to, round the ends (undefined: not a key it takes). */
export function tabByKey(key: string, i: number, n: number): number | undefined {
  if (key === "ArrowRight") return (i + 1) % n;
  if (key === "ArrowLeft") return (i - 1 + n) % n;
  if (key === "Home") return 0;
  if (key === "End") return n - 1;
  return undefined;
}

/** An open question as the list gives it: only what the panel shows. */
export interface PanelQuestion {
  id: string;
  question: string;
  repo: string;
  state?: string;
}
export interface PanelQuestions {
  questions: PanelQuestion[];
}
export type PanelFinding = InboxData["findings"][number];

export const QUESTIONS_URL = "/api/questions?state=open";
/** Beta.27 review: the owner questions, the other kind the tab's count is made of. */
export const OWNER_QUESTIONS_URL = OWNER_QUESTIONS_PATH;

/**
 * Beta.27 review: the Questions tab's count is the questions to answer, both kinds, as the badge,
 * the status bar, the Explorer, Home and Questions count them (question-counts.ts); beta.27's
 * first cut counted the steps' only (4 where everything else said 7). None until both are read.
 * Beta.27 re-review: when the owner questions can't be read, the steps' count (said as theirs
 * only, panelCountIsStepsOnly), never no count at all.
 */
export function panelQuestionCount(
  steps: Loaded<PanelQuestions>,
  owner: Loaded<OwnerQuestionsAnswer>,
): number | undefined {
  const fromSteps = steps.state === "ready" ? steps.data : undefined;
  if (owner.state === "error") return openStepQuestions(fromSteps);
  return questionsToAnswerOf(fromSteps, owner.state === "ready" ? owner.data : undefined)?.total;
}

/** Whether the Questions tab's count is the steps' only: the owner questions couldn't be read. */
export const panelCountIsStepsOnly = (
  steps: Loaded<PanelQuestions>,
  owner: Loaded<OwnerQuestionsAnswer>,
): boolean => owner.state === "error" && steps.state === "ready";
export const FINDINGS_URL = "/api/findings?state=open";
export const TRUST_URL = "/api/trust";
/** How many open questions the panel lists; the Questions page has them all. */
export const QUESTIONS_SHOWN = 100;

export interface Problems {
  failed: Entry[];
  blocking: InboxItem[];
  rejected: { repo: string; count: number; command?: string }[];
}

/**
 * What needs attention: the runs that failed (from the Console's list), the open findings that
 * block a change (as Home's list words and links them) and the repos whose facts the verifier
 * rejected (Map › Trust's state).
 */
export function problemsOf(o: {
  entries: readonly Entry[];
  findings?: readonly PanelFinding[];
  trust?: Pick<Api.TrustViewT, "repos">;
}): Problems {
  const failed = o.entries.filter((e) => e.state === "failed");
  const blocking = o.findings
    ? inboxOf({
        changes: [],
        findings: [...o.findings],
        questions: [],
        triage: [],
        steps: [],
      }).filter((i) => i.kind === "finding" && i.blocking)
    : [];
  const rejected = (o.trust?.repos ?? [])
    .filter((r) => r.state === "rejected")
    .map((r) => ({
      repo: r.repo,
      count: r.verify.report?.rejected ?? r.lists?.rejected.length ?? 0,
      ...(r.next ? { command: r.next.command } : {}),
    }));
  return { failed, blocking, rejected };
}

const problemCount = (p: Problems) => p.failed.length + p.blocking.length + p.rejected.length;

const focusId = (id: string) => {
  try {
    globalThis.document?.getElementById(id)?.focus();
  } catch {
    // No page to focus in (a test's render).
  }
};

const errorOf = (l: Loaded<unknown>) => (l.state === "error" ? l.error : "");

/**
 * The open questions, each with a link to answer it on the Questions page. Beta.27 review: with
 * the owner questions (`owner`, how many wait) said too, in a row of their own, so the list adds
 * up to the tab's count.
 */
export function QuestionsList(p: { of: Loaded<PanelQuestions>; owner?: number; onRetry(): void }) {
  const Q = P.questions;
  if (p.of.state === "loading")
    return (
      <p className="work-say" role="status">
        {Q.loading}
      </p>
    );
  if (p.of.state === "error")
    return (
      <div className="bp-error">
        <p className="state error" role="alert">
          {Q.failed(p.of.error)}
        </p>
        <button type="button" className="btn" onClick={p.onRetry}>
          {P.retry}
        </button>
      </div>
    );
  const open = p.of.data.questions.filter((q) => !q.state || q.state === "open");
  const owner = p.owner ?? 0;
  if (!open.length && !owner) return <p className="bp-empty">{Q.empty}</p>;
  const shown = open.slice(0, QUESTIONS_SHOWN);
  return (
    <>
      <div className="bp-list-head">
        <span>
          {p.owner !== undefined
            ? COPY.questions.toAnswer(open.length + owner, open.length, owner)
            : Q.intro(open.length)}
        </span>
        <a href="#/questions">{Q.openAll}</a>
      </div>
      <ul className="bp-list">
        {owner > 0 && (
          <li className="bp-row">
            <span className="bp-row-main">
              <span className="bp-row-title">{Q.ownerRow(owner)}</span>
              <span className="bp-row-meta">{Q.ownerMeta}</span>
            </span>
            <a
              className="btn bp-row-act"
              href="#/questions?kind=owner"
              aria-label={Q.ownerLabel(owner)}
            >
              {Q.answer}
            </a>
          </li>
        )}
        {shown.map((q) => (
          <li key={q.id} className="bp-row">
            <span className="bp-row-main">
              <span className="bp-row-title" title={q.question}>
                {q.question}
              </span>
              <span className="bp-row-meta">{q.repo}</span>
            </span>
            <a
              className="btn bp-row-act"
              href={`#/questions/${encodeURIComponent(q.id)}`}
              aria-label={Q.answerLabel(q.question)}
            >
              {Q.answer}
            </a>
          </li>
        ))}
      </ul>
      {open.length > shown.length && (
        <p className="work-say">
          <a href="#/questions">{Q.more(open.length - shown.length)}</a>
        </p>
      )}
    </>
  );
}

/** What needs attention, by kind, each with where it is acted on. */
export function ProblemsList(p: {
  problems: Problems;
  findings: Loaded<unknown>;
  trust: Loaded<unknown>;
  onShow(id: string): void;
  onRetry(): void;
}) {
  const R = P.problems;
  const { failed, blocking, rejected } = p.problems;
  const loading = p.findings.state === "loading" || p.trust.state === "loading";
  const errors = [
    ...(p.findings.state === "error" ? [R.findingsFailed(errorOf(p.findings))] : []),
    ...(p.trust.state === "error" ? [R.trustFailed(errorOf(p.trust))] : []),
  ];
  const any = problemCount(p.problems) > 0;
  return (
    <>
      {loading && (
        <p className="work-say" role="status">
          {R.loading}
        </p>
      )}
      {errors.length > 0 && (
        <div className="bp-error">
          {errors.map((e) => (
            <p key={e} className="state error" role="alert">
              {e}
            </p>
          ))}
          <button type="button" className="btn" onClick={p.onRetry}>
            {P.retry}
          </button>
        </div>
      )}
      {!loading && !errors.length && !any && <p className="bp-empty">{R.empty}</p>}
      {failed.length > 0 && (
        <section className="bp-group" aria-labelledby="bp-problems-failed">
          <h3 id="bp-problems-failed" className="bp-group-head">
            {R.failedRuns}
          </h3>
          <ul className="bp-list">
            {failed.map((e) => (
              <li key={e.id} className="bp-row bad">
                <span className="bp-row-main">
                  <span className="bp-row-title">{titleOf(e)}</span>
                  <span className="bp-row-meta">
                    {R.failedRun(
                      `${T.states[e.state] ?? e.state}${
                        e.exitCode !== undefined ? ` (${T.exitCode(e.exitCode)})` : ""
                      }`,
                      T.from(T.where[e.where] ?? e.where),
                      T.at(timeOf(e.startedAt)),
                    )}
                  </span>
                </span>
                <button
                  type="button"
                  className="btn bp-row-act"
                  aria-label={R.showLabel(titleOf(e))}
                  onClick={() => p.onShow(e.id)}
                >
                  {R.show}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {blocking.length > 0 && (
        <section className="bp-group" aria-labelledby="bp-problems-blocking">
          <h3 id="bp-problems-blocking" className="bp-group-head">
            {R.blocking}
          </h3>
          <ul className="bp-list">
            {blocking.map((f) => (
              <li key={f.id ?? f.title} className="bp-row bad">
                <span className="bp-row-main">
                  <span className="bp-row-title" title={f.title}>
                    {f.title}
                  </span>
                  <span className="bp-row-meta">{f.detail}</span>
                </span>
                <a className="btn bp-row-act" href={f.href} aria-label={R.openLabel(f.title)}>
                  {R.open}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
      {rejected.length > 0 && (
        <section className="bp-group" aria-labelledby="bp-problems-rejected">
          <h3 id="bp-problems-rejected" className="bp-group-head">
            {R.rejected}
          </h3>
          <ul className="bp-list">
            {rejected.map((r) => (
              <li key={r.repo} className="bp-row warn">
                <span className="bp-row-main">
                  <span className="bp-row-title">{R.rejectedFacts(r.repo, r.count)}</span>
                  {r.command && <span className="bp-row-meta">{R.fixThenVerify(r.command)}</span>}
                </span>
                <a className="btn bp-row-act" href="#/trust">
                  {R.openTrust}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/** The recent runs; picking one shows it in the Console tab. */
export function RunsList(p: { a: ActivityCtx; shown?: string; onPick(id: string): void }) {
  if (!p.a.entries.length) return <ActivityStates a={p.a} />;
  const list = p.a.entries;
  const onKey = (e: KeyboardEvent, i: number) => {
    const to =
      e.key === "ArrowDown"
        ? (i + 1) % list.length
        : e.key === "ArrowUp"
          ? (i - 1 + list.length) % list.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? list.length - 1
              : undefined;
    if (to === undefined) return;
    e.preventDefault();
    focusId(`bp-run-${list[to]!.id}`);
  };
  return (
    <>
      <p id="bp-runs-hint" className="work-say bp-hint">
        {P.runs.hint}
      </p>
      <ul className="bp-runs" aria-label={P.runs.label} aria-describedby="bp-runs-hint">
        {list.map((e, i) => (
          <li key={e.id}>
            <button
              id={`bp-run-${e.id}`}
              type="button"
              className={`activity-item bp-run ${e.state}`}
              aria-current={e.id === p.shown ? "true" : undefined}
              onClick={() => p.onPick(e.id)}
              onKeyDown={(k) => onKey(k, i)}
            >
              <EntryMeta e={e} />
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

/** The Console's tab: the run picked (else the newest running, else the newest) and its lines. */
export function ConsoleTab(p: { a: ActivityCtx | undefined }) {
  const a = p.a;
  if (!a) return <p className="bp-empty">{T.empty}</p>;
  if (!a.entries.length) return <ActivityStates a={a} />;
  const shown = a.entries.find((e) => e.id === a.selected) ?? a.entries[0];
  if (!shown) return <p className="bp-empty">{P.console.noneSelected}</p>;
  return (
    <>
      {a.stopError && (
        <p role="alert" className="state error">
          {a.stopError}
        </p>
      )}
      <ActivityEntryView a={a} entry={shown} searchId="bp-search" />
    </>
  );
}

/** What runs now, for the panel's head: its name, where it started and how far it is. */
export function runningSummary(entries: readonly Entry[]): string | undefined {
  const e = entries.find((x) => x.state === "running");
  if (!e) return undefined;
  const step =
    e.progress && e.progress.total > 1
      ? ` · ${T.strip.step(e.progress.done, e.progress.total)}`
      : "";
  return `${P.running(titleOf(e), T.from(T.where[e.where] ?? e.where))}${step}`;
}

export function BottomPanel(props: { open: boolean; onToggle: () => void }): JSX.Element {
  const { open, onToggle } = props;
  const a = useActivity();
  const [tab, setTab] = useState<PanelTab>("console");
  const [seen, setSeen] = useState<Partial<Record<PanelTab, true>>>({});
  // The height the viewer chose, and the room there is now: the panel shows the one clamped to
  // the other on every render, so a smaller window (or a taller bar) never squeezes the page,
  // and a larger one gives the chosen height back (review, beta.26).
  const [wanted, setHeight] = useState(() => readPanelHeight() ?? DEFAULT_HEIGHT);
  const section = useRef<HTMLElement>(null);
  const [room, setRoom] = useState<number | undefined>(() => globalThis.innerHeight);
  useEffect(() => {
    const measure = () => setRoom(roomFor(section.current, globalThis.innerHeight));
    measure();
    if (typeof addEventListener !== "function") return;
    addEventListener("resize", measure);
    const col = section.current?.parentElement;
    const seen =
      col && typeof ResizeObserver === "function" ? new ResizeObserver(measure) : undefined;
    if (col) seen?.observe(col);
    return () => {
      removeEventListener("resize", measure);
      seen?.disconnect();
    };
  }, [open]);
  const max = maxPanelHeight(room);
  const height = clampHeight(wanted, max);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ y: number; h: number } | undefined>(undefined);
  const heightNow = useRef(height);
  heightNow.current = height;
  const [said, setSaid] = useState("");

  // Questions and Problems are read the first time their tab is shown, then kept.
  const shownNow = (t: PanelTab) => !!seen[t] || (open && tab === t);
  useEffect(() => {
    if (open && !seen[tab]) setSeen((s) => ({ ...s, [tab]: true }));
  }, [open, tab, seen]);
  const questions = useApi<PanelQuestions>(shownNow("questions") ? QUESTIONS_URL : undefined);
  const owner = useApi<OwnerQuestionsAnswer>(
    shownNow("questions") ? OWNER_QUESTIONS_URL : undefined,
  );
  const findings = useApi<PanelFinding[]>(shownNow("problems") ? FINDINGS_URL : undefined);
  const trust = useApi<Api.TrustViewT>(shownNow("problems") ? TRUST_URL : undefined);
  useReloadOnFiles(questions, owner, findings, trust);

  // The Console's open is the panel's: the panel reads the shown run's lines only while open,
  // and Show in the Console (from anywhere) opens the panel on the Console.
  const ctxOpen = a?.open;
  const synced = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    if (!a) return;
    if (synced.current !== open) {
      synced.current = open;
      if (a.open !== open) a.setOpen(open);
      return;
    }
    if (a.open !== open) {
      if (a.open) setTab("console");
      onToggle();
    }
    // Only the two opens decide it: a new context value or onToggle each render doesn't.
  }, [open, ctxOpen]);
  const showAsks = a?.showAsks ?? 0;
  const lastAsks = useRef(showAsks);
  useEffect(() => {
    if (showAsks === lastAsks.current) return;
    lastAsks.current = showAsks;
    setTab("console");
  }, [showAsks]);

  // Said politely: what the Console says (an end, new lines) and a run that starts.
  const known = useRef<Set<string> | undefined>(undefined);
  const entries = a?.entries;
  const listState = a?.state;
  useEffect(() => {
    if (!entries || listState !== "ready") return;
    if (!known.current) {
      known.current = new Set(entries.map((e) => e.id));
      return;
    }
    const fresh = entries.filter((e) => !known.current!.has(e.id));
    for (const e of fresh) known.current.add(e.id);
    const started = fresh.find((e) => e.state === "running");
    if (started) setSaid(P.started(titleOf(started)));
  }, [entries, listState]);
  const ctxSaid = a?.said;
  useEffect(() => {
    if (ctxSaid) setSaid(ctxSaid);
  }, [ctxSaid]);

  const choose = (t: PanelTab) => {
    setTab(t);
    if (!open) onToggle();
  };
  // Ctrl+K's panel commands: the tab asked for, the panel opened, the focus on the tab.
  const chooseNow = useRef(choose);
  chooseNow.current = choose;
  useEffect(() => {
    if (typeof addEventListener !== "function") return;
    const on = (e: Event) => {
      const t = (e as CustomEvent<unknown>).detail;
      if (!(PANEL_TABS as readonly unknown[]).includes(t)) return;
      chooseNow.current(t as PanelTab);
      requestAnimationFrame(() => focusId(`bp-tab-${t as PanelTab}`));
    };
    addEventListener(PANEL_EVENT, on);
    return () => removeEventListener(PANEL_EVENT, on);
  }, []);
  const onTabKey = (e: KeyboardEvent) => {
    const to = tabByKey(e.key, PANEL_TABS.indexOf(tab), PANEL_TABS.length);
    if (to === undefined) return;
    e.preventDefault();
    const t = PANEL_TABS[to]!;
    choose(t);
    focusId(`bp-tab-${t}`);
  };

  const onEdgeKey = (e: KeyboardEvent) => {
    const h = resizeByKey(e.key, height, max);
    if (h === undefined) return;
    e.preventDefault();
    setHeight(h);
    savePanelHeight(h);
  };
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try {
      e.currentTarget?.setPointerCapture?.(e.pointerId);
    } catch {
      // A pointer the page can't capture: the drag still follows while over the edge.
    }
    drag.current = { y: e.clientY, h: height };
    setDragging(true);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    setHeight(clampHeight(d.h + d.y - e.clientY, max));
  };
  const onUp = (e: PointerEvent<HTMLDivElement>, cancelled = false) => {
    const d = drag.current;
    if (!d) return;
    drag.current = undefined;
    setDragging(false);
    const h = cancelled ? heightNow.current : clampHeight(d.h + d.y - e.clientY, max);
    setHeight(h);
    savePanelHeight(h);
  };

  const shownId = a ? (a.entries.find((e) => e.id === a.selected) ?? a.entries[0])?.id : undefined;
  const pickRun = (id: string) => {
    a?.select(id);
    setTab("console");
    focusId("bp-tab-console");
  };
  const showRun = (id: string) => {
    if (a) a.show(id);
    setTab("console");
    focusId("bp-tab-console");
  };

  const problems = problemsOf({
    entries: a?.entries ?? [],
    ...(findings.state === "ready" ? { findings: findings.data } : {}),
    ...(trust.state === "ready" ? { trust: trust.data } : {}),
  });
  const toAnswer = panelQuestionCount(questions, owner);
  const stepsOnly = panelCountIsStepsOnly(questions, owner);
  const counts: Partial<Record<PanelTab, number>> = {
    ...(toAnswer !== undefined ? { questions: toAnswer } : {}),
    ...(findings.state === "ready" && trust.state === "ready"
      ? { problems: problemCount(problems) }
      : {}),
  };
  const summary = runningSummary(a?.entries ?? []);

  return (
    <section
      ref={section}
      className={`bp${open ? " open" : ""}${dragging ? " dragging" : ""}`}
      aria-label={P.label}
      style={open ? { height } : undefined}
    >
      {open && (
        <div
          className="bp-resize"
          role="separator"
          aria-orientation="horizontal"
          aria-label={P.resize}
          aria-description={P.resizeHint}
          aria-controls="bp-body"
          aria-valuemin={MIN_HEIGHT}
          aria-valuemax={max}
          aria-valuenow={height}
          tabIndex={0}
          onKeyDown={onEdgeKey}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={(e) => onUp(e)}
          onPointerCancel={(e) => onUp(e, true)}
        />
      )}
      <div className="bp-head">
        <div role="tablist" aria-label={P.tabs} className="bp-tabs" onKeyDown={onTabKey}>
          {PANEL_TABS.map((t) => (
            <button
              key={t}
              id={`bp-tab-${t}`}
              type="button"
              role="tab"
              className="bp-tab"
              aria-selected={t === tab}
              aria-controls={`bp-panel-${t}`}
              tabIndex={t === tab ? 0 : -1}
              onClick={() => choose(t)}
            >
              <span>{P.tab[t]}</span>
              {counts[t] !== undefined && (
                <>
                  <span
                    className="bp-count"
                    aria-hidden="true"
                    {...(t === "questions" && stepsOnly
                      ? { title: P.countStepsOnly(counts[t]!) }
                      : {})}
                  >
                    {counts[t]!.toLocaleString()}
                  </span>
                  <span className="sr">
                    {t === "questions" && stepsOnly
                      ? P.countStepsOnly(counts[t]!)
                      : P.count(counts[t]!)}
                  </span>
                </>
              )}
            </button>
          ))}
        </div>
        <span className="bp-summary" title={summary}>
          {summary}
        </span>
        <span className="sr" role="status" aria-live="polite">
          {said}
        </span>
        <button
          type="button"
          className="bp-toggle"
          aria-expanded={open}
          aria-controls="bp-body"
          aria-label={open ? P.collapse : P.expand}
          title={open ? P.collapse : P.expand}
          onClick={onToggle}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
            <path
              d={open ? "M4 6l4 4 4-4" : "M4 10l4-4 4 4"}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
      <div id="bp-body" className="bp-body" hidden={!open}>
        {PANEL_TABS.map((t) => (
          <div
            key={t}
            id={`bp-panel-${t}`}
            role="tabpanel"
            aria-labelledby={`bp-tab-${t}`}
            className={`bp-panel bp-panel-${t}`}
            hidden={t !== tab}
            tabIndex={t === "console" ? -1 : 0}
          >
            {open && t === tab && t === "console" && <ConsoleTab a={a} />}
            {open && t === tab && t === "questions" && (
              <QuestionsList
                of={questions}
                {...(owner.state === "ready" && typeof owner.data.open === "number"
                  ? { owner: owner.data.open }
                  : {})}
                onRetry={questions.reload}
              />
            )}
            {open && t === tab && t === "problems" && (
              <ProblemsList
                problems={problems}
                findings={findings}
                trust={trust}
                onShow={showRun}
                onRetry={() => {
                  if (findings.state === "error") findings.reload();
                  if (trust.state === "error") trust.reload();
                }}
              />
            )}
            {open &&
              t === tab &&
              t === "runs" &&
              (a ? (
                <RunsList a={a} {...(shownId ? { shown: shownId } : {})} onPick={pickRun} />
              ) : (
                <p className="bp-empty">{T.empty}</p>
              ))}
          </div>
        ))}
      </div>
    </section>
  );
}
