/**
 * The time each phase of a build takes (beta.28.1, field report 6): told to `buildPhases.on`
 * when a caller listens (the speed tests and the benchmark), nothing otherwise. A phase is named
 * by a few words; the time is wall-clock milliseconds since the phase before it, and (beta.28.2)
 * the CPU milliseconds the process used meanwhile, every thread's (a worker's hashing included).
 */
export const buildPhases: { on?: (phase: string, ms: number, cpuMs: number) => void } = {};

const cpuMsNow = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};

/** A clock for one run: each call says the phase that just ended. */
export function phaseClock(prefix: string): (phase: string) => void {
  const on = buildPhases.on;
  if (!on) return () => undefined;
  let t = performance.now();
  let c = cpuMsNow();
  return (phase) => {
    const now = performance.now();
    const cpu = cpuMsNow();
    on(`${prefix}${phase}`, now - t, cpu - c);
    t = now;
    c = cpu;
  };
}
