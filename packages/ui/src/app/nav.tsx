import { useEffect, useState } from "react";
import { COPY } from "../copy.js";
import "../screens/work/work.css";
import { groupLabel, MAIN, MORE, MORE_GROUPS, type ScreenDef } from "./screens.js";

const T = COPY.menu;

/**
 * Atticus's mark: a mockingbird made of one circle in parts (docs/brand/mockingbird.svg), apart
 * by thin gaps, in the theme's accent.
 */
const MOCKINGBIRD = [
  "M11.4 11.4 H4 A7.4 7.4 0 0 1 11.4 4 Z",
  "M20 11.4 H14.2 A5.8 5.8 0 0 1 20 5.6 Z M18.3 8.15 a0.8 0.8 0 1 0 0 1.6 a0.8 0.8 0 1 0 0 -1.6 Z",
  "M20 6.9 L23.4 8.5 L20 9.5 Z",
  "M4 12.6 H20 A8 8 0 0 1 4 12.6 Z",
  "M0.4 12.6 H3.2 V15.4 Z",
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
