import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { all, mount } from "./support/hooks.js";

/**
 * Beta.26's second review of the IDE shell (ADR 0194): an editor panel other than VS Code's,
 * Escape in Ctrl+K over the narrow window's side panel, counts that go stale, tab ids, a closed
 * tab's draft, focus with the side panel over the page, the side panel's resizer, pins when
 * storage is full, the starting address, and focus after closing a tab or switching layout.
 * Rendered with the tiny hooks runtime, no DOM. Invented Forge names.
 */

vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});

const answers = new Map<string, unknown>();
const asked: string[] = [];
vi.mock("../src/api/client.js", async () => {
  const real = await vi.importActual<typeof import("../src/api/client.js")>("../src/api/client.js");
  return {
    ...real,
    api: async (path: string) => {
      asked.push(path);
      return answers.get(path) ?? [];
    },
    useFileChanges: () => undefined,
  };
});

const { useLastAnswer } = await import("../src/api/client.js");
const { panelHost, inEditorPanel, HOST_KEY } = await import("../src/app/shell/host.js");
const { overlayEscape, Resizer, Shell } = await import("../src/app/shell/Shell.js");
const { CommandPalette, OPEN_PALETTE } = await import("../src/app/palette.js");
const { forgetExplorerAnswers, QUIET_MS, useKnownAnswer, useLazyApi } =
  await import("../src/app/shell/explorer-data.js");
const { DraftShelf } = await import("../src/app/shell/drafts.js");
const { PINS_KEY, togglePin, readPinsOr } = await import("../src/app/shell/pinned-pages.js");
const { startHash, TABS_KEY, initialTabs, openTab } =
  await import("../src/app/shell/tabs-model.js");
const { TabStrip, tabId } = await import("../src/app/shell/TabStrip.js");
const { focusAfterLayoutSwitch } = await import("../src/app/shell/layout.js");
const { screenOf } = await import("../src/app/screens.js");
const { Explorer } = await import("../src/app/shell/Explorer.js");
const { domId, focusAfterUnpin, pinnedItems, PIN_BUTTON_ID, visibleRows } =
  await import("../src/app/shell/explorer-model.js");

type Store = {
  saved: Record<string, string>;
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
};
function storage(
  o: { init?: Record<string, string>; reads?: boolean; writes?: boolean } = {},
): Store {
  const saved = { ...o.init };
  return {
    saved,
    getItem: (k) => {
      if (o.reads === false) throw new Error("SecurityError");
      return saved[k] ?? null;
    },
    setItem: (k, v) => {
      if (o.writes === false) throw new Error("QuotaExceededError");
      saved[k] = v;
    },
  };
}

/** Elements a test can focus, by id, and the order they were focused in. */
function fakeDocument() {
  const focused: string[] = [];
  const scrolled: [string, unknown][] = [];
  const body = { id: "body", isConnected: true, focus: () => undefined };
  type El = {
    id: string;
    isConnected: boolean;
    focus(): void;
    querySelector(q: string): El | null;
    scrollIntoView(o?: unknown): void;
    contains(x: unknown): boolean;
  };
  const made = new Map<string, El>();
  const el = (id: string): El => {
    const got = made.get(id);
    if (got) return got;
    const e: El = {
      id,
      isConnected: true,
      focus: () => {
        focused.push(id);
        doc.activeElement = e;
      },
      querySelector: (q: string) => el(`${id} ${q}`),
      scrollIntoView: (o?: unknown) => void scrolled.push([id, o]),
      contains: (x: unknown) => typeof (x as El)?.id === "string" && (x as El).id.startsWith(id),
    };
    made.set(id, e);
    return e;
  };
  const doc = {
    focused,
    scrolled,
    body,
    activeElement: body as unknown,
    el,
    getElementById: (id: string) => el(id),
    querySelector: (_q: string): unknown => null,
  };
  return doc;
}

let win: EventTarget;
let doc: ReturnType<typeof fakeDocument>;
let frames: (() => void)[];
const flushFrames = () => {
  const f = frames;
  frames = [];
  for (const x of f) x();
};

