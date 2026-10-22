import { useEffect, useState } from "react";
import { COPY } from "../copy.js";
import "../screens/work/work.css";
import { MAIN, MORE, MORE_GROUPS, type ScreenDef } from "./screens.js";

function Logo() {
  return (
    <svg aria-hidden="true" width="26" height="26" viewBox="0 0 26 26">
      <polygon
        points="13,2 24,8 24,18 13,24 2,18 2,8"
        fill="none"
        stroke="var(--accent)"
        strokeWidth="1.5"
        style={{ filter: "drop-shadow(0 0 var(--glow-size) var(--accent))" }}
      />
      <path
        d="M8 18 L13 7 L18 18 M10 14 H16"
        fill="none"
        stroke="var(--accent)"
        strokeWidth="1.5"
      />
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
    <nav aria-label="Main" className="nav">
      <div className="brand">
        <Logo />
        ATTICUS
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
          <div key={g} role="group" aria-label={g}>
            <div className="group">{g}</div>
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
        Ask Atticus
      </a>
    </nav>
  );
}
