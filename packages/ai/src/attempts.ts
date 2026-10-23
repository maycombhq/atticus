import { sha256 } from "./context.js";
import type { Run } from "./runtime.js";

/**
 * Which attempt a resumed run is, and whether its answer repeats the last one. A step that checks
 * its AI answer hands back what failed as `attempt N` (the answer) and `checks on attempt N` (the
 * problems). Through a hand-off each attempt is a new run, resumed by the command line, so the
 * count is read back from the run's own context pack: without it, a step that never gets a good
 * answer hands it back forever. An answer word for word the one that just failed won't pass the
 * checks it failed, so the step stops instead of asking again.
 */
export function resumedAttempt(run: Run): { attempt: number; repeats: boolean } {
  let last = 0;
  for (const s of run.request.pack.manifest.sources) {
    const m = /^checks on attempt (\d+)$/.exec(s.origin);
    if (m) last = Math.max(last, Number(m[1]));
  }
  const previous = run.request.pack.manifest.sources.find((s) => s.origin === `attempt ${last}`);
  const repeats =
    last > 0 &&
    run.output !== undefined &&
    previous !== undefined &&
    (previous.sha256 === sha256(run.output) || previous.sha256 === sha256(run.output.trim()));
  return { attempt: last + 1, repeats };
}
