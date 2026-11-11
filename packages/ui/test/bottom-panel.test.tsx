import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "@maycombhq/core";
import { all, mount, text } from "./support/hooks.js";

/**
 * Beta.26: the shell's bottom panel. Console, Questions, Problems and Runs as tabs (arrow keys
 * move between them), a top edge that resizes by drag or keys and keeps its height, collapse,
 * Show in the Console from anywhere, and Questions and Problems read only once their tab is shown.
 * Rendered with the tiny hooks runtime, no DOM; the server's answers are given per path.
 */

vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});

type Answer =
  { state: "loading" } | { state: "error"; error: string } | { state: "ready"; data: unknown };
const answers = new Map<string, Answer>();
const asked: (string | undefined)[] = [];
const reloads: string[] = [];
vi.mock("../src/api/client.js", async () => {
  const real = await vi.importActual<typeof import("../src/api/client.js")>("../src/api/client.js");
  return {
    ...real,
    api: async () => {
      throw new Error("no request in this test");
    },
    useApi: (path: string | undefined) => {
      asked.push(path);
      const a = (path && answers.get(path)) ?? { state: "loading" };
      return { ...a, refreshing: false, reload: () => reloads.push(path ?? "") };
    },
    useReloadOnFiles: () => undefined,
    useLiveEvents: () => undefined,
  };
});

const { COPY } = await import("../src/copy.js");
const {
  BottomPanel,
  ConsoleTab,
  ProblemsList,
  QuestionsList,
  RunsList,
  DEFAULT_HEIGHT,
  FINDINGS_URL,
  MIN_HEIGHT,
  MIN_PAGE_HEIGHT,
  PANEL_EVENT,
  PANEL_HEIGHT_KEY,
  QUESTIONS_URL,
  OWNER_QUESTIONS_URL,
  showPanelTab,
  TRUST_URL,
  clampHeight,
  maxPanelHeight,
  problemsOf,
  readPanelHeight,
  resizeByKey,
  roomFor,
  runningSummary,
  savePanelHeight,
  tabByKey,
} = await import("../src/app/shell/BottomPanel.js");
const { ActivityConsole, ActivityContext, ActivityEntryView, ActivityStates, ActivityStrip } =
  await import("../src/app/activity.js");
type ActivityCtx = import("../src/app/activity.js").ActivityCtx;

const P = COPY.bottomPanel;
const T = COPY.activity;

const entry = (o: Partial<Api.ActivityEntryT> = {}): Api.ActivityEntryT => ({
  id: "job-1",
  kind: "scan",
  title: "Scan",
  where: "app",
  state: "running",
  startedAt: "2026-11-09T10:00:00.000Z",
  progress: { done: 2, total: 5, message: "forge-ledger" },
  lines: 2,
  from: 0,
  stop: "/api/jobs/job-1/cancel",
  jobId: "job-1",
  ...o,
});
const verify = entry({
  id: "term-20261109-095000-11-cd34",
  kind: "command",
  title: "atticus verify --all --write",
  where: "terminal",
  state: "failed",
  exitCode: 1,
  startedAt: "2026-11-09T09:50:00.000Z",
  progress: undefined,
  stop: undefined,
  jobId: undefined,
});
const synced = entry({
  id: "job-0",
  kind: "sync",
  title: undefined,
  state: "done",
  startedAt: "2026-11-09T09:00:00.000Z",
  progress: undefined,
});

type Calls = { select: string[]; show: string[]; open: boolean[]; stop: string[] };
let calls: Calls;
const ctx = (o: Partial<ActivityCtx> = {}): ActivityCtx => ({
  state: "ready",
  entries: [entry(), verify, synced],
  lines: { "job-1": { from: 0, lines: ["Scanning forge-ledger"], startedAt: entry().startedAt } },
  linesState: {},
  selected: "job-1",
  select: (id) => void calls.select.push(id),
  open: true,
  setOpen: (v) => void calls.open.push(v),
  show: (id) => void calls.show.push(id),
  stop: async (e) => void calls.stop.push(e.id),
  reload: () => undefined,
  loadEarlier: () => undefined,
  said: "",
  showAsks: 0,
  ...o,
});
const holder = ActivityContext as unknown as { _currentValue: unknown };
const provide = (a: ActivityCtx | undefined) => {
  holder._currentValue = a;
};

