import { useEffect, useRef, useState } from "react";
import { COPY } from "../../copy.js";
import { MorePagesList, morePagesCount } from "../nav.js";
import { landingOf, sectionLabel, SECTIONS, type ScreenDef, type Section } from "../screens.js";
import { MoreIcon, SectionIcon, SettingsIcon } from "./icons.js";

const T = COPY.ide;

/** The badge counts the activity bar shows, from what the app already loaded. */
export interface Badges {
  questions?: number;
}

/** The section an activity-bar entry marks: Settings has its own entry, at the foot. */
export function activeEntry(current: ScreenDef): Section | "settings" {
  return current.id === "settings" ? "settings" : current.section;
}

/**
 * More pages (ADR 0194), from the activity bar (or, in an editor's panel, beside the tabs): one
 * button that opens every page the sections' tabs don't show, by section. A disclosure: Enter or
 * Space opens it, Escape closes it and goes back to the button, as does a click outside it or
 * opening a page.
 */
export function MoreFlyout({
  current,
  hash,
  className = "sh-act",
}: {
  current: ScreenDef;
  hash: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const count = morePagesCount();
  useEffect(() => setOpen(false), [hash]);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && !box.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    addEventListener("pointerdown", away);
    return () => removeEventListener("pointerdown", away);
  }, [open]);
  return (
    <div
      className="sh-more"
      onKeyDown={(e) => {
        if (e.key !== "Escape" || !open) return;
        e.stopPropagation();
        setOpen(false);
        button.current?.focus();
      }}
    >
      <button
        ref={button}
        type="button"
        className={className}
        aria-expanded={open}
        aria-controls="more-pages"
        data-tip={T.more}
        onClick={() => setOpen(!open)}
      >
        <MoreIcon />
        <span className="sr">
          {T.more} {count}
        </span>
      </button>
      <div ref={box} className="sh-flyout" hidden={!open}>
        <MorePagesList current={current} hash={hash} className="sh-flyout-pages more-pages" />
      </div>
    </div>
  );
}

/**
 * The activity bar (ADR 0194): the six sections as icons, each named for a screen reader and in
 * a tooltip, the one shown marked; More pages; Settings at the foot. Each entry opens its
 * section's first page. Questions carries the count of open questions when a page has loaded it.
 */
export function ActivityBar({
  current,
  hash,
  badges = {},
}: {
  current: ScreenDef;
  hash: string;
  badges?: Badges;
}) {
  const on = activeEntry(current);
  return (
    <nav aria-label={COPY.nav.main} className="sh-activity">
      <div role="group" aria-label={COPY.nav.main} className="sh-activity-group">
        {SECTIONS.map((s) => {
          const label = sectionLabel(s);
          const n = s === "Questions" ? badges.questions : undefined;
          return (
            <a
              key={s}
              className="sh-act"
              href={`#/${landingOf(s).id}`}
              aria-current={on === s ? "page" : undefined}
              data-tip={label}
            >
              <SectionIcon section={s} />
              <span className="sr">
                {label}
                {n ? `, ${T.openCount(n)}` : ""}
              </span>
              {!!n && (
                <span className="sh-badge" aria-hidden="true">
                  {n > 99 ? "99+" : n}
                </span>
              )}
            </a>
          );
        })}
        <MoreFlyout current={current} hash={hash} />
      </div>
      <span className="sh-grow" aria-hidden="true" />
      <a
        className="sh-act"
        href="#/settings"
        aria-current={on === "settings" ? "page" : undefined}
        data-tip={T.settings}
      >
        <SettingsIcon />
        <span className="sr">{T.settings}</span>
      </a>
    </nav>
  );
}
