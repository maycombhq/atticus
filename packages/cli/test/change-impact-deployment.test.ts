import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { impactLines } from "../src/change-impact.js";

/**
 * A deployment row of a quick change's In the code (the persona check of beta.30, and its
 * review): who calls the component it moves, and, apart, who sends it events. Pure; invented
 * Forge names.
 */

const impact = (receivers: NonNullable<Api.ChangeImpactT["reaches"]>[number]["receivers"]) =>
  ({
    change: "move-to-anvil",
    flows: 0,
    from: "design",
    breaks: 0,
    mayBreak: 0,
    routes: 0,
    rule: "constitution.change-links-known",
    items: [],
    owners: [],
    problems: [],
    reaches: [
      {
        line: 35,
        has: "deployment",
        name: "forge-svc-00",
        ids: ["forge-svc-00"],
        receivers,
        further: 0,
      },
    ],
  }) as Api.ChangeImpactT;

describe("a deployment row's impact", () => {
  it("says who calls what moves, and who sends it events, apart", () => {
    const lines = impactLines(
      impact([
        { id: "forge-gw-00", kind: "Component", owner: "team-platform" },
        { id: "forge-svc-02", kind: "Component", owner: "team-forge", events: true },
      ]),
    );
    expect(lines).toContain(
      "  Called by forge-gw-00 (team-platform): each must still reach it where it is deployed.",
    );
    expect(lines).toContain(
      "  Sent events by forge-svc-02 (team-forge): each must still reach it where it is deployed.",
    );
  });

  it("says only who sends events when nothing calls it", () => {
    const lines = impactLines(impact([{ id: "forge-svc-02", kind: "Component", events: true }]));
    expect(lines.filter((l) => l.startsWith("  Called by"))).toEqual([]);
    expect(lines).toContain(
      "  Sent events by forge-svc-02: each must still reach it where it is deployed.",
    );
  });
});