/** A browser's localStorage, or one that refuses (private windows, blocked site data). */
function storage(o: { value?: string; throws?: boolean } = {}) {
  const saved: Record<string, string> =
    o.value === undefined ? {} : { [PANEL_HEIGHT_KEY]: o.value };
  return {
    saved,
    getItem: (k: string) => {
      if (o.throws) throw new Error("SecurityError");
      return saved[k] ?? null;
    },
    setItem: (k: string, v: string) => {
      if (o.throws) throw new Error("QuotaExceededError");
      saved[k] = v;
    },
  };
}

const els = (tree: unknown) => all(tree);
const byRole = (tree: unknown, role: string) => els(tree).filter((e) => e.props.role === role);
const tabs = (tree: unknown) => byRole(tree, "tab");
const selectedTab = (tree: unknown) =>
  tabs(tree).find((t) => t.props["aria-selected"] === true)?.props.id;
const visiblePanel = (tree: unknown) => byRole(tree, "tabpanel").find((p) => !p.props.hidden);
const separator = (tree: unknown) => byRole(tree, "separator")[0];
const key = (k: string) => ({ key: k, preventDefault: () => undefined });
const ofType = (tree: unknown, type: unknown) => els(tree).filter((e) => e.type === type);
const button = (tree: unknown, label: string) =>
  els(tree).find((e) => e.type === "button" && text(e.props.children) === label);

let toggles = 0;
const props = (open: boolean) => ({ open, onToggle: () => void toggles++ });

beforeEach(() => {
  calls = { select: [], show: [], open: [], stop: [] };
  toggles = 0;
  answers.clear();
  asked.length = 0;
  reloads.length = 0;
  provide(ctx());
  vi.stubGlobal("localStorage", storage());
});
afterEach(() => {
  provide(undefined);
  vi.unstubAllGlobals();
});

describe("the bottom panel's tabs", () => {
  it("is a tab list of Console, Questions, Problems and Runs, Console first", () => {
    const m = mount(BottomPanel, props(true));
    const list = byRole(m.tree, "tablist")[0]!;
    expect(list.props["aria-label"]).toBe(P.tabs);
    expect(tabs(m.tree).map((t) => text(t.props.children))).toEqual([
      T.title,
      P.tab.questions,
      P.tab.problems,
      P.tab.runs,
    ]);
    expect(selectedTab(m.tree)).toBe("bp-tab-console");
    // Roving focus: only the selected tab is in the Tab order; each names the panel it controls.
    expect(tabs(m.tree).map((t) => t.props.tabIndex)).toEqual([0, -1, -1, -1]);
    for (const t of tabs(m.tree))
      expect(t.props["aria-controls"]).toBe(String(t.props.id).replace("bp-tab-", "bp-panel-"));
    const panels = byRole(m.tree, "tabpanel");
    expect(panels).toHaveLength(4);
    expect(panels.filter((p) => !p.props.hidden).map((p) => p.props["aria-labelledby"])).toEqual([
      "bp-tab-console",
    ]);
    expect(ofType(visiblePanel(m.tree), ConsoleTab)).toHaveLength(1);
  });

  it("moves between tabs with the arrow keys, round the ends, and Home and End", () => {
    const m = mount(BottomPanel, props(true));
    const press = (k: string) => {
      (byRole(m.tree, "tablist")[0]!.props.onKeyDown as (e: unknown) => void)(key(k));
      m.render();
      return selectedTab(m.tree);
    };
    expect(press("ArrowRight")).toBe("bp-tab-questions");
    expect(press("ArrowRight")).toBe("bp-tab-problems");
    expect(press("End")).toBe("bp-tab-runs");
    expect(press("ArrowRight")).toBe("bp-tab-console");
    expect(press("ArrowLeft")).toBe("bp-tab-runs");
    expect(press("Home")).toBe("bp-tab-console");
    // Other keys are left alone.
    expect(press("a")).toBe("bp-tab-console");
    expect(tabByKey("ArrowLeft", 0, 4)).toBe(3);
    expect(tabByKey("Enter", 0, 4)).toBeUndefined();
  });

  it("opens the panel when a tab is picked while it is collapsed", () => {
    const m = mount(BottomPanel, props(false));
    (tabs(m.tree)[3]!.props.onClick as () => void)();
    m.render();
    expect(selectedTab(m.tree)).toBe("bp-tab-runs");
    expect(toggles).toBe(1);
  });

  it("says what runs on the right of its head, and a run that starts, politely", () => {
    const m = mount(BottomPanel, props(true));
    const summary = els(m.tree).find((e) => e.props.className === "bp-summary")!;
    expect(text(summary.props.children)).toBe(
      `${P.running("Scan", T.from(T.where.app!))} · ${T.strip.step(2, 5)}`,
    );
    expect(runningSummary([verify, synced])).toBeUndefined();
    const live = els(m.tree).find((e) => e.props["aria-live"] === "polite")!;
    expect(live.props.role).toBe("status");
    expect(text(live.props.children)).toBe("");
    // A new run appears in the list: said once, by its name.
    const started = entry({ id: "job-2", title: "Sync", startedAt: "2026-11-09T11:00:00.000Z" });
    provide(ctx({ entries: [started, entry(), verify, synced] }));
    m.render();
    const now = els(m.tree).find((e) => e.props["aria-live"] === "polite")!;
    expect(text(now.props.children)).toBe(P.started("Sync"));
    // And what the Console says (an end, new lines) is said there too.
    const ended = T.changed("Scan", T.states.done!);
    provide(ctx({ said: ended }));
    m.render();
    expect(text(els(m.tree).find((e) => e.props["aria-live"] === "polite")!.props.children)).toBe(
      ended,
    );
  });
});

