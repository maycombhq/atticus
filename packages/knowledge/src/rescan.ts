import type { KnowledgeRecord } from "./knowledge-scan.js";
import type { KnowledgeReport } from "./knowledge-store.js";
import type { Snapshot } from "./snapshot.js";

/**
 * A rescan (ADR 0101): only the pages whose copy changed since the last scan are read again.
 * A source the last scan has no page hashes for is read whole; `full` reads every page. The
 * items read from a changed page last time go to the AI with the pages, so an item still there
 * keeps its id and a change to it shows as a change, not as one item gone and another added.
 */
export interface RescanPlan {
  /** The snapshots to read, each with only its changed or new pages. Empty: nothing to read. */
  snapshots: Snapshot[];
  /** Pages new or changed since the last scan, by source. */
  changed: Record<string, string[]>;
  /** Pages the last scan read that the snapshot no longer has, by source. */
  removed: Record<string, string[]>;
  /** How many pages are as they were, by source. */
  unchanged: Record<string, number>;
  /** Items the last scan read from the changed and removed pages. */
  previous: KnowledgeRecord[];
}

export function planRescan(
  snapshots: Snapshot[],
  report: KnowledgeReport | undefined,
  items: KnowledgeRecord[],
  o: { full?: boolean } = {},
): RescanPlan {
  const plan: RescanPlan = { snapshots: [], changed: {}, removed: {}, unchanged: {}, previous: [] };
  for (const s of snapshots) {
    const source = s.manifest.source;
    const last = o.full ? undefined : report?.snapshots.find((x) => x.source === source)?.hashes;
    const now = new Map(s.manifest.pages.map((p) => [p.page, p.sha256]));
    const changed = s.manifest.pages
      .filter((p) => !last || last[p.page] !== p.sha256)
      .map((p) => p.page);
    const removed = last
      ? Object.keys(last)
          .filter((p) => !now.has(p))
          .sort()
      : [];
    if (changed.length) plan.changed[source] = changed;
    if (removed.length) plan.removed[source] = removed;
    plan.unchanged[source] = s.manifest.pages.length - changed.length;
    if (changed.length) {
      const keep = new Set(changed);
      plan.snapshots.push({ ...s, pages: s.pages.filter((p) => keep.has(p.pagePath)) });
    }
    const touched = new Set([...changed, ...removed]);
    plan.previous.push(
      ...items.filter((i) => i.quote?.source === source && touched.has(i.quote.page)),
    );
  }
  return plan;
}
