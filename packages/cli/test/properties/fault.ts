import type { Extractor } from "@maycombhq/sdk";

/**
 * The reader fault the property tests inject (ADR 0195 point 10: the readers are the mock reader
 * adapter, CLAUDE.md rule 5): while `on` names a repo, a scan runs one more extractor, which
 * throws on that repo, so its run fails as a broken reader's would.
 */
export const fault: { on: string | undefined } = { on: undefined };

/**
 * The scanner with the fault wired in, for `vi.mock("@maycombhq/scanner", ...)`. The extractor's
 * version names the repo it fails on, so a run the scan cache kept from another fault (where it
 * read this repo without failing) is never taken for this one.
 */
export function withFault<T extends { scanEstate: (o: never) => unknown }>(real: T): T {
  const scanEstate = (o: { extractors?: Extractor[] }) => {
    const on = fault.on;
    if (!on) return real.scanEstate(o as never);
    const boom: Extractor = {
      id: "northwind-reader",
      version: `1.0.0-fails-on.${on}`,
      claims: ["**/*"],
      // eslint-disable-next-line require-yield
      async *scan(repo) {
        if (repo.name === on) throw new Error("the reader stopped on a file it can't parse");
      },
    };
    return real.scanEstate({ ...o, extractors: [...(o.extractors ?? []), boom] } as never);
  };
  return { ...real, scanEstate };
}