describe("Show in the Console", () => {
  it("turns an open panel to the Console with the run picked", () => {
    const m = mount(BottomPanel, props(true));
    (tabs(m.tree)[1]!.props.onClick as () => void)();
    m.render();
    expect(selectedTab(m.tree)).toBe("bp-tab-questions");
    // A screen's Show in the Console: show(id) picked the run and asked once more.
    provide(ctx({ selected: verify.id, showAsks: 1 }));
    m.render();
    expect(selectedTab(m.tree)).toBe("bp-tab-console");
    const tab = ofType(visiblePanel(m.tree), ConsoleTab)[0]!;
    expect((tab.props.a as ActivityCtx).selected).toBe(verify.id);
    expect(toggles).toBe(0);
  });

  it("opens a collapsed panel on the Console", () => {
    provide(ctx({ open: false }));
    const p = props(false);
    const m = mount(BottomPanel, p);
    (tabs(m.tree)[2]!.props.onClick as () => void)();
    m.render();
    expect(toggles).toBe(1);
    // The shell kept it collapsed; then a strip's Show opens the Console.
    toggles = 0;
    provide(ctx({ open: false }));
    m.render();
    provide(ctx({ open: true, selected: verify.id, showAsks: 1 }));
    m.render();
    expect(toggles).toBe(1);
    expect(selectedTab(m.tree)).toBe("bp-tab-console");
  });

  it("keeps the Console's open the panel's, so the shown run's lines are read only while open", () => {
    provide(ctx({ open: false }));
    const p = props(true);
    const m = mount(BottomPanel, p);
    expect(calls.open).toEqual([true]);
    expect(toggles).toBe(0);
    p.open = false;
    provide(ctx({ open: true }));
    m.render();
    expect(calls.open).toEqual([true, false]);
  });

  it("is what the strip's Show does, and what a failed run's row in Problems offers", () => {
    const strip = mount(ActivityStrip, {});
    (button(strip.tree, T.strip.show)!.props.onClick as () => void)();
    expect(calls.show).toEqual(["job-1"]);
    const onShow = vi.fn();
    const m = mount(ProblemsList, {
      problems: problemsOf({ entries: [verify] }),
      findings: { state: "ready", data: [] },
      trust: { state: "ready", data: { repos: [] } },
      onShow,
      onRetry: () => undefined,
    });
    const show = els(m.tree).find(
      (e) => e.props["aria-label"] === P.problems.showLabel(verify.title!),
    )!;
    (show.props.onClick as () => void)();
    expect(onShow).toHaveBeenCalledWith(verify.id);
  });

  it("picks a run from Runs and shows it in the Console", () => {
    const m = mount(BottomPanel, props(true));
    (tabs(m.tree)[3]!.props.onClick as () => void)();
    m.render();
    const runs = ofType(visiblePanel(m.tree), RunsList)[0]!;
    expect(runs.props.shown).toBe("job-1");
    (runs.props.onPick as (id: string) => void)(verify.id);
    m.render();
    expect(calls.select).toEqual([verify.id]);
    expect(selectedTab(m.tree)).toBe("bp-tab-console");
  });
});

