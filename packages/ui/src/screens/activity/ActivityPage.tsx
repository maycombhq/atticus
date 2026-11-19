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
 * `#/activity?tab=runs&run=…`). The tabs are links, so each tab has an address, Back works, and a
 * screen reader hears "current page" on the one shown.
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
          <a key={t} href={activityHref(t)} aria-current={t === shown ? "page" : undefined}>
            {ACTIVITY_LABELS[t]}
          </a>
        ))}
      </nav>
      <Tab hash={hash} />
    </div>
  );
}