beforeEach(() => {
  win = new EventTarget();
  doc = fakeDocument();
  frames = [];
  answers.clear();
  asked.length = 0;
  forgetExplorerAnswers();
  vi.stubGlobal("addEventListener", win.addEventListener.bind(win));
  vi.stubGlobal("removeEventListener", win.removeEventListener.bind(win));
  vi.stubGlobal("dispatchEvent", win.dispatchEvent.bind(win));
  vi.stubGlobal("document", doc);
  vi.stubGlobal("requestAnimationFrame", (f: () => void) => frames.push(f));
  vi.stubGlobal("localStorage", storage());
  vi.stubGlobal("sessionStorage", storage());
});
afterEach(() => vi.unstubAllGlobals());

const els = (t: unknown) => all(t);

describe("1. IntelliJ's tool window is an editor's panel too", () => {
  it("knows the panel from ?host=intellij, and keeps it for the session", () => {
    const s = storage();
    expect(panelHost("?host=intellij", s)).toBe("intellij");
    expect(s.saved[HOST_KEY]).toBe("intellij");
    // In-app navigation (or a link to the app's root) loses the query: the session keeps it.
    expect(panelHost("", s)).toBe("intellij");
    expect(panelHost("?x=1", s)).toBe("intellij");
  });

  it("is no panel in a plain browser, nor for a host it doesn't know", () => {
    expect(panelHost("", storage())).toBeUndefined();
    expect(panelHost("?host=evil", storage())).toBeUndefined();
    expect(panelHost("?host=intellij&x=1", storage())).toBe("intellij");
  });

  it("keeps it for the page's life when session storage refuses", () => {
    const refuses = storage({ reads: false, writes: false });
    expect(panelHost("?host=intellij", refuses)).toBe("intellij");
    expect(panelHost("", refuses)).toBe("intellij");
  });

  it("leaves out the IDE chrome in IntelliJ's panel, as in VS Code's", () => {
    vi.stubGlobal("location", { search: "?host=intellij", hash: "#/home" });
    expect(inEditorPanel()).toBe(true);
    vi.stubGlobal("location", { search: "", hash: "#/home" });
    vi.stubGlobal("sessionStorage", storage());
    expect(inEditorPanel()).toBe(false);
  });
});

describe("2. Escape in Ctrl+K leaves the side panel over the page open", () => {
  const ev = (o: { defaultPrevented?: boolean; inDialog?: boolean; key?: string }) => ({
    key: o.key ?? "Escape",
    defaultPrevented: !!o.defaultPrevented,
    target: { closest: (q: string) => (o.inDialog && q.includes("dialog") ? {} : null) },
  });

  it("closes the overlay only for an Escape nothing else took", () => {
    expect(overlayEscape(ev({}))).toBe(true);
    expect(overlayEscape(ev({ key: "Enter" }))).toBe(false);
    expect(overlayEscape(ev({ defaultPrevented: true }))).toBe(false);
    // A dialog React already took away still has its input inside it.
    expect(overlayEscape(ev({ inDialog: true }))).toBe(false);
    expect(overlayEscape({ key: "Escape", defaultPrevented: false, target: null })).toBe(true);
  });

  it("has Ctrl+K take its Escape, so the overlay's listener lets it be", () => {
    const m = mount(CommandPalette, {});
    win.dispatchEvent(new Event(OPEN_PALETTE));
    m.render();
    const dialog = els(m.tree).find((e) => e.props.role === "dialog")!;
    const prevent = vi.fn();
    (dialog.props.onKeyDown as (e: unknown) => void)({ key: "Escape", preventDefault: prevent });
    m.render();
    expect(prevent).toHaveBeenCalled();
    expect(els(m.tree).find((e) => e.props.role === "dialog")).toBeUndefined();
  });
});