describe("the panel's height", () => {
  it("starts at the height kept, else the default, clamped to the window", () => {
    vi.stubGlobal("localStorage", storage({ value: "300" }));
    expect(separator(mount(BottomPanel, props(true)).tree)!.props["aria-valuenow"]).toBe(300);
    vi.stubGlobal("localStorage", storage());
    expect(separator(mount(BottomPanel, props(true)).tree)!.props["aria-valuenow"]).toBe(
      DEFAULT_HEIGHT,
    );
    vi.stubGlobal("localStorage", storage({ value: "99999" }));
    expect(separator(mount(BottomPanel, props(true)).tree)!.props["aria-valuenow"]).toBe(
      maxPanelHeight(undefined),
    );
    // Storage that refuses: the default, and nothing thrown.
    vi.stubGlobal("localStorage", storage({ throws: true }));
    expect(separator(mount(BottomPanel, props(true)).tree)!.props["aria-valuenow"]).toBe(
      DEFAULT_HEIGHT,
    );
    expect(readPanelHeight(storage({ value: "nope" }))).toBeUndefined();
    expect(() => savePanelHeight(200, storage({ throws: true }))).not.toThrow();
  });

  it("is a separator the keyboard resizes, and keeps what it was set to", () => {
    const store = storage({ value: "300" });
    vi.stubGlobal("localStorage", store);
    const m = mount(BottomPanel, props(true));
    const edge = separator(m.tree)!;
    expect(edge.props.tabIndex).toBe(0);
    expect(edge.props["aria-orientation"]).toBe("horizontal");
    expect(edge.props["aria-label"]).toBe(P.resize);
    expect(edge.props["aria-valuemin"]).toBe(MIN_HEIGHT);
    expect(edge.props["aria-valuemax"]).toBe(maxPanelHeight(undefined));
    const press = (k: string) => {
      (separator(m.tree)!.props.onKeyDown as (e: unknown) => void)(key(k));
      m.render();
      return separator(m.tree)!.props["aria-valuenow"];
    };
    expect(press("ArrowUp")).toBe(316);
    expect(store.saved[PANEL_HEIGHT_KEY]).toBe("316");
    expect(press("ArrowDown")).toBe(300);
    expect(press("PageDown")).toBe(220);
    expect(press("Home")).toBe(MIN_HEIGHT);
    expect(press("ArrowDown")).toBe(MIN_HEIGHT);
    expect(press("End")).toBe(maxPanelHeight(undefined));
    expect(store.saved[PANEL_HEIGHT_KEY]).toBe(String(maxPanelHeight(undefined)));
    const section = els(m.tree).find((e) => e.type === "section")!;
    expect((section.props.style as { height: number }).height).toBe(maxPanelHeight(undefined));
  });

  it("follows a drag of its top edge and keeps the height it was let go at", () => {
    const store = storage({ value: "200" });
    vi.stubGlobal("localStorage", store);
    const m = mount(BottomPanel, props(true));
    const ev = (y: number) => ({
      button: 0,
      clientY: y,
      pointerId: 1,
      preventDefault: () => undefined,
      currentTarget: { setPointerCapture: () => undefined },
    });
    const call = (name: string, y: number) => {
      (separator(m.tree)!.props[name] as (e: unknown) => void)(ev(y));
      m.render();
    };
    call("onPointerDown", 600);
    expect(els(m.tree).find((e) => e.type === "section")!.props.className).toContain("dragging");
    call("onPointerMove", 500);
    expect(separator(m.tree)!.props["aria-valuenow"]).toBe(300);
    expect(store.saved[PANEL_HEIGHT_KEY]).toBe("200");
    call("onPointerMove", 9999);
    expect(separator(m.tree)!.props["aria-valuenow"]).toBe(MIN_HEIGHT);
    call("onPointerUp", 450);
    expect(separator(m.tree)!.props["aria-valuenow"]).toBe(350);
    expect(store.saved[PANEL_HEIGHT_KEY]).toBe("350");
    // A move after letting go changes nothing.
    call("onPointerMove", 100);
    expect(separator(m.tree)!.props["aria-valuenow"]).toBe(350);
    expect(clampHeight(10, 500)).toBe(MIN_HEIGHT);
    expect(resizeByKey("Tab", 200, 500)).toBeUndefined();
  });
});

