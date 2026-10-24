import { COPY } from "../copy.js";
import "../screens/work/work.css";
import { landingOf, sectionLabel, sectionsShown, type ScreenDef } from "./screens.js";

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
 * One navigation for everyone (ADR 0073), in six entries (the Surfaces design): Home, Map,
 * Change, Questions, Knowledge and Set up; with `atticus ui --full`, Atticus's own pages too.
 * Each opens on its first tab; the entry of the page shown is marked, and its tabs are above the
 * page. A page behind --full opened by its address marks its entry all the same.
 */
export function Nav({ current, full = false }: { current: ScreenDef; full?: boolean }) {
  return (
    <nav aria-label={COPY.nav.main} className="nav">
      <div className="brand">
        <Logo />
        {T.atticus}
      </div>
      <div role="group" aria-label={COPY.nav.main}>
        {sectionsShown(full).map((s) => {
          const to = landingOf(s, full);
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
