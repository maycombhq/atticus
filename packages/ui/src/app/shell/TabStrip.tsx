import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { COPY } from "../../copy.js";
import { SideIcon, Tip } from "./icons.js";
import { HOME_KEY, tabLabel, type TabsState } from "./tabs-model.js";

const T = COPY.ide;

/** The page panel the tabs control. */
export const PANEL_ID = "sh-panel";

/**
 * A tab's element id, from its key. A change's id may hold dots and underscores, so anything an
 * id can't hold is spelled out (as the Explorer's domId does), and two keys never share an id.
 */
export const tabId = (key: string): string =>
  `sh-tab-${key.replace(/[^A-Za-z0-9-]/g, (c) => `_${c.charCodeAt(0).toString(36)}_`)}`;

/**
 * After a tab is closed by mouse (its × or a middle click): the button pressed is gone, so focus
 * that fell to the page's body goes to `next` (the tab shown now), else to the page.
 */
function refocusAfterClose(next: string | undefined): void {
  requestAnimationFrame(() => {
    const a = document.activeElement as { isConnected?: boolean } | null;
    if (a && a !== document.body && a.isConnected !== false) return;
    const to =
      (next ? document.getElementById(tabId(next)) : null) ?? document.getElementById("main");
    to?.focus();
  });
}

/** Bring the tab shown into the strip's view when the strip scrolls sideways. */
function revealTab(key: string): void {
  try {
    const el = globalThis.document?.getElementById(tabId(key)) as
      (HTMLElement & { scrollIntoView?: (o?: ScrollIntoViewOptions) => void }) | null | undefined;
    el?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
  } catch {
    // No page (a test's render).
  }
}

/**
 * Beta.27 review: which tabs the strip doesn't show whole. `tabs` are each tab's left edge and
 * width in the strip's scrolled content, `view` the part shown (its scroll and width), and
 * `pinned` the width Home takes at the left, held there. A tab wholly out of view is `hidden`
 * (listed under "N more"); one partly in view is `cut` (its × isn't shown, never a bare ×).
 */
export function tabsOutOfView(
  tabs: readonly { key: string; left: number; width: number }[],
  view: { scroll: number; width: number },
  pinned = 0,
): { hidden: string[]; cut: string[] } {
  const from = view.scroll + pinned;
  const to = view.scroll + view.width;
  const hidden: string[] = [];
  const cut: string[] = [];
  for (const t of tabs) {
    if (t.key === HOME_KEY) continue;
    const right = t.left + t.width;
    if (right <= from + 1 || t.left >= to - 1) hidden.push(t.key);
    else if (t.left < from - 1 || right > to + 1) cut.push(t.key);
  }
  return { hidden, cut };
}

