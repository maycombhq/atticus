import type { Api } from "@maycombhq/core";
import { COPY } from "../../copy.js";

type Call = Api.LinkCandidatesViewT["calls"][number];

/** Who paired these calls, in words: the people by name, the AI as the AI (the review, S6). */
export function pairedWho(calls: readonly Call[]): string {
  const people = [
    ...new Set(calls.filter((c) => !c.pairedAi && c.pairedBy).map((c) => c.pairedBy!)),
  ].sort();
  return COPY.connect.pairedWho(
    people,
    calls.some((c) => c.pairedAi),
  );
}

/**
 * ADR 0199 (field report, beta.28.3: "it says it's already paired, but I don't see the line"):
 * where the paired calls stand. With this box: on the map (`drawn`), in the corrections and not
 * on the map yet, paired with an API the box lost, or inside one component (never an arrow);
 * with another box (`pairedBy`, and the box it goes to). A call that goes to this very box
 * (`here`: a repo drawn inside it) is not with another box (the review, S7).
 */
export function pairedStanding(v: Api.LinkCandidatesViewT) {
  const here = v.calls.filter((c) => c.status === "paired");
  const inside = here.filter((c) => !!c.inside);
  const rest = here.filter((c) => !c.inside);
  return {
    /** Every call paired with this box. */
    here,
    /** The map draws its arrow to this box. */
    drawn: rest.filter((c) => c.drawn === true),
    /** Paired with an API of this box, and no arrow for it on the map. */
    waiting: rest.filter((c) => c.drawn !== true && !!c.paired),
    /** Paired with an API this box no longer has on record. */
    gone: rest.filter((c) => c.drawn !== true && !c.paired),
    /** Both ends in one component: no arrow is drawn between boxes. */
    inside,
    elsewhere: v.calls.filter(
      (c) => c.status !== "paired" && c.status !== "here" && !!c.pairedBy && !!c.joins,
    ),
  };
}
