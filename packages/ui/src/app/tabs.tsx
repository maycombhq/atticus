import { COPY } from "../copy.js";
import {
  changeOf,
  groupLabel,
  PHASES,
  sectionLabel,
  tabHref,
  tabsOf,
  type ScreenDef,
} from "./screens.js";

const T = COPY.nav;

/**
 * The tabs of the section shown (ADR 0119), above its page: where you are (the section, the
 * change, the page), then every page of the section, a change's grouped by phase. Moving between
 * a change's tabs keeps the change. A page that is part of another (Questions) marks that tab.
 */
export function SectionTabs({ current, hash }: { current: ScreenDef; hash: string }) {
  const tabs = tabsOf(current.section);
  if (tabs.length < 2) return null;
  const section = sectionLabel(current.section);
  const change = current.section === "Changes" ? changeOf(hash) : undefined;
  const shown = current.under ?? current.id;
  // The list's tab never repeats the section's name: every change, or the one open.
  const label = (s: ScreenDef) =>
    s.id === "changes" ? (change ? T.thisChange : T.allChanges) : s.label;
  const tab = (s: ScreenDef) => (
    <a key={s.id} href={tabHref(s, change)} aria-current={s.id === shown ? "page" : undefined}>
      {label(s)}
    </a>
  );
  const plain = tabs.filter((s) => !s.group);
  return (
    <div className="section-tabs">
      <nav aria-label={T.youAreHere} className="crumbs hud">
        <span>{section}</span>
        {change && (
          <>
            <span aria-hidden="true"> › </span>
            <span>{T.ofChange(change)}</span>
          </>
        )}
        <span aria-hidden="true"> › </span>
        <span aria-current="location">{label(current)}</span>
      </nav>
      <nav aria-label={T.tabs(section)} className="tabs">
        {plain.map(tab)}
        {PHASES.map((g) => {
          const of = tabs.filter((s) => s.group === g);
          if (!of.length) return null;
          return (
            <span key={g} role="group" aria-label={groupLabel(g)} className="tab-group">
              <span className="tab-group-name" aria-hidden="true">
                {groupLabel(g)}
              </span>
              {of.map(tab)}
            </span>
          );
        })}
      </nav>
    </div>
  );
}