/** "N more": the tabs out of view, each shown on a click; Escape or a pick closes it. */
function MoreTabs(p: { keys: readonly string[]; state: TabsState; onShow: (key: string) => void }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>("button")?.focus();
  }, [open]);
  const tabs = p.state.tabs.filter((t) => p.keys.includes(t.key));
  if (!tabs.length) return null;
  const close = (back = true) => {
    setOpen(false);
    if (back) button.current?.focus();
  };
  return (
    <div className="sh-more">
      <button
        ref={button}
        type="button"
        className="sh-more-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={T.moreTabsLabel(tabs.length)}
        onClick={() => setOpen((o) => !o)}
      >
        {T.moreTabs(tabs.length)}
      </button>
      {open && (
        <ul
          ref={menu}
          role="menu"
          className="sh-more-menu"
          aria-label={T.moreTabsLabel(tabs.length)}
          onKeyDown={(e) => {
            const items = [...(menu.current?.querySelectorAll<HTMLElement>("button") ?? [])];
            const i = items.indexOf(document.activeElement as HTMLElement);
            if (e.key === "Escape") {
              e.preventDefault();
              close();
            } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const n = items.length;
              items[(i + (e.key === "ArrowDown" ? 1 : n - 1)) % n]?.focus();
            } else if (e.key === "Tab") close(false);
          }}
        >
          {tabs.map((t) => {
            const { label, title } = tabLabel(t);
            return (
              <li key={t.key} role="none">
                <button
                  type="button"
                  role="menuitem"
                  title={title}
                  onClick={() => {
                    setOpen(false);
                    p.onShow(t.key);
                    requestAnimationFrame(() => document.getElementById(tabId(t.key))?.focus());
                  }}
                >
                  {label}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * The tab strip (ADR 0194): a tab per open page, the one shown selected. A tablist: the arrow
 * keys, Home and End move between the tabs and Enter or Space shows one (the page loads only
 * then); Delete closes the focused tab (Home has no close); Ctrl+Shift+Left or Right moves it; a
 * middle click closes it. Before the tabs, the side panel's button; after them, `tools` (in an
 * editor's panel, the few title-bar buttons it has no title bar for).
 */
export function TabStrip({
  state,
  onShow,
  onClose,
  onMove,
  side,
  tools,
}: {
  state: TabsState;
  onShow: (key: string) => void;
  onClose: (key: string) => void;
  onMove: (key: string, by: -1 | 1) => void;
  side?: { open: boolean; onToggle: () => void };
  tools?: ReactNode;
}) {
  const list = useRef<HTMLDivElement>(null);
  // Review (beta.26): many tabs scroll the strip sideways; the one shown is kept in view.
  useEffect(() => revealTab(state.active), [state.active]);
  // Beta.27 review: the tabs out of view, listed under "N more"; a cut one shows no bare ×.
  const [out, setOut] = useState<{ hidden: string[]; cut: string[] }>({ hidden: [], cut: [] });
  const tabKeys = state.tabs.map((t) => t.key).join("\n");
  useEffect(() => {
    const el = list.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const tabs = [...el.querySelectorAll<HTMLElement>("[role=tab]")].map((b, i) => ({
        key: state.tabs[i]?.key ?? "",
        left: b.offsetLeft - el.offsetLeft,
        width: b.offsetWidth,
      }));
      const home = tabs.find((t) => t.key === HOME_KEY);
      const next = tabsOutOfView(
        tabs,
        { scroll: el.scrollLeft, width: el.clientWidth },
        home?.width ?? 0,
      );
      setOut((o) =>
        o.hidden.join() === next.hidden.join() && o.cut.join() === next.cut.join() ? o : next,
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    el.addEventListener("scroll", measure, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", measure);
    };
  }, [tabKeys, state.active]);
  /** The tab shown once `key` is closed: its right neighbour if it is shown, else the shown one. */
  const shownAfter = (key: string): string | undefined => {
    if (key !== state.active) return state.active;
    const i = state.tabs.findIndex((t) => t.key === key);
    return (state.tabs[i + 1] ?? state.tabs[i - 1])?.key;
  };
  const closeByMouse = (key: string) => {
    const next = shownAfter(key);
    onClose(key);
    refocusAfterClose(next);
  };
  const focusTab = (key: string | undefined) => {
    if (key) document.getElementById(tabId(key))?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const tabs = state.tabs;
    const key = tabs[i]!.key;
    if (e.ctrlKey && e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      onMove(key, e.key === "ArrowLeft" ? -1 : 1);
      requestAnimationFrame(() => focusTab(key));
      return;
    }
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
    if (to) {
      e.preventDefault();
      focusTab(to.key);
      return;
    }
    if (e.key === "Delete" && key !== HOME_KEY) {
      e.preventDefault();
      const next = tabs[i + 1] ?? tabs[i - 1];
      onClose(key);
      requestAnimationFrame(() => focusTab(next?.key));
    }
  };
  return (
    <div className="sh-tabbar">
      {side && (
        <button
          type="button"
          className="sh-tool"
          aria-expanded={side.open}
          aria-controls="sh-side"
          aria-label={side.open ? T.sideHide : T.sideShow}
          onClick={side.onToggle}
        >
          <Tip text={side.open ? T.sideHide : T.sideShow} />
          <SideIcon />
        </button>
      )}
      <div ref={list} role="tablist" aria-label={T.tabs} className="sh-tabs">
        {state.tabs.map((t, i) => {
          const { label, title } = tabLabel(t);
          const on = t.key === state.active;
          const closable = t.key !== HOME_KEY;
          return (
            <button
              key={t.key}
              id={tabId(t.key)}
              type="button"
              role="tab"
              className={`sh-tab${t.key === HOME_KEY ? " sh-tab-home" : ""}${out.cut.includes(t.key) ? " sh-tab-cut" : ""}`}
              aria-selected={on}
              aria-controls={on ? PANEL_ID : undefined}
              aria-describedby={closable ? "sh-tab-hint" : undefined}
              aria-keyshortcuts={closable ? "Delete" : undefined}
              tabIndex={on ? 0 : -1}
              title={title}
              onClick={() => onShow(t.key)}
              onAuxClick={(e) => {
                if (e.button === 1 && closable) {
                  e.preventDefault();
                  closeByMouse(t.key);
                }
              }}
              onKeyDown={(e) => onKey(e, i)}
            >
              <span className="sh-tab-label">{label}</span>
              {closable && (
                <span
                  className="sh-tab-x"
                  aria-hidden="true"
                  title={T.closeTab(label)}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeByMouse(t.key);
                  }}
                >
                  ×
                </span>
              )}
            </button>
          );
        })}
      </div>
      <MoreTabs keys={out.hidden} state={state} onShow={onShow} />
      <span id="sh-tab-hint" className="sr">
        {T.tabHint}
      </span>
      {tools && (
        <div className="sh-tabtools" role="group" aria-label={T.tools}>
          {tools}
        </div>
      )}
    </div>
  );
}