describe("3. the Explorer's and the shell's counts keep up", () => {
  const PATH = "/api/questions?state=open";
  function Probe() {
    const l = useLazyApi<{ questions: unknown[] }>(PATH, true, false);
    const last = useLastAnswer<{ questions: unknown[] }>(PATH);
    return { l, last };
  }
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("reads again on showing a kept answer, showing the kept one meanwhile", async () => {
    answers.set(PATH, { questions: [1, 2] });
    let m = mount(Probe, {});
    await settle();
    m.render();
    expect(asked).toEqual([PATH]);
    // The panel shown again: the kept answer at once, and a read for a fresh one.
    answers.set(PATH, { questions: [1, 2, 3] });
    m = mount(Probe, {});
    const first = m.tree as { l: { state: string; data?: { questions: unknown[] } } };
    expect(first.l.state).toBe("ready");
    expect(first.l.data!.questions).toHaveLength(2);
    await settle();
    m.render();
    expect(asked).toEqual([PATH, PATH]);
    expect((m.tree as { l: { data: { questions: unknown[] } } }).l.data.questions).toHaveLength(3);
  });

  it("tells the badge and the status bar what it read", async () => {
    answers.set(PATH, { questions: [1, 2, 3, 4] });
    const m = mount(Probe, {});
    await settle();
    m.render();
    expect((m.tree as { last?: { questions: unknown[] } }).last?.questions).toHaveLength(4);
  });

  it("beta.27: has the status bar's counts on every page, never asking twice for one a page read", async () => {
    const TRUST = "/api/trust";
    const Known = () => useKnownAnswer<{ repos: unknown[] }>(TRUST);
    // A page that doesn't read /api/trust (beta.26: the repos showed on Home only): the shell
    // reads it once the page is quiet.
    forgetExplorerAnswers();
    asked.length = 0;
    answers.set(TRUST, { repos: [1, 2, 3, 4, 5, 6, 7] });
    let m = mount(Known, {});
    expect(m.tree).toBeUndefined();
    await new Promise((r) => setTimeout(r, QUIET_MS + 50));
    m.render();
    expect(asked).toEqual([TRUST]);
    expect((m.tree as { repos: unknown[] }).repos).toHaveLength(7);
    // A page that read it already (Home): its answer, and no request of the shell's own.
    asked.length = 0;
    m = mount(Known, {});
    await new Promise((r) => setTimeout(r, QUIET_MS + 50));
    m.render();
    expect(asked).toEqual([]);
    expect((m.tree as { repos: unknown[] }).repos).toHaveLength(7);
    // An editor's panel has no status bar: nothing is read.
    forgetExplorerAnswers();
    const Off = () => useKnownAnswer<{ repos: unknown[] }>("/api/trust?off", false);
    m = mount(Off, {});
    await new Promise((r) => setTimeout(r, QUIET_MS + 50));
    m.render();
    expect(asked).toEqual([]);
  });
});

describe("6. a closed tab's draft is gone", () => {
  const d = (t: string) => ({ fields: { "#brief-text": t }, scroll: 0 });

  it("keeps a page's draft when it is left, and gives it back once", () => {
    const s = new DraftShelf();
    s.leave("change:add-limit|stories", d("Limit transfers"));
    expect(s.take("change:add-limit|stories")).toEqual(d("Limit transfers"));
    expect(s.take("change:add-limit|stories")).toBeUndefined();
    s.leave("canvas|canvas", d("x"));
    s.leave("canvas|canvas", undefined);
    expect(s.take("canvas|canvas")).toBeUndefined();
  });

  it("forgets every page's draft of a closed tab, and not another tab's", () => {
    const s = new DraftShelf();
    s.leave("change:add-limit|stories", d("a"));
    s.leave("change:add-limit|design", d("b"));
    s.leave("change:add-limit.v2|stories", d("c"));
    s.close("change:add-limit", false);
    expect(s.take("change:add-limit|stories")).toBeUndefined();
    expect(s.take("change:add-limit|design")).toBeUndefined();
    expect(s.take("change:add-limit.v2|stories")).toEqual(d("c"));
  });

  it("doesn't keep the draft of the tab shown as it closes, and keeps the next one left", () => {
    const s = new DraftShelf();
    s.close("change:add-limit", true);
    // Closing the shown tab moves the address: its page is left, but it is closing.
    s.leave("change:add-limit|stories", d("typed before closing"));
    expect(s.take("change:add-limit|stories")).toBeUndefined();
    // Opened again later and left: kept as any page is.
    s.leave("change:add-limit|stories", d("typed again"));
    expect(s.take("change:add-limit|stories")).toEqual(d("typed again"));
  });
});

