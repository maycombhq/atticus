import type { LockInfo } from "@maycombhq/core";

/**
 * What is said of a lock its process left (the scan's lock). ADR 0205 step 2: a writer marks its
 * lock `caches` once its result is given and the catalog written whole, while it writes its local
 * caches; a process that stopped then left nothing half-done but those caches, and that is said.
 */
export function interruptedLine(l: LockInfo): string {
  return l.phase === "caches"
    ? `The last write (${l.what}, started ${l.startedAt}) wrote the catalog whole, then stopped while it saved its local caches; they weren't saved, so this run may take a little longer. Nothing is missing.`
    : `The last scan (started ${l.startedAt}) stopped before it finished; this one brings the catalog up to date.`;
}

/** doctor's words for the same lock. */
export function staleLockDetail(l: LockInfo): string {
  return l.phase === "caches"
    ? `the write started ${l.startedAt} wrote the catalog whole; its local caches weren't saved (the next write rebuilds them)`
    : `the write started ${l.startedAt} stopped before it finished`;
}
