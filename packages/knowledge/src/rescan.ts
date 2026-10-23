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
  /**
   * Pages new or changed that this scan leaves for the next, by source: with `batchTokens`, only
   * the pages that fit are read (always at least one), and the rest wait (they stay unrecorded).
   */
  deferred: Record<string, string[]>;
}

/** About as many tokens as the context pack will count for a page. */
const tokensOf = (text: string) => Math.ceil(text.length / 4);

export function planRescan(
  snapshots: Snapshot[],
  report: KnowledgeReport | undefined,
  items: KnowledgeRecord[],
  o: { full?: boolean; batchTokens?: number } = {},
): RescanPlan {
  const plan: RescanPlan = {
    snapshots: [],
    changed: {},
    removed: {},
    unchanged: {},
    previous: [],
    deferred: {},
  };
  // The batch's room, across every source; the first page always goes, however big.
  let room = o.batchTokens;
  let taken = 0;
  for (const s of snapshots) {
    const source = s.manifest.source;
    const last = o.full ? undefined : report?.snapshots.find((x) => x.source === source)?.hashes;
    const now = new Map(s.manifest.pages.map((p) => [p.page, p.sha256]));
    const all = s.manifest.pages
      .filter((p) => !last || last[p.page] !== p.sha256)
      .map((p) => p.page);
    const changed: string[] = [];
    const deferred: string[] = [];
    for (const page of all) {
      if (room === undefined) {
        changed.push(page);
        continue;
      }
      const text = s.pages.find((p) => p.pagePath === page)?.text ?? "";
      const t = tokensOf(text);
      if (taken === 0 || (deferred.length === 0 && t <= room)) {
        changed.push(page);
        room -= t;
        taken++;
      } else deferred.push(page);
    }
    if (deferred.length) plan.deferred[source] = deferred;
    const removed = last
      ? Object.keys(last)
          .filter((p) => !now.has(p))
          .sort()
      : [];
    if (changed.length) plan.changed[source] = changed;
    if (removed.length) plan.removed[source] = removed;
    plan.unchanged[source] = s.manifest.pages.length - all.length;
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
