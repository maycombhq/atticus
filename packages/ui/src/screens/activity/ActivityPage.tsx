import { COPY } from "../../copy.js";
import {
  ACTIVITY_LABELS,
  ACTIVITY_TABS,
  activityHref,
  activityTabOf,
  type ActivityTab,
} from "../../app/screens.js";
import type { Screen } from "../registry.js";

export { ACTIVITY_LABELS };

const N = COPY.nav;

/**
 * v30 slice 8: Activity, one page for what ran. Model runs, Prompt history, Scans and Catalog
 * builds are its tabs (each the page it was, unchanged, with its own query in the address:
 * `#/activity?tab=runs&run=…`). The tabs are links, so each tab has an address and Back works;
 * the one shown is marked current (the section's own tab is the page), and the window's title,
 * the heading and where-you-are name it (pageTitle).
 */
export function ActivityPage({ hash, tabs }: { hash: string; tabs: Record<ActivityTab, Screen> }) {
  const shown = activityTabOf(hash);
  const Tab = tabs[shown];
  return (
    <div className="stack activity-page">
      <p className="muted" style={{ margin: 0 }}>
        {N.activityIntro}
      </p>
      <nav aria-label={N.activityTabs} className="tabs">
        {ACTIVITY_TABS.map((t) => (
          // The section's tab is the page ("page"); this one is the tab shown within it ("true").
          <a key={t} href={activityHref(t)} aria-current={t === shown ? "true" : undefined}>
            {ACTIVITY_LABELS[t]}
          </a>
        ))}
      </nav>
      <Tab hash={hash} />
    </div>
  );
}
