import { useEffect, useState } from "react";
import { COPY } from "../copy.js";
import "../screens/work/work.css";
import { groupLabel, MAIN, MORE, MORE_GROUPS, type ScreenDef } from "./screens.js";

const T = COPY.menu;

/** Atticus's mark: a pair of round wire glasses (docs/brand/glasses.svg), in the theme's accent. */
function Logo() {
  return (
    <svg
      aria-hidden="true"
      width="26"
      height="26"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--accent)"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ filter: "drop-shadow(0 0 var(--glow-size) var(--accent))" }}
    >
      <circle cx="6.5" cy="12.6" r="4.5" />
      <circle cx="17.5" cy="12.6" r="4.5" />
      <path d="M10.9 11.5 C11.1 9.9 12.9 9.9 13.1 11.5" />
      <path d="M2.05 12.0 L0.7 11.7" />
      <path d="M21.95 12.0 L23.3 11.7" />
    </svg>
  );
}

function Link({ s, current }: { s: ScreenDef; current: ScreenDef }) {
  return (
    <a href={`#/${s.id}`} aria-current={s.id === current.id ? "page" : undefined}>
      {s.label}
    </a>
  );
}

/**
 * One navigation for everyone (ADR 0073, plan 4.5): the six screens that follow the work, then
 * More, a button that opens every other page in its old group. More is open when the page
 * shown is one of its pages, so the current page is always visible in the menu.
 */
export function Nav({ current }: { current: ScreenDef }) {
  const inMore = current.group !== "Main";
  const [open, setOpen] = useState(inMore);
  useEffect(() => {
    if (inMore) setOpen(true);
  }, [inMore]);
  return (
    <nav aria-label={COPY.nav.main} className="nav">
      <div className="brand">
        <Logo />
        {T.atticus}
      </div>
      <div role="group" aria-label={COPY.nav.main}>
        {MAIN.map((s) => (
          <Link key={s.id} s={s} current={current} />
        ))}
      </div>
      <button
        type="button"
        className="more"
        aria-expanded={open}
        aria-controls="nav-more"
        title={COPY.nav.moreHint}
        onClick={() => setOpen((o) => !o)}
      >
        {COPY.nav.more}
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
      </button>
      <div id="nav-more" hidden={!open}>
        {MORE_GROUPS.map((g) => (
          <div key={g} role="group" aria-label={groupLabel(g)}>
            <div className="group">{groupLabel(g)}</div>
            {MORE.filter((s) => s.group === g).map((s) => (
              <Link key={s.id} s={s} current={current} />
            ))}
          </div>
        ))}
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
    </nav>
  );
}
