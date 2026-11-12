import type { Extractor } from "@maycombhq/sdk";

/**
 * The reader faults the property tests inject (ADR 0195 point 10: the readers are the mock reader
 * adapter, CLAUDE.md rule 5), the harness's own, so a system under test need do nothing for them
 * but read through `scanEstate`:
 * - while `on` names a repo, a scan runs one more extractor, which throws on that repo, as a
 *   broken reader would;
 * - while `cancel` holds an AbortController, that extractor aborts it on the first repo it reads,
 *   as the app's cancel would (ADR 0119: the harness runs the scan inside `withSignal`).
 * `fired` counts the times either happened, so a command that expected its fault can tell it
 * never came (the scan didn't read through the mocked scanner, or skipped the repo).
 */
export const fault: { on: string | undefined; cancel: AbortController | undefined; fired: number } =
  { on: undefined, cancel: undefined, fired: 0 };

/**
 * The scanner with the faults wired in, for `vi.mock("@maycombhq/scanner", ...)`. The extractor's
 * version names the repo it fails on, so a run the scan cache kept from another fault (where it
 * read this repo without failing) is never taken for this one.
 */
let cancels = 0;

export function withFault<T extends { scanEstate: (o: never) => unknown }>(real: T): T {
  const scanEstate = (o: { extractors?: Extractor[] }) => {
    const on = fault.on;
    const cancel = fault.cancel;
    if (!on && !cancel) return real.scanEstate(o as never);
    const boom: Extractor = {
      id: "northwind-reader",
      // A cancelling run's version is new each time: the scan cache never holds it, so it runs
      // (and cancels) on the first repo whatever ran before. A cancelled run writes no slot.
      version: on ? `1.0.0-fails-on.${on}` : `1.0.0-cancels.${++cancels}`,
      claims: ["**/*"],
      // eslint-disable-next-line require-yield
      async *scan(repo) {
        if (cancel && !cancel.signal.aborted) {
          fault.fired++;
          cancel.abort();
        }
        if (on && repo.name === on) {
          fault.fired++;
          throw new Error("the reader stopped on a file it can't parse");
        }
      },
    };
    return real.scanEstate({ ...o, extractors: [...(o.extractors ?? []), boom] } as never);
  };
  return { ...real, scanEstate };
}
