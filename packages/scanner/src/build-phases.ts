/**
 * The time each phase of a build takes (beta.28.1, field report 6): told to `buildPhases.on`
 * when a caller listens (the speed tests and the benchmark), nothing otherwise. A phase is named
 * by a few words; the time is wall-clock milliseconds since the phase before it.
 */
export const buildPhases: { on?: (phase: string, ms: number) => void } = {};

/** A clock for one run: each call says the phase that just ended. */
export function phaseClock(prefix: string): (phase: string) => void {
  const on = buildPhases.on;
  if (!on) return () => undefined;
  let t = performance.now();
  return (phase) => {
    const now = performance.now();
    on(`${prefix}${phase}`, now - t);
    t = now;
  };
}
