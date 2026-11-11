import { useEffect, useRef, useState, type ReactNode } from "react";
import { COPY } from "../../copy.js";
import { useActivity, titleOf } from "../activity.js";
import { AiChip, Person, ThemeSwitch, type Health } from "../chrome.js";
import { useMe } from "../me.js";
import { screenOf, type ScreenDef } from "../screens.js";
import { replayTour } from "../tour.js";
import { readViewerRole } from "../../screens/RoleQuestions.js";
import { ActivityBar, MoreFlyout } from "./ActivityBar.js";
import { BottomPanel } from "./BottomPanel.js";
import {
  DraftShelf,
  draftOf,
  typedOf,
  fieldKey,
  fieldsIn,
  keptField,
  openToggles,
  restoreDraft,
  togglesIn,
} from "./drafts.js";
import {
  OWNER_QUESTIONS_PATH,
  questionsToAnswerOf,
  STEP_QUESTIONS_PATH,
  type OwnerQuestionsAnswer,
  type StepQuestionsAnswer,
} from "../question-counts.js";
import { Explorer } from "./Explorer.js";
import { useKnownAnswer } from "./explorer-data.js";
import { PinIcon, SearchIcon, Tip } from "./icons.js";
import { pinHash, togglePin, usePins } from "./pinned-pages.js";
import {
  clampSide,
  readBottom,
  readSide,
  saveBottom,
  saveSide,
  SIDE_MAX,
  SIDE_MIN,
  type SidePrefs,
} from "./layout.js";
import { healthFacts, StatusBar, type StatusFacts } from "./StatusBar.js";
import { PANEL_ID, TabStrip, tabId } from "./TabStrip.js";
import {
  closeTab,
  moveTab,
  openTab,
  readTabs,
  restoreTabs,
  saveTabs,
  tabKeyOf,
  type TabsState,
} from "./tabs-model.js";
import { openPalette, TitleBar } from "./TitleBar.js";
import "./shell.css";

const T = COPY.ide;

/**
 * Whether the page just shown came from the tab strip: focus then stays on the tab (the app
 * otherwise moves it to the page, so a keyboard user starts there).
 */
let fromTabs = false;
export const takeTabSwitch = (): boolean => {
  const v = fromTabs;
  fromTabs = false;
  return v;
};

/** Go to an address from the tab strip. */
function goFromTabs(hash: string): void {
  if (location.hash === hash) return;
  fromTabs = true;
  location.hash = hash;
}

function useMedia(query: string): boolean {
  const mq = () => (typeof matchMedia === "function" ? matchMedia(query) : undefined);
  const [on, set] = useState(() => !!mq()?.matches);
  useEffect(() => {
    const m = mq();
    if (!m) return;
    const f = () => set(m.matches);
    f();
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, [query]);
  return on;
}

/**
 * The tabs, following the address; kept per browser. Opened with no address, the app starts on
 * the tab that was shown: App picks it before the first render (startHash).
 */
export function useTabs(hash: string): [TabsState, (s: TabsState) => void] {
  const [tabs, setTabs] = useState<TabsState>(() => restoreTabs(readTabs(), hash));
  useEffect(() => setTabs((s) => openTab(s, hash)), [hash]);
  useEffect(() => saveTabs(tabs), [tabs]);
  return [tabs, setTabs];
}

/** A page's place for its draft: the tab it is in and the page. */
const draftKeyOf = (hash: string) => `${tabKeyOf(hash)}|${screenOf(hash).id}`;

/**
 * Keep what the person typed into a page and how far it was scrolled when they leave it for
 * another tab or page, and put it back when they return (drafts.ts). Returns what to call as a
 * tab closes: its drafts go with it.
 */
function useDrafts(
  hash: string,
  panel: React.RefObject<HTMLDivElement | null>,
  scroller: React.RefObject<HTMLElement | null>,
): (tabKey: string, shown: boolean) => void {
  const drafts = useRef(new DraftShelf());
  const changed = useRef(new Set<string>());
  const shown = useRef(draftKeyOf(hash));
  // What the person changes, as they change it.
  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    const on = (e: Event) => {
      const t = e.target as HTMLInputElement | null;
      if (!e.isTrusted || !t || !keptField(t)) return;
      changed.current.add(fieldKey(t, fieldsIn(el)));
    };
    el.addEventListener("input", on, true);
    el.addEventListener("change", on, true);
    return () => {
      el.removeEventListener("input", on, true);
      el.removeEventListener("change", on, true);
    };
  }, [panel]);
  // Before the next page is drawn (a hashchange runs before React renders), keep this one's.
  useEffect(() => {
    const keep = () => {
      const next = draftKeyOf(location.hash);
      if (next === shown.current || !panel.current) return;
      const d = draftOf(
        fieldsIn(panel.current),
        changed.current,
        scroller.current?.scrollTop ?? 0,
        openToggles(togglesIn(panel.current)),
      );
      drafts.current.leave(shown.current, d);
      changed.current = new Set();
    };
    addEventListener("hashchange", keep);
    return () => removeEventListener("hashchange", keep);
  }, [panel, scroller]);
  // The page shown now: put its draft back, or start it at the top.
  useEffect(() => {
    const key = draftKeyOf(hash);
    if (key === shown.current) return;
    shown.current = key;
    drafts.current.shown();
    const d = drafts.current.take(key);
    if (!d || !panel.current || !scroller.current) {
      if (scroller.current) scroller.current.scrollTop = 0;
      return;
    }
    changed.current = typedOf(d);
    return restoreDraft(panel.current, scroller.current, d);
  }, [hash, panel, scroller]);
  return (tabKey, shownTab) => drafts.current.close(tabKey, shownTab);
}