describe("the panel's height leaves the page room (review, beta.26)", () => {
  it("caps the panel at the column's room for the page and panel, less the page's least", () => {
    expect(maxPanelHeight(600)).toBe(600 - MIN_PAGE_HEIGHT);
    expect(maxPanelHeight(200)).toBe(MIN_HEIGHT);
    // The room is the column less its bars (the tab strip): the page and the panel share it.
    const section = { offsetHeight: 240 } as unknown as HTMLElement;
    const column = {
      clientHeight: 700,
      children: [{ id: "", offsetHeight: 36 }, { id: "main", offsetHeight: 424 }, section],
    };
    (section as unknown as { parentElement: unknown }).parentElement = column;
    expect(roomFor(section, 900)).toBe(664);
    // No column to measure (a test's render): the window's height.
    expect(roomFor(null, 900)).toBe(900);
    expect(roomFor(undefined, undefined)).toBeUndefined();
  });

  it("clamps the height kept as the window shrinks, and gives it back as it grows", () => {
    const win = new EventTarget();
    vi.stubGlobal("addEventListener", win.addEventListener.bind(win));
    vi.stubGlobal("removeEventListener", win.removeEventListener.bind(win));
    vi.stubGlobal("innerHeight", 900);
    vi.stubGlobal("localStorage", storage({ value: "400" }));
    const m = mount(BottomPanel, props(true));
    const height = () => separator(m.tree)!.props["aria-valuenow"];
    const section = () =>
      (els(m.tree).find((e) => e.type === "section")!.props.style as { height: number }).height;
    expect(height()).toBe(400);
    vi.stubGlobal("innerHeight", 500);
    win.dispatchEvent(new Event("resize"));
    m.render();
    expect(height()).toBe(500 - MIN_PAGE_HEIGHT);
    expect(section()).toBe(500 - MIN_PAGE_HEIGHT);
    expect(separator(m.tree)!.props["aria-valuemax"]).toBe(500 - MIN_PAGE_HEIGHT);
    vi.stubGlobal("innerHeight", 900);
    win.dispatchEvent(new Event("resize"));
    m.render();
    expect(height()).toBe(400);
  });
});

describe("Ctrl+K's panel commands (review, beta.26)", () => {
  it("opens the panel on the tab asked for and focuses it", () => {
    const win = new EventTarget();
    vi.stubGlobal("addEventListener", win.addEventListener.bind(win));
    vi.stubGlobal("removeEventListener", win.removeEventListener.bind(win));
    vi.stubGlobal("dispatchEvent", win.dispatchEvent.bind(win));
    const frames: (() => void)[] = [];
    vi.stubGlobal("requestAnimationFrame", (f: () => void) => frames.push(f));
    const focused: string[] = [];
    vi.stubGlobal("document", {
      getElementById: (id: string) => ({ focus: () => focused.push(id) }),
    });
    const m = mount(BottomPanel, props(false));
    showPanelTab("problems");
    m.render();
    expect(toggles).toBe(1);
    expect(selectedTab(m.tree)).toBe("bp-tab-problems");
    for (const f of frames) f();
    expect(focused).toEqual(["bp-tab-problems"]);
    // Something that isn't a tab is let be.
    win.dispatchEvent(new CustomEvent(PANEL_EVENT, { detail: "elsewhere" }));
    m.render();
    expect(selectedTab(m.tree)).toBe("bp-tab-problems");
  });
});

