import { useEffect, useState } from "react";
import { COPY } from "../copy.js";
import "../screens/work/work.css";
import { groupLabel, MAIN, MORE, MORE_GROUPS, type ScreenDef } from "./screens.js";

const T = COPY.menu;

/**
 * Atticus's mark: Atticus Finch's glasses (docs/brand/glasses.svg), a small curved glint at the
 * outer top of each lens like an eyebrow, in the theme's accent. The name is set below it.
 */
function Logo() {
  return (
    <svg
      aria-hidden="true"
      width="48"
      height="28"
      viewBox="0 5.5 24 14"
      fill="none"
      stroke="var(--accent)"
      strokeLinecap="round"
      style={{ filter: "drop-shadow(0 0 var(--glow-size) var(--accent))" }}
    >
      <g strokeWidth="1.1">
        <circle cx="6.5" cy="12.4" r="4.5" />
        <circle cx="17.5" cy="12.4" r="4.5" />
        <path d="M11 11.4 H13" />
      </g>
      <path strokeWidth="0.95" d="M3.7 11.3 Q3.9 10.0 5.2 9.6 M20.3 11.3 Q20.1 10.0 18.8 9.6" />
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
