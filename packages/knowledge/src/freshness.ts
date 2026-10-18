import type { CatalogRecord, OrgPack, RecordKind } from "@maycombhq/core";
import { daysBetween } from "./sources.js";

/**
 * Freshness: how old the newest evidence for each record is. Evidence carries a scan time and
 * often a commit; a commit's date is used when the caller knows it (from the Git host), since
 * a commit date says when the code last changed, not when Atticus last looked.
 */

export interface StaleRecord {
  id: string;
  kind: RecordKind;
  newest: string;
  ageDays: number;
  maxDays: number;
}

export type StaleDocument =
  | { id: string; path: string; reason: "superseded"; supersededBy: string }
  | { id: string; path: string; reason: "stale"; date: string; ageDays: number; maxDays: number };

export interface FreshnessResult {
  stale: StaleRecord[];
  /** Records with no dated evidence: their age is unknown, not fresh. */
  undated: string[];
  documents: StaleDocument[];
}

export interface FreshnessInput {
  records: CatalogRecord[];
  /** The clock (ISO date-time), from the caller. */
  now: string;
  /** Windows per kind come from pack.yaml `freshness`. */
  orgPack?: OrgPack;
  /** Window for kinds the pack doesn't name. Default 365 days. */
  defaultDays?: number;
  /** Commit sha (or prefix) → commit date, when known. */
  commitDates?: Record<string, string>;
}

/** The newest date among a record's evidence: scan times and known commit dates. */
export function newestEvidence(
  r: CatalogRecord,
  commitDates: Record<string, string> = {},
): string | undefined {
  let best: string | undefined;
  const consider = (d: string | undefined) => {
    if (d && !Number.isNaN(Date.parse(d)) && (!best || Date.parse(d) > Date.parse(best))) best = d;
  };
  for (const e of r.evidence) {
    consider(e.scannedAt);
    if (e.commit) {
      const hit = Object.entries(commitDates).find(
        ([sha]) => sha.startsWith(e.commit!) || e.commit!.startsWith(sha),
      );
      consider(hit?.[1]);
    }
  }
  return best;
}

export function freshness(input: FreshnessInput): FreshnessResult {
  const windows = input.orgPack?.pack?.freshness ?? {};
  const fallback = input.defaultDays ?? 365;
  const res: FreshnessResult = { stale: [], undated: [], documents: [] };
  const sorted = [...input.records].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const r of sorted) {
    const maxDays = windows[r.kind] ?? fallback;
    if (r.kind === "SourceDocument") {
      if (r.supersededBy)
        res.documents.push({
          id: r.id,
          path: r.path,
          reason: "superseded",
          supersededBy: r.supersededBy,
        });
      else if (r.date) {
        const ageDays = daysBetween(r.date, input.now);
        if (ageDays > maxDays)
          res.documents.push({
            id: r.id,
            path: r.path,
            reason: "stale",
            date: r.date,
            ageDays,
            maxDays,
          });
      }
      continue;
    }
    if (r.kind === "CuratedDecision") continue;
    const newest = newestEvidence(r, input.commitDates);
    if (!newest) {
      res.undated.push(r.id);
      continue;
    }
    const ageDays = daysBetween(newest, input.now);
    if (ageDays > maxDays) res.stale.push({ id: r.id, kind: r.kind, newest, ageDays, maxDays });
  }
  return res;
}
