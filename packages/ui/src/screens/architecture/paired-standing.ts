import type { Api } from "@maycombhq/core";

/**
 * ADR 0199 (field report, beta.28.3: "it says it's already paired, but I don't see the line"):
 * where the calls a person paired stand. With this box: on the map (`drawn`), or in the
 * corrections and not on the map yet; with another box (`pairedBy`, and the box it goes to).
 */
export function pairedStanding(v: Api.LinkCandidatesViewT) {
  const here = v.calls.filter((c) => c.status === "paired");
  const elsewhere = v.calls.filter((c) => c.status !== "paired" && !!c.pairedBy && !!c.joins);
  return {
    /** The map draws its arrow to this box. */
    drawn: here.filter((c) => c.drawn === true).length,
    /** Paired with an API of this box, and no arrow for it on the map. */
    waiting: here.filter((c) => c.drawn !== true && !!c.paired).length,
    /** Paired with an API this box no longer has on record. */
    gone: here.filter((c) => c.drawn !== true && !c.paired).length,
    elsewhere,
  };
}