/**
 * Whether an Escape closes the side panel over the page: not one something else took (Ctrl+K
 * prevents its own), nor one from inside a dialog (React may have taken the dialog away before
 * the window hears the key, but its input is still inside it).
 */
export function overlayEscape(e: {
  key: string;
  defaultPrevented?: boolean;
  target: EventTarget | { closest?: (q: string) => unknown } | null;
}): boolean {
  if (e.key !== "Escape" || e.defaultPrevented) return false;
  const t = e.target as { closest?: (q: string) => unknown } | null;
  return !t?.closest?.("[role=dialog], [role=alertdialog]");
}

/**
 * Pin the page shown (beta.26): it is kept at hand in the Explorer's Pinned, per browser. A
 * toggle: pressed while the page is pinned, and a press unpins it.
 */
function PinTool({ hash, label }: { hash: string; label: string }) {
  const pins = usePins();
  const pinned = pins.includes(pinHash(hash));
  const name = COPY.explorer.pinHere(label);
  return (
    <button
      type="button"
      className="sh-tool"
      aria-pressed={pinned}
      aria-label={name}
      onClick={() => togglePin(hash)}
    >
      <Tip text={name} />
      <PinIcon filled={pinned} />
    </button>
  );
}

/**
 * The counts the shell shows (the badge, the status bar). Beta.27: the same on every page, not
 * only once a page loaded them: each is the answer a page already had, else the shell's own read
 * once the page is quiet (useKnownAnswer). The questions to answer are both kinds, counted as Home
 * and Questions count them (question-counts.ts); none until both are known.
 */
function useCounts(want: boolean): { questions?: number; repos?: number } {
  const steps = useKnownAnswer<StepQuestionsAnswer>(STEP_QUESTIONS_PATH, want);
  const owner = useKnownAnswer<OwnerQuestionsAnswer>(OWNER_QUESTIONS_PATH, want);
  const trust = useKnownAnswer<{ repos?: unknown[] }>(TRUST_PATH, want);
  return shellCounts(steps, owner, trust);
}

/** The status bar's repos: the manifest's, as Map › Trust lists them. */
export const TRUST_PATH = "/api/trust";

/** The shell's counts from the answers it has (tests give their own). */
export function shellCounts(
  steps: StepQuestionsAnswer | undefined,
  owner: OwnerQuestionsAnswer | undefined,
  trust: { repos?: unknown[] } | undefined,
): { questions?: number; repos?: number } {
  const q = questionsToAnswerOf(steps, owner);
  return {
    ...(q ? { questions: q.total } : {}),
    ...(Array.isArray(trust?.repos) ? { repos: trust.repos.length } : {}),
  };
}

/** The side panel's width and whether it shows, with a narrow window's overlay. */
function useSide(narrow: boolean) {
  const [prefs, setPrefs] = useState<SidePrefs>(() => readSide());
  const [overlay, setOverlay] = useState(false);
  const save = (p: SidePrefs) => {
    setPrefs(p);
    saveSide(p);
  };
  useEffect(() => {
    if (!narrow) setOverlay(false);
  }, [narrow]);
  const open = narrow ? overlay : !prefs.hidden;
  return {
    width: prefs.width,
    open,
    overlay: narrow && overlay,
    toggle: () => (narrow ? setOverlay(!overlay) : save({ ...prefs, hidden: !prefs.hidden })),
    close: () => setOverlay(false),
    resize: (w: number) => save({ ...prefs, width: clampSide(w) }),
    setWidth: (w: number) => setPrefs({ ...prefs, width: clampSide(w) }),
  };
}