describe("collapsing the panel", () => {
  it("shows only its head when collapsed, with a button to show it", () => {
    const m = mount(BottomPanel, props(false));
    const section = els(m.tree).find((e) => e.type === "section")!;
    expect(section.props.style).toBeUndefined();
    expect(section.props["aria-label"]).toBe(P.label);
    expect(separator(m.tree)).toBeUndefined();
    expect(els(m.tree).find((e) => e.props.id === "bp-body")!.props.hidden).toBe(true);
    expect(ofType(m.tree, ConsoleTab)).toHaveLength(0);
    const toggle = els(m.tree).find((e) => e.props.className === "bp-toggle")!;
    expect(toggle.props["aria-expanded"]).toBe(false);
    expect(toggle.props["aria-controls"]).toBe("bp-body");
    expect(toggle.props["aria-label"]).toBe(P.expand);
    (toggle.props.onClick as () => void)();
    expect(toggles).toBe(1);
  });

  it("hides with the same button when open", () => {
    const m = mount(BottomPanel, props(true));
    const toggle = els(m.tree).find((e) => e.props.className === "bp-toggle")!;
    expect(toggle.props["aria-expanded"]).toBe(true);
    expect(toggle.props["aria-label"]).toBe(P.collapse);
    expect(els(m.tree).find((e) => e.props.id === "bp-body")!.props.hidden).toBe(false);
  });
});

describe("Questions and Problems are read when first shown", () => {
  it("asks nothing while the Console or Runs is shown, or while collapsed", () => {
    const m = mount(BottomPanel, props(true));
    (tabs(m.tree)[3]!.props.onClick as () => void)();
    m.render();
    expect(asked.filter(Boolean)).toEqual([]);
    const shut = mount(BottomPanel, props(false));
    (byRole(shut.tree, "tablist")[0]!.props.onKeyDown as (e: unknown) => void)(key("ArrowRight"));
    shut.render();
    expect(selectedTab(shut.tree)).toBe("bp-tab-questions");
    expect(asked.filter(Boolean)).toEqual([]);
  });

  it("reads the open questions once their tab is shown, then counts them on the tab", () => {
    const m = mount(BottomPanel, props(true));
    (tabs(m.tree)[1]!.props.onClick as () => void)();
    m.render();
    // Beta.27 review: both kinds of question to answer, the owner questions too.
    expect(new Set(asked.filter(Boolean))).toEqual(new Set([QUESTIONS_URL, OWNER_QUESTIONS_URL]));
    answers.set(OWNER_QUESTIONS_URL, { state: "ready", data: { open: 0 } });
    answers.set(QUESTIONS_URL, {
      state: "ready",
      data: {
        questions: [
          { id: "q-1", question: "Which queue does forge-ledger read?", repo: "forge-ledger" },
          { id: "q-2", question: "Who owns forge-cards?", repo: "forge-cards", state: "open" },
        ],
      },
    });
    // Back on the Console, the questions stay read and counted.
    (tabs(m.tree)[0]!.props.onClick as () => void)();
    m.render();
    expect(asked.slice(-4, -2)).toEqual([QUESTIONS_URL, OWNER_QUESTIONS_URL]);
    const q = tabs(m.tree)[1]!;
    expect(text(q.props.children)).toBe(`${P.tab.questions}2${P.count(2)}`);
    const badge = all(q.props.children).find((e) => e.props.className === "bp-count")!;
    expect(badge.props["aria-hidden"]).toBe("true");
  });

  it("reads the findings and the verifier's reports once Problems is shown, then counts", () => {
    const m = mount(BottomPanel, props(true));
    (tabs(m.tree)[2]!.props.onClick as () => void)();
    m.render();
    expect(new Set(asked.filter(Boolean))).toEqual(new Set([FINDINGS_URL, TRUST_URL]));
    expect(text(tabs(m.tree)[2]!.props.children)).toBe(P.tab.problems);
    answers.set(FINDINGS_URL, { state: "ready", data: [] });
    answers.set(TRUST_URL, { state: "ready", data: { repos: [] } });
    m.render();
    // One failed run, nothing else.
    expect(text(tabs(m.tree)[2]!.props.children)).toBe(`${P.tab.problems}1${P.count(1)}`);
  });
});