describe("9. pins stay when storage is full", () => {
  it("shows this page's pins once a write was refused, though reading still works", () => {
    const full = storage({ init: { [PINS_KEY]: JSON.stringify(["#/trust"]) }, writes: false });
    expect(togglePin("#/knowledge", full)).toEqual(["#/trust", "#/knowledge"]);
    expect(readPinsOr(full)).toEqual(["#/trust", "#/knowledge"]);
    expect(togglePin("#/trust", full)).toEqual(["#/knowledge"]);
    expect(readPinsOr(full)).toEqual(["#/knowledge"]);
  });

  it("reads storage's pins while writes work", () => {
    const s = storage();
    togglePin("#/trust", s);
    s.saved[PINS_KEY] = JSON.stringify(["#/runs"]);
    // Another window pinned: storage is the truth.
    expect(readPinsOr(s)).toEqual(["#/runs"]);
  });
});

describe("10. no address opens the tab that was shown, before anything draws", () => {
  const kept = (hash: string) => {
    const s = openTab(initialTabs(), hash);
    return storage({
      init: {
        [TABS_KEY]: JSON.stringify({
          active: s.active,
          tabs: s.tabs.map((t) => ({ key: t.key, hash: t.hash })),
        }),
      },
    });
  };

  it("starts on the shown tab's address, never on Home first", () => {
    expect(startHash("", kept("#/canvas"))).toBe("#/canvas");
    expect(startHash("#", kept("#/canvas"))).toBe("#/canvas");
    expect(startHash("#/", kept("#/canvas"))).toBe("#/canvas");
  });

  it("keeps an address it was given, and Home's empty one when nothing was kept", () => {
    expect(startHash("#/trust", kept("#/canvas"))).toBe("#/trust");
    expect(startHash("", storage())).toBe("");
    expect(startHash("", storage({ reads: false }))).toBe("");
    expect(startHash("", kept("#/home"))).toBe("");
  });
});

describe("11. focus after closing a tab by mouse, or switching layout", () => {
  let s = initialTabs();
  s = openTab(s, "#/canvas");
  s = openTab(s, "#/changes/add-transfer-limit");
  const strip = (onClose: (k: string) => void) =>
    mount(TabStrip, { state: s, onShow: () => undefined, onClose, onMove: () => undefined });
  const tab = (tree: unknown, key: string) => els(tree).find((e) => e.props.id === tabId(key))!;
  const x = (tree: unknown, key: string) =>
    els(tab(tree, key).props.children).find((e) => e.props.className === "sh-tab-x")!;

  it("focuses the tab shown next after the shown tab's × is clicked", () => {
    const closed: string[] = [];
    const m = strip((k) => closed.push(k));
    (x(m.tree, "change:add-transfer-limit").props.onClick as (e: unknown) => void)({
      stopPropagation: () => undefined,
    });
    expect(closed).toEqual(["change:add-transfer-limit"]);
    flushFrames();
    expect(doc.focused).toEqual([tabId("canvas")]);
  });

  it("focuses the tab shown after a middle click closes another, if focus was lost", () => {
    const m = strip(() => undefined);
    (tab(m.tree, "canvas").props.onAuxClick as (e: unknown) => void)({
      button: 1,
      preventDefault: () => undefined,
    });
    flushFrames();
    expect(doc.focused).toEqual([tabId("change:add-transfer-limit")]);
  });

  it("leaves the focus where it is when it wasn't lost", () => {
    const m = strip(() => undefined);
    doc.activeElement = doc.el("brief-text");
    (tab(m.tree, "canvas").props.onAuxClick as (e: unknown) => void)({
      button: 1,
      preventDefault: () => undefined,
    });
    flushFrames();
    expect(doc.focused).toEqual([]);
  });

  it("puts the focus back on the layout picked, else on the page, after switching", () => {
    const picked = doc.el("layout-ide");
    const d = {
      body: doc.body,
      activeElement: doc.body as unknown,
      getElementById: doc.getElementById,
      querySelector: (q: string) => (q.includes('name="layout"') ? picked : null),
    };
    focusAfterLayoutSwitch(d);
    expect(doc.focused).toEqual(["layout-ide"]);
    d.querySelector = () => null;
    d.activeElement = doc.body;
    focusAfterLayoutSwitch(d);
    expect(doc.focused).toEqual(["layout-ide", "main"]);
    // Focus that is still on the page stays.
    d.activeElement = doc.el("palette-input");
    focusAfterLayoutSwitch(d);
    expect(doc.focused).toEqual(["layout-ide", "main"]);
  });
});