/**
 * The handle between the side panel and the page: drag it (the main button; a drag the browser
 * cancels keeps the width reached, as the bottom panel's edge does), or use the arrow keys.
 */
export function Resizer({
  width,
  onResize,
  onLive,
}: {
  width: number;
  onResize: (w: number) => void;
  onLive: (w: number) => void;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={T.resize}
      aria-controls="sh-side"
      aria-valuemin={SIDE_MIN}
      aria-valuemax={SIDE_MAX}
      aria-valuenow={width}
      tabIndex={0}
      className="sh-resizer"
      onKeyDown={(e) => {
        const by = e.key === "ArrowLeft" ? -16 : e.key === "ArrowRight" ? 16 : undefined;
        if (by !== undefined) {
          e.preventDefault();
          onResize(width + by);
        } else if (e.key === "Home" || e.key === "End") {
          e.preventDefault();
          onResize(e.key === "Home" ? SIDE_MIN : SIDE_MAX);
        }
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const x0 = e.clientX;
        const w0 = width;
        const el = e.currentTarget;
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          // A pointer the page can't capture: the drag still follows while over the handle.
        }
        let w = w0;
        let done = false;
        const move = (m: PointerEvent) => {
          w = clampSide(w0 + m.clientX - x0);
          onLive(w);
        };
        const end = () => {
          if (done) return;
          done = true;
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", end);
          el.removeEventListener("pointercancel", end);
          el.removeEventListener("lostpointercapture", end);
          onResize(w);
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", end);
        el.addEventListener("pointercancel", end);
        el.addEventListener("lostpointercapture", end);
      }}
    />
  );
}

/**
 * The IDE layout (ADR 0194): the title bar; the activity bar, the side panel and the page's
 * column (its tabs, the page and the bottom panel); the status bar. One <main id="main"> holds
 * the page, the tab panel of the tab shown. In an editor's panel (VS Code has its own activity
 * bar, status bar and command box) the title, activity and status bars are left out; the side
 * panel, the tabs, More pages and Ctrl+K reach every page there. On a narrow window the side
 * panel lies over the page; on a phone's width the activity bar is a bar at the foot.
 */
