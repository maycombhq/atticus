import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { COPY } from "../../copy.js";
import { SideIcon, Tip } from "./icons.js";
import { HOME_KEY, tabLabel, type TabsState } from "./tabs-model.js";

const T = COPY.ide;

/** The page panel the tabs control. */
export const PANEL_ID = "sh-panel";

/** A tab's element id, from its key (a change's id is letters, digits, dots and dashes). */
export const tabId = (key: string): string => `sh-tab-${key.replace(/[^A-Za-z0-9_-]/g, "_")}`;

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
              className="sh-tab"
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
                  onClose(t.key);
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
                    onClose(t.key);
                  }}
                >
                  ×
                </span>
              )}
            </button>
          );
        })}
      </div>
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
