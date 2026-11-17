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
 * on the map yet, paired with an API the box lost, inside one component (never an arrow), or
 * carried on to another box (`onward`: a gateway forwards it, or a person's answer outranks an
 * AI pairing; its one arrow goes to that box, the second review's M1). With another box
 * (`pairedBy`, and the box the pairing names). A call that goes to this very box (`here`: a
 * repo drawn inside it) is not with another box (the review, S7).
 */
export function pairedStanding(v: Api.LinkCandidatesViewT) {
  const here = v.calls.filter((c) => c.status === "paired");
  const inside = here.filter((c) => !!c.inside);
  const onward = here.filter((c) => !c.inside && !!c.joins);
  const rest = here.filter((c) => !c.inside && !c.joins);
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
    /** Paired with this box and carried on to another (`joins`), where its arrow is. */
    onward,
    elsewhere: v.calls.filter(
      (c) => c.status !== "paired" && c.status !== "here" && !!c.pairedBy && !!c.joins,
    ),
  };
}

/**
 * The paired calls carried on to another box, by why and where and whether that arrow is
 * drawn: each group is one sentence.
 */
export function onwardGroups(calls: readonly Call[]) {
  const groups = new Map<
    string,
    { why: "forwarded" | "outranked" | "tied"; where: string; drawn: boolean; calls: Call[] }
  >();
  for (const c of calls) {
    const why = c.onward ?? "tied";
    const drawn = c.drawn === true;
    const k = `${why}\u0000${c.joins!}\u0000${String(drawn)}`;
    const g = groups.get(k) ?? { why, where: c.joins!, drawn, calls: [] };
    g.calls.push(c);
    groups.set(k, g);
  }
  return [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, g]) => g);
}
