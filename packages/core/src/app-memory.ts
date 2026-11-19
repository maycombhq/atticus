import { getHeapStatistics } from "node:v8";

/**
 * ADR 0205 step 4 (the owner's answer of 2026-11-19): what the app's server keeps in memory
 * between Applies, so the next one doesn't read it back from disk: the last build's record texts
 * and the facts parses. Up to about 1 GB more at 100,000 records, let go after ten idle minutes,
 * or at once when the heap is three quarters full. Off outside the server (`atticus ui` turns it
 * on): a command builds once and ends.
 */
export const appMemory: { on: boolean; idleMs: number; lowAt: number } = {
  on: false,
  idleMs: 10 * 60 * 1000,
  lowAt: 0.75,
};

const releases = new Set<() => void>();
let idle: ReturnType<typeof setTimeout> | undefined;

/** What to let go when the app's memory is let go (each keeper registers its own). */
export function onAppMemoryRelease(release: () => void): void {
  releases.add(release);
}

/** Let go of everything kept for the app now. */
export function releaseAppMemory(): void {
  if (idle) clearTimeout(idle);
  idle = undefined;
  for (const r of releases) r();
}

/**
 * Whether a keeper may keep (or use) what it holds for the app now: on, and the heap not three
 * quarters full (else everything is let go first). Each yes starts the ten idle minutes again.
 */
export function appMemoryInUse(): boolean {
  if (!appMemory.on) return false;
  const h = getHeapStatistics();
  if (h.used_heap_size > appMemory.lowAt * h.heap_size_limit) {
    releaseAppMemory();
    return false;
  }
  if (idle) clearTimeout(idle);
  idle = setTimeout(releaseAppMemory, appMemory.idleMs);
  idle.unref?.();
  return true;
}

let servers = 0;

/** A server starts keeping (`atticus ui`); the last to close stops, letting go. */
export function startAppMemory(): void {
  servers++;
  appMemory.on = true;
}

export function stopAppMemory(): void {
  servers = Math.max(0, servers - 1);
  if (servers) return;
  appMemory.on = false;
  releaseAppMemory();
}