describe("7. focus with the side panel over the page", () => {
  const narrow = (on: boolean) =>
    vi.stubGlobal("matchMedia", () => ({
      matches: on,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
  const loc = { hash: "#/home", search: "", replace: () => undefined };
  const shell = () =>
    mount(Shell, {
      hash: loc.hash,
      current: screenOf(loc.hash),
      embedded: false,
      heading: "Home",
      children: null,
    });
  /** Open the overlay from the tab strip's side button, its refs given elements. */
  const openOverlay = (m: ReturnType<typeof shell>) => {
    const holder = els(m.tree).find(
      (e) => e.props.ref && (e.props.children as { type?: unknown })?.type === TabStrip,
    )!;
    (holder.props.ref as { current: unknown }).current = doc.el("tabbar");
    const strip = els(m.tree).find((e) => e.type === TabStrip)!;
    (strip.props.side as { onToggle(): void }).onToggle();
    m.render();
    expect(els(m.tree).some((e) => e.props.className === "sh-scrim")).toBe(true);
    doc.focused.length = 0;
  };
  const overlayOpen = (m: ReturnType<typeof shell>) =>
    els(m.tree).some((e) => e.props.className === "sh-scrim");

  beforeEach(() => {
    narrow(true);
    loc.hash = "#/home";
    vi.stubGlobal("location", loc);
  });

  it("gives the focus back to the side button when the scrim is clicked", () => {
    const m = shell();
    openOverlay(m);
    const scrim = els(m.tree).find((e) => e.props.className === "sh-scrim")!;
    (scrim.props.onClick as () => void)();
    m.render();
    expect(overlayOpen(m)).toBe(false);
    expect(doc.focused).toEqual(["tabbar [aria-controls='sh-side']"]);
  });

  it("closes and focuses the page after an Explorer item is opened", () => {
    const m = shell();
    openOverlay(m);
    const ex = els(m.tree).find((e) => e.type === Explorer)!;
    (ex.props.onOpen as (h: string) => void)("#/trust");
    m.render();
    expect(loc.hash).toBe("#/trust");
    expect(overlayOpen(m)).toBe(false);
    expect(doc.focused.at(-1)).toBe("main");
  });

  it("closes when the address moves (the activity bar, a link), focusing the page if it was in it", () => {
    const m = shell();
    openOverlay(m);
    doc.activeElement = doc.el("sh-side a[href]");
    loc.hash = "#/questions";
    win.dispatchEvent(new Event("hashchange"));
    m.render();
    expect(overlayOpen(m)).toBe(false);
    expect(doc.focused.at(-1)).toBe("main");
  });
});

describe("8. the side panel's resizer", () => {
  type L = Record<string, (e?: unknown) => void>;
  const handle = () => {
    const on: L = {};
    return {
      on,
      setPointerCapture: vi.fn(),
      addEventListener: (n: string, f: (e?: unknown) => void) => void (on[n] = f),
      removeEventListener: (n: string) => void delete on[n],
    };
  };
  const down = (el: ReturnType<typeof handle>, button = 0) => ({
    button,
    clientX: 300,
    pointerId: 1,
    currentTarget: el,
    preventDefault: () => undefined,
  });

  it("takes only the main button", () => {
    const onResize = vi.fn();
    const m = mount(Resizer, { width: 260, onResize, onLive: () => undefined });
    const el = handle();
    const sep = els(m.tree).find((e) => e.props.role === "separator")!;
    (sep.props.onPointerDown as (e: unknown) => void)(down(el, 2));
    expect(el.setPointerCapture).not.toHaveBeenCalled();
    expect(Object.keys(el.on)).toEqual([]);
  });

  it("ends a drag the browser cancels, keeping the width it had, and lets go of its listeners", () => {
    const onResize = vi.fn();
    const onLive = vi.fn();
    const m = mount(Resizer, { width: 260, onResize, onLive });
    const el = handle();
    const sep = els(m.tree).find((e) => e.props.role === "separator")!;
    (sep.props.onPointerDown as (e: unknown) => void)(down(el));
    expect(Object.keys(el.on).sort()).toEqual(
      ["lostpointercapture", "pointercancel", "pointermove", "pointerup"].sort(),
    );
    el.on.pointermove!({ clientX: 340 });
    expect(onLive).toHaveBeenLastCalledWith(300);
    el.on.pointercancel!();
    expect(onResize).toHaveBeenCalledWith(300);
    expect(Object.keys(el.on)).toEqual([]);
  });

  it("ends once when capture is lost after letting go", () => {
    const onResize = vi.fn();
    const m = mount(Resizer, { width: 260, onResize, onLive: () => undefined });
    const el = handle();
    const sep = els(m.tree).find((e) => e.props.role === "separator")!;
    (sep.props.onPointerDown as (e: unknown) => void)(down(el));
    const lost = el.on.lostpointercapture!;
    el.on.pointerup!({ clientX: 280 });
    lost();
    expect(onResize).toHaveBeenCalledTimes(1);
  });

  it("is not scrolled away by a touch", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(new URL("../src/app/shell/shell.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.sh-resizer\s*\{[^}]*touch-action:\s*none/);
  });
});

describe("A. the tab shown stays in the strip's view", () => {
  it("scrolls the selected tab into view, along the strip only", () => {
    let s = initialTabs();
    for (const h of ["#/canvas", "#/trust", "#/runs", "#/scans", "#/changes/add-transfer-limit"])
      s = openTab(s, h);
    mount(TabStrip, {
      state: s,
      onShow: () => undefined,
      onClose: () => undefined,
      onMove: () => undefined,
    });
    expect(doc.scrolled).toEqual([
      [tabId("change:add-transfer-limit"), { inline: "nearest", block: "nearest" }],
    ]);
    doc.scrolled.length = 0;
    mount(TabStrip, {
      state: { ...s, active: "canvas" },
      onShow: () => undefined,
      onClose: () => undefined,
      onMove: () => undefined,
    });
    expect(doc.scrolled.map(([id]) => id)).toEqual([tabId("canvas")]);
  });
});

describe("C. Delete on a pinned page keeps the focus in the Explorer", () => {
  const rows = (pins: string[]) => visibleRows("pinned", pinnedItems(pins), new Set());

  it("goes to the next pinned page, else the one before, else the Pin button", () => {
    const three = rows(["#/trust", "#/runs", "#/scans"]);
    expect(focusAfterUnpin(three, "#/trust")).toBe(domId("pinned/#/runs"));
    expect(focusAfterUnpin(three, "#/scans")).toBe(domId("pinned/#/runs"));
    const one = rows(["#/trust"]);
    expect(focusAfterUnpin(one, "#/trust")).toBe(PIN_BUTTON_ID);
  });

  it("moves the browser's focus there once the pins are read again", () => {
    vi.stubGlobal("localStorage", storage({ init: { [PINS_KEY]: JSON.stringify(["#/trust"]) } }));
    const m = mount(Explorer, { current: "#/home", onOpen: () => undefined });
    const view = m.tree as { props: Record<string, unknown> };
    (view.props.onTreeFocus as (s: string, i: string) => void)("pinned", "pinned/#/trust");
    m.render();
    const v2 = m.tree as { props: Record<string, unknown> };
    (v2.props.onTreeKey as (s: string, e: unknown) => void)("pinned", {
      key: "Delete",
      preventDefault: () => undefined,
    });
    m.render();
    expect(doc.focused).toEqual([PIN_BUTTON_ID]);
  });
});
