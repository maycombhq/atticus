import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import type { CatalogRecord } from "@maycombhq/core";
import { deploymentReach, impactLines } from "../src/change-impact.js";

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

describe("a deployment row of a repo with several components", () => {
  const rec = (kind: string, id: string, x: Record<string, unknown>) =>
    ({ kind, id, ...x }) as unknown as CatalogRecord;
  const records = [
    rec("Component", "forge-svc-00", { repo: "forge-svc-00" }),
    rec("Component", "forge-svc-00-worker", { repo: "forge-svc-00" }),
    rec("Component", "forge-svc-02", { repo: "forge-svc-02" }),
    rec("Component", "forge-gw-00", { repo: "forge-gw-00" }),
    // Inside the repo: the service hands work to its own worker. Not a caller of what moves.
    rec("Interface", "i1", { from: "forge-svc-00", to: "forge-svc-00-worker", sync: "async" }),
    rec("Interface", "i2", { from: "forge-gw-00", to: "forge-svc-00", sync: "sync" }),
    rec("Interface", "i3", { from: "forge-svc-02", to: "forge-svc-00-worker", sync: "async" }),
  ];

  it("names every component it deploys, comma-joined, and leaves out links between them", () => {
    const r = deploymentReach(
      records,
      { line: 35, has: "deployment", repo: "forge-svc-00" },
      (id) => (id === "forge-gw-00" ? "team-platform" : "team-forge"),
    );
    expect(r).toEqual({
      line: 35,
      has: "deployment",
      name: "forge-svc-00, forge-svc-00-worker",
      ids: ["forge-svc-00", "forge-svc-00-worker"],
      receivers: [
        { id: "forge-gw-00", kind: "Component", owner: "team-platform" },
        { id: "forge-svc-02", kind: "Component", owner: "team-forge", events: true },
      ],
      further: 0,
    });
  });
});
