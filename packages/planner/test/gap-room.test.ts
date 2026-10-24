import { describe, expect, it } from "vitest";
import { fitGapSources, gapSources, inCodeSources, knownSources } from "../src/gaps.js";
import { sourceTokens } from "../src/engine.js";

/**
 * The gap context takes its room from the catalog selection. At a tight budget it must not take
 * all of it: the gaps stay (they are what the model asks about), the lists of names already
 * known or found in the code (data for the model only; they are no longer gaps) give way first.
 * Seen in the context eval: a known-names block left 0 records at the tight budget.
 */
const gaps = gapSources([
  {
    name: "firewall-rule-request",
    question: "Who approves a firewall rule?",
    mentions: [],
  } as never,
]);
const known = knownSources(
  Array.from({ length: 30 }, (_, i) => ({
    name: `forge-orders.step-${i}-with-a-long-name`,
    at: `target-flows/forge-orders.place-order.yaml:${i + 10}`,
    how: "target-flow" as const,
  })),
);
const inCode = inCodeSources(
  Array.from({ length: 20 }, (_, i) => ({
    name: `OrderThing${i}`,
    at: `forge-orders:src/main/java/forge/orders/OrderThing${i}.java:3`,
  })) as never,
);

describe("the gap context's share of the room", () => {
  it("keeps everything when it fits in half the room", () => {
    const all = [...gaps, ...inCode, ...known];
    expect(fitGapSources(all, 10_000)).toEqual(all);
  });

  it("drops the known names, then the names in code, before the gaps, to leave half the room", () => {
    const all = [...gaps, ...inCode, ...known];
    const room = sourceTokens(gaps) * 2 + 10;
    const fitted = fitGapSources(all, room);
    expect(fitted.map((s) => s.id)).toEqual(gaps.map((s) => s.id));
    expect(sourceTokens(fitted)).toBeLessThanOrEqual(room / 2 + 1);
  });

  it("never drops a gap, even when the gaps alone are over half the room", () => {
    expect(fitGapSources([...gaps, ...known], 10).map((s) => s.id)).toEqual(gaps.map((s) => s.id));
  });
});