export function Shell({
  hash,
  current,
  health,
  embedded,
  heading,
  top,
  children,
}: {
  hash: string;
  current: ScreenDef;
  health?: Health;
  /** In an editor's panel (VS Code). */
  embedded: boolean;
  /** The page's name, as the page's level-one heading (for a screen reader). */
  heading: string;
  /** Above the page: the flash line, the section's tabs, the server's note. */
  top?: ReactNode;
  children: ReactNode;
}) {
  const [tabs, setTabs] = useTabs(hash);
  const narrow = useMedia("(max-width: 999px)");
  const side = useSide(narrow);
  const [bottom, setBottom] = useState(() => readBottom() ?? false);
  const panel = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLElement>(null);
  const sideToggle = useRef<HTMLDivElement>(null);
  const forgetDrafts = useDrafts(hash, panel, scroller);
  const counts = useCounts(!embedded);
  const activity = useActivity();
  const { me } = useMe();
  const running = (activity?.entries ?? []).filter((e) => e.state === "running");
  const first = running[0];
  const role = readViewerRole();
  const facts: StatusFacts = {
    ...(health ? healthFacts(health, me ?? undefined) : {}),
    ...(role ? { role: COPY.roles.names[role] ?? role } : {}),
    ...counts,
    ...(first
      ? {
          running: {
            id: first.id,
            title: titleOf(first),
            ...(first.progress && first.progress.total > 1
              ? { done: first.progress.done, total: first.progress.total }
              : {}),
            more: running.length - 1,
          },
        }
      : {}),
  };
  const shownTab = tabs.active;
  const help = (
    <button type="button" className="btn" onClick={replayTour} title={COPY.shell.replayTheTour}>
      {COPY.shell.help}
    </button>
  );
  const words = (
    <a className="btn" href="#/words" title={COPY.glossary.linkTitle}>
      {COPY.glossary.link}
    </a>
  );
  // A narrow window's side panel lies over the page: opened, it takes the focus; Escape (from
  // anywhere) or the scrim closes it and gives the focus back to its button. Opening a page from
  // it, or any move of the address (the activity bar, a link), closes it too, and focus that was
  // in it goes to the page (review, beta.26: it fell to the body).
  const closeOverlay = (focus: "button" | "page" = "button") => {
    side.close();
    if (focus === "page") document.getElementById("main")?.focus({ preventScroll: true });
    else sideToggle.current?.querySelector<HTMLElement>("[aria-controls='sh-side']")?.focus();
  };
  const overlay = side.overlay;
  useEffect(() => {
    if (!overlay) return;
    document
      .getElementById("sh-side")
      ?.querySelector<HTMLElement>("a[href], button, input, [tabindex='0']")
      ?.focus();
    const esc = (e: KeyboardEvent) => {
      if (!overlayEscape(e) || document.querySelector("[role=dialog]")) return;
      e.preventDefault();
      closeOverlay();
    };
    const moved = () => {
      const inSide = document.getElementById("sh-side")?.contains(document.activeElement);
      if (inSide) closeOverlay("page");
      else side.close();
    };
    addEventListener("keydown", esc);
    addEventListener("hashchange", moved);
    return () => {
      removeEventListener("keydown", esc);
      removeEventListener("hashchange", moved);
    };
    // closeOverlay only closes and focuses: the overlay's being open decides it.
  }, [overlay]);
  return (
    <div
      className={`sh${embedded ? " sh-embedded" : ""}${side.open ? " sh-side-open" : ""}${side.overlay ? " sh-overlay" : ""}`}
      style={{ ["--sh-side" as string]: `${side.width}px` }}
    >
      {!embedded && (
        <TitleBar
          {...(health ? { root: health.root } : {})}
          right={
            <>
              <AiChip />
              <ThemeSwitch />
              {help}
              {words}
              {health && <Person health={health} version={false} />}
            </>
          }
        />
      )}
      <div className="sh-body">
        {!embedded && <ActivityBar current={current} hash={hash} badges={counts} />}
        <aside
          id="sh-side"
          className="sh-side"
          aria-label={COPY.explorer.label}
          hidden={!side.open}
        >
          {/* Hidden, it is not drawn at all: its names never stand beside the page's. */}
          {side.open && (
            <Explorer
              current={hash}
              onOpen={(h) => {
                const over = side.overlay;
                if (location.hash !== h) location.hash = h;
                // The Explorer goes with the overlay: the focus goes to the page opened.
                if (over) closeOverlay("page");
              }}
            />
          )}
        </aside>
        {side.open && !side.overlay && (
          <Resizer width={side.width} onResize={side.resize} onLive={side.setWidth} />
        )}
        {side.overlay && (
          <div className="sh-scrim" aria-hidden="true" onClick={() => closeOverlay()} />
        )}
        <div className="sh-column">
          <div ref={sideToggle}>
            <TabStrip
              state={tabs}
              onShow={(key) => {
                const t = tabs.tabs.find((x) => x.key === key);
                if (t) goFromTabs(t.hash);
              }}
              onClose={(key) => {
                forgetDrafts(key, key === tabs.active);
                const r = closeTab(tabs, key);
                setTabs(r.state);
                if (r.go) goFromTabs(r.go);
              }}
              onMove={(key, by) => setTabs(moveTab(tabs, key, by))}
              side={{ open: side.open, onToggle: side.toggle }}
              tools={
                <>
                  <PinTool hash={hash} label={current.label} />
                  {embedded && (
                    <>
                      <button
                        type="button"
                        className="sh-tool"
                        aria-label={T.search}
                        onClick={openPalette}
                      >
                        <Tip text={T.search} />
                        <SearchIcon size={16} />
                      </button>
                      <MoreFlyout current={current} hash={hash} className="sh-tool" />
                      <AiChip />
                      {help}
                      {words}
                      {/* Review (beta.26): who records are made as, and "Set your Git user". */}
                      {health && <Person health={health} version={false} />}
                    </>
                  )}
                </>
              }
            />
          </div>
          <main id="main" ref={scroller} className="sh-main" tabIndex={-1}>
            <div
              ref={panel}
              id={PANEL_ID}
              role="tabpanel"
              aria-labelledby={tabId(shownTab)}
              className="sh-page"
            >
              <h1 className="sr">{heading}</h1>
              {top}
              {children}
            </div>
          </main>
          <BottomPanel
            open={bottom}
            onToggle={() => {
              setBottom(!bottom);
              saveBottom(!bottom);
            }}
          />
        </div>
      </div>
      {!embedded && <StatusBar facts={facts} onShowRunning={(id) => activity?.show(id)} />}
    </div>
  );
}
