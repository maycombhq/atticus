import { useRef, useState } from "react";
import { COPY } from "../copy.js";
import "../screens/work/work.css";
import { OPEN_PALETTE } from "./palette.js";
import {
  changeOf,
  groupLabel,
  landingOf,
  morePages,
  sectionLabel,
  SECTIONS,
  tabHref,
  type ScreenDef,
} from "./screens.js";

const T = COPY.menu;

/**
 * Atticus's mark: Atticus Finch's glasses (docs/brand/glasses.svg), a small curved glint at the
 * outer top of each lens like an eyebrow, in the theme's accent.
 */
function Logo() {
  return (
    <svg
      aria-hidden="true"
      width="26"
      height="26"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--accent)"
      strokeLinecap="round"
      style={{ filter: "drop-shadow(0 0 var(--glow-size) var(--accent))" }}
    >
      <g strokeWidth="1.25">
        <circle cx="6.5" cy="12.4" r="4.5" />
        <circle cx="17.5" cy="12.4" r="4.5" />
        <path d="M11 11.4 H13" />
      </g>
      <path strokeWidth="1.05" d="M3.7 11.3 Q3.9 10.0 5.2 9.6 M20.3 11.3 Q20.1 10.0 18.8 9.6" />
    </svg>
  );
}

/** Where whether More pages is open is kept, per viewer (this browser, or this editor's panel). */
export const MORE_KEY = "atticus.menu.more";

type Store = Pick<Storage, "getItem" | "setItem">;

/** The browser's localStorage, or undefined where even asking for it throws. */
function browserStore(): Store | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** Whether the viewer left More pages open: undefined until they chose, or storage refuses. */
export function readMore(store: Store | undefined = browserStore()): boolean | undefined {
  try {
    const v = store?.getItem(MORE_KEY);
    return v === "open" ? true : v === "closed" ? false : undefined;
  } catch {
    return undefined;
  }
}

export function saveMore(open: boolean, store: Store | undefined = browserStore()): void {
  try {
    store?.setItem(MORE_KEY, open ? "open" : "closed");
  } catch {
    // Storage blocked: the choice lasts until the page reloads.
  }
}

/** The keys that open Ctrl+K, as this machine names them: Cmd on a Mac. */
export function paletteKeys(platform: string | undefined): string {
  return /Mac|iPhone|iPad|iPod/.test(platform ?? "") ? T.keysMac : T.keys;
}

function platformName(): string | undefined {
  try {
    const n = globalThis.navigator as
      (Navigator & { userAgentData?: { platform?: string } }) | undefined;
    return n?.userAgentData?.platform || n?.platform;
  } catch {
    return undefined;
  }
}

/**
 * More pages, at the bottom of the menu: every page the six entries' tabs don't show, by section
 * (Change's by phase), behind one button (a disclosure: Enter or Space opens and closes it, Escape
 * closes it and goes back to the button). Whether it is open is remembered per viewer; until they
 * choose, it opens with `atticus ui --full` and on a page it holds. A page about a change keeps
 * the change in the address, else it opens as from Ctrl+K.
 */
function MorePages({ current, hash, full }: { current: ScreenDef; hash: string; full: boolean }) {
  const [choice, setChoice] = useState<boolean | undefined>(() => readMore());
  const button = useRef<HTMLButtonElement>(null);
  const groups = morePages();
  const count = groups.reduce((n, g) => n + g.pages.length, 0);
  const shown = current.under ?? current.id;
  const holds = groups.some((g) => g.pages.some((p) => p.id === shown));
  const open = choice ?? (full || holds);
  const change = changeOf(hash);
  const set = (o: boolean) => {
    setChoice(o);
    saveMore(o);
  };
  const link = (p: ScreenDef) => (
    <a key={p.id} href={tabHref(p, change)} aria-current={p.id === shown ? "page" : undefined}>
      {p.label}
    </a>
  );
  return (
    <div
      className="more"
      onKeyDown={(e) => {
        if (e.key !== "Escape" || !open) return;
        e.stopPropagation();
        set(false);
        button.current?.focus();
      }}
    >
      <button
        ref={button}
        type="button"
        className="more-toggle"
        aria-expanded={open}
        aria-controls="more-pages"
        onClick={() => set(!open)}
      >
        <span aria-hidden="true" className="more-caret">
          ▸
        </span>
        <span>{T.morePages}</span>
        <span className="more-count">{count}</span>
      </button>
      <div id="more-pages" className="more-pages" hidden={!open}>
        {groups.map((g) => (
          <div key={g.section} role="group" aria-label={sectionLabel(g.section)}>
            <span className="more-group" aria-hidden="true">
              {sectionLabel(g.section)}
            </span>
            {g.phases
              ? g.phases.map((ph) => (
                  <div key={ph.phase} role="group" aria-label={groupLabel(ph.phase)}>
                    <span className="more-phase" aria-hidden="true">
                      {groupLabel(ph.phase)}
                    </span>
                    {ph.pages.map(link)}
                  </div>
                ))
              : g.pages.map(link)}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * One navigation for everyone (ADR 0073), in six entries (the Surfaces design): Home, Map,
 * Change, Questions, Knowledge and Set up; then More pages with every other page, and the Ctrl+K
 * hint (a click opens Ctrl+K too). Each entry opens on its first tab; the entry of the page shown
 * is marked, and its tabs are above the page.
 */
export function Nav({
  current,
  hash = "",
  full = false,
}: {
  current: ScreenDef;
  hash?: string;
  full?: boolean;
}) {
  return (
    <nav aria-label={COPY.nav.main} className="nav">
      <div className="brand">
        <Logo />
        {T.atticus}
      </div>
      <div role="group" aria-label={COPY.nav.main}>
        {SECTIONS.map((s) => {
          const to = landingOf(s);
          return (
            <a
              key={s}
              href={`#/${to.id}`}
              aria-current={current.section === s ? "page" : undefined}
            >
              {sectionLabel(s)}
            </a>
          );
        })}
      </div>
      <a className="ask" href="#/explore">
        <span
          aria-hidden="true"
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: "var(--accent)",
            boxShadow: "0 0 8px var(--accent)",
          }}
        />
        {T.askAtticus}
      </a>
      <MorePages current={current} hash={hash} full={full} />
      <button
        type="button"
        className="menu-hint hud"
        onClick={() => dispatchEvent(new Event(OPEN_PALETTE))}
      >
        {T.anyPage(paletteKeys(platformName()))}
      </button>
    </nav>
  );
}
