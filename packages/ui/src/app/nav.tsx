import { useEffect, useState } from "react";
import { COPY } from "../copy.js";
import "../screens/work/work.css";
import { groupLabel, MAIN, MORE, MORE_GROUPS, type ScreenDef } from "./screens.js";

const T = COPY.menu;

/**
 * Atticus's mark: a mockingbird built from geometry (docs/brand/mockingbird.svg), each part apart
 * by a thin gap, in the theme's accent.
 */
const MOCKINGBIRD = [
  "M7.4 12.6 H19.4 A6 6 0 0 1 7.4 12.6 Z",
  "M13.4 11.8 H7.8 A5.6 5.6 0 0 1 13.4 6.2 V8.7 A3.1 3.1 0 0 0 10.3 11.8 Z",
  "M13.4 11.8 H11.2 A2.2 2.2 0 0 1 13.4 9.6 Z",
  "M17.1 6.6 a2.5 2.5 0 1 1 0 5 a2.5 2.5 0 1 1 0 -5 Z M17.6 8.45 a0.62 0.62 0 1 0 0 1.24 a0.62 0.62 0 1 0 0 -1.24 Z",
  "M19.4 8.3 L23 9.1 L19.4 9.9 Z",
  "M0.6 12.6 H6.6 V15.2 Z",
];

function Logo() {
  return (
    <svg
      aria-hidden="true"
      width="26"
      height="26"
      viewBox="0 0 24 24"
      style={{ filter: "drop-shadow(0 0 var(--glow-size) var(--accent))" }}
    >
      {MOCKINGBIRD.map((d) => (
        <path key={d} d={d} fill="var(--accent)" fillRule="evenodd" />
      ))}
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