describe("each tab's empty, loading and error states", () => {
  it("Console: the Console's own, else the run shown with its Stop error", () => {
    expect(
      ofType(mount(ConsoleTab, { a: ctx({ entries: [], state: "loading" }) }).tree, ActivityStates),
    ).toHaveLength(1);
    expect(text(mount(ActivityStates, { a: ctx({ entries: [], state: "loading" }) }).tree)).toBe(
      T.loading,
    );
    const err = mount(ActivityStates, {
      a: ctx({ entries: [], state: "error", error: "offline" }),
    });
    expect(text(err.tree)).toContain(T.failed("offline"));
    expect(byRole(err.tree, "alert")).toHaveLength(1);
    expect(button(err.tree, T.retry)).toBeDefined();
    expect(text(mount(ActivityStates, { a: ctx({ entries: [] }) }).tree)).toBe(
      `${T.empty}${T.emptyHint}`,
    );
    expect(text(mount(ConsoleTab, { a: undefined }).tree)).toBe(T.empty);
    const shown = mount(ConsoleTab, {
      a: ctx({ selected: verify.id, stopError: T.stopFailed("no") }),
    });
    expect(text(byRole(shown.tree, "alert")[0])).toBe(T.stopFailed("no"));
    const view = ofType(shown.tree, ActivityEntryView)[0]!;
    expect((view.props.entry as Api.ActivityEntryT).id).toBe(verify.id);
    expect(view.props.searchId).toBe("bp-search");
  });

  it("Questions: loading, error with Try again, empty, and each with a link to answer it", () => {
    const retry = vi.fn();
    expect(text(mount(QuestionsList, { of: { state: "loading" }, onRetry: retry }).tree)).toBe(
      P.questions.loading,
    );
    const err = mount(QuestionsList, { of: { state: "error", error: "offline" }, onRetry: retry });
    expect(text(byRole(err.tree, "alert")[0])).toBe(P.questions.failed("offline"));
    (button(err.tree, P.retry)!.props.onClick as () => void)();
    expect(retry).toHaveBeenCalled();
    expect(
      text(
        mount(QuestionsList, { of: { state: "ready", data: { questions: [] } }, onRetry: retry })
          .tree,
      ),
    ).toBe(P.questions.empty);
    const list = mount(QuestionsList, {
      of: {
        state: "ready",
        data: {
          questions: [
            {
              id: "q-0123456789ab",
              question: "Which queue does forge-ledger read?",
              repo: "forge-ledger",
            },
            { id: "q-answered", question: "Done already", repo: "forge-cards", state: "answered" },
          ],
        },
      },
      onRetry: retry,
    });
    expect(text(list.tree)).toContain(P.questions.intro(1));
    expect(text(list.tree)).not.toContain("Done already");
    const links = els(list.tree).filter((e) => e.type === "a");
    expect(links.map((l) => l.props.href)).toEqual(["#/questions", "#/questions/q-0123456789ab"]);
    expect(links[1]!.props["aria-label"]).toBe(
      P.questions.answerLabel("Which queue does forge-ledger read?"),
    );
  });

  it("Problems: loading, each source's error, empty, and failed runs, blocking findings and rejects", () => {
    const base = {
      problems: problemsOf({ entries: [] }),
      onShow: () => undefined,
      onRetry: vi.fn(),
    };
    const loading = mount(ProblemsList, {
      ...base,
      findings: { state: "loading" },
      trust: { state: "loading" },
    });
    expect(text(loading.tree)).toBe(P.problems.loading);
    const err = mount(ProblemsList, {
      ...base,
      findings: { state: "error", error: "offline" },
      trust: { state: "error", error: "unreadable" },
    });
    expect(byRole(err.tree, "alert").map((x) => text(x))).toEqual([
      P.problems.findingsFailed("offline"),
      P.problems.trustFailed("unreadable"),
    ]);
    (button(err.tree, P.retry)!.props.onClick as () => void)();
    expect(base.onRetry).toHaveBeenCalled();
    const ready = { state: "ready" as const, data: null };
    expect(text(mount(ProblemsList, { ...base, findings: ready, trust: ready }).tree)).toBe(
      P.problems.empty,
    );

    const problems = problemsOf({
      entries: [entry(), verify, synced],
      findings: [
        {
          id: "f-1",
          gate: "design",
          severity: "blocking",
          artifact: "design.md",
          summary: "The design names no owner for forge-ledger's queue",
          state: "open",
          change: "add-transfer-limit",
        },
        {
          id: "f-2",
          gate: "design",
          severity: "risk",
          artifact: "design.md",
          summary: "A risk",
          state: "open",
        },
      ],
      trust: {
        repos: [
          {
            repo: "forge-cards",
            state: "rejected",
            verify: { report: { rejected: 3 } },
            next: { command: "atticus verify forge-cards" },
          },
          { repo: "forge-ledger", state: "trusted", verify: { report: { rejected: 0 } } },
        ] as unknown as Api.TrustViewT["repos"],
      },
    });
    expect(problems.failed.map((e) => e.id)).toEqual([verify.id]);
    expect(problems.blocking.map((f) => f.id)).toEqual(["f-1"]);
    expect(problems.blocking[0]!.href).toBe("#/arch-review?change=add-transfer-limit");
    expect(problems.rejected).toEqual([
      { repo: "forge-cards", count: 3, command: "atticus verify forge-cards" },
    ]);
    const m = mount(ProblemsList, { ...base, problems, findings: ready, trust: ready });
    const out = text(m.tree);
    for (const w of [
      P.problems.failedRuns,
      P.problems.blocking,
      P.problems.rejected,
      "atticus verify --all --write",
      T.exitCode(1),
      "The design names no owner for forge-ledger's queue",
      P.problems.rejectedFacts("forge-cards", 3),
      P.problems.fixThenVerify("atticus verify forge-cards"),
    ])
      expect(out).toContain(w);
    expect(out).not.toContain("A risk");
    expect(
      els(m.tree)
        .filter((e) => e.type === "a")
        .map((a) => a.props.href),
    ).toEqual(["#/arch-review?change=add-transfer-limit", "#/trust"]);
  });

  it("Runs: the Console's own states, else every run with the one shown marked", () => {
    expect(
      ofType(
        mount(RunsList, { a: ctx({ entries: [] }), onPick: () => undefined }).tree,
        ActivityStates,
      ),
    ).toHaveLength(1);
    const m = mount(RunsList, { a: ctx(), shown: "job-1", onPick: () => undefined });
    const rows = els(m.tree).filter((e) => e.type === "button");
    expect(rows.map((r) => r.props.id)).toEqual([
      "bp-run-job-1",
      `bp-run-${verify.id}`,
      "bp-run-job-0",
    ]);
    expect(rows.map((r) => r.props["aria-current"])).toEqual(["true", undefined, undefined]);
    const list = els(m.tree).find((e) => e.type === "ul")!;
    expect(list.props["aria-label"]).toBe(P.runs.label);
    expect(list.props["aria-describedby"]).toBe("bp-runs-hint");
  });
});

describe("the classic Console and strip", () => {
  it("still pick an entry from the Console's list and open the Console from the strip", () => {
    const m = mount(ActivityConsole, {});
    const items = byRole(m.tree, "tab");
    expect(items).toHaveLength(3);
    (items[1]!.props.onClick as () => void)();
    expect(calls.select).toEqual([verify.id]);
    // The entry shown is the shared view, as before.
    expect(ofType(m.tree, ActivityEntryView)).toHaveLength(1);
    const toggle = els(m.tree).find((e) => e.props.id === "run-console-toggle")!;
    (toggle.props.onClick as () => void)();
    expect(calls.open).toEqual([false]);
  });
});
