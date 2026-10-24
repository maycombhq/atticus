import { COPY } from "../copy.js";
import "../screens/work/work.css";
import { landingOf, sectionLabel, SECTIONS, type ScreenDef } from "./screens.js";

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

/**
 * One navigation for everyone (ADR 0073), in six sections, the same on every surface (ADR 0119):
 * Home, Changes, Knowledge, the Estate, Set up and Atticus. Each opens on its first tab; the
 * section of the page shown is marked, and its tabs are above the page.
 */
export function Nav({ current }: { current: ScreenDef }) {
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
    </nav>
  );
}
