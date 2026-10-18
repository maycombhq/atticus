import { changeStore } from "@maycombhq/changes";
import { driftCheck } from "./drift.js";

/**
 * The drift check after every scan (ADR 0036 "not yet", closed in ADR 0041): a fresh catalog
 * is the moment code may have moved away from an open change's design or plans, so each
 * change being built or tested is checked again. The check writes a new drift round only when
 * something changed, so a quiet rescan leaves the change folders as they were.
 */

/** States whose code is being written or tested, where code drifting from the design matters. */
export const DRIFT_AFTER_SCAN_STATES = ["build", "qa"] as const;

export interface DriftAfterScan {
  change: string;
  state: string;
  /** The newest drift round, undefined when there has never been a finding. */
  round?: number;
  /** True when nothing changed since the last round, so nothing was written. */
  unchanged: boolean;
  /** Open findings in the newest round, and how many of them block. */
  open: number;
  blocking: number;
  /** Set when the check couldn't run for this change; the others still run. */
  error?: string;
}

export async function driftAfterScan(
  root: string,
  o: { now?: string } = {},
): Promise<DriftAfterScan[]> {
  const states = new Set<string>(DRIFT_AFTER_SCAN_STATES);
  const open = (await changeStore(root).list()).filter((c) => states.has(c.state));
  const out: DriftAfterScan[] = [];
  for (const c of open) {
    try {
      const r = await driftCheck(root, c.id, o.now ? { now: o.now } : {});
      const live = r.findings.filter((f) => f.finding.state === "open");
      out.push({
        change: c.id,
        state: c.state,
        ...(r.round !== undefined ? { round: r.round } : {}),
        unchanged: r.unchanged,
        open: live.length,
        blocking: live.filter((f) => f.finding.severity === "blocking").length,
      });
    } catch (e) {
      out.push({
        change: c.id,
        state: c.state,
        unchanged: true,
        open: 0,
        blocking: 0,
        error: (e as Error).message,
      });
    }
  }
  return out;
}
