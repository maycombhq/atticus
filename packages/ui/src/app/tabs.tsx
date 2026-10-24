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
 * The tabs of the entry shown, above its page: where you are (the entry, the change, the page),
 * then every tab of the entry. Change's four stage tabs keep the change; with --full a change's
 * many pages are grouped by phase. A page that is part of another, or reached by a link (a
 * change's At a glance, say), marks no tab it isn't; one behind --full shows the six's tabs.
 */
export function SectionTabs({
  current,
  hash,
  full = false,
}: {
  current: ScreenDef;
  hash: string;
  full?: boolean;
}) {
  const tabs = tabsOf(current.section, full);
  const section = sectionLabel(current.section);
  const change = current.section === "Change" ? changeOf(hash) : undefined;
  // A single-page entry (Home, Questions) needs no tabs, but a page reached by a link still says
  // where it is.
  if (tabs.length < 2 && (tabs[0]?.id === current.id || !tabs.length)) return null;
  const shown = current.under ?? current.id;
  // The list's tab never repeats the entry's name: every change, or the one open.
  const label = (s: ScreenDef) =>
    s.id === "changes" ? (change ? T.thisChange : T.allChanges) : s.label;
  const tab = (s: ScreenDef) => (
    <a key={s.id} href={tabHref(s, change)} aria-current={s.id === shown ? "page" : undefined}>
      {label(s)}
    </a>
  );
  const grouped = full && current.section === "Change";
  const plain = grouped ? tabs.filter((s) => !s.group) : tabs;
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
      {tabs.length > 1 && (
        <nav aria-label={T.tabs(section)} className="tabs">
          {plain.map(tab)}
          {grouped &&
            PHASES.map((g) => {
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
      )}
    </div>
  );
}
