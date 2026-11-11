import { describe, expect, it } from "vitest";
import { parseRecord, type FlowRecord } from "@maycombhq/core";
import { applyStroke, drawnStrokes, sketchOf, Stroke, strokeIdOf } from "../src/index.js";

/**
 * ADR 0193: a component absorbed into another. Its flows move to the other component with the
 * same entries, it is retired, and every call to it now goes to the other with the same entry, so
 * the callers' contracts don't change. One stroke, one Undo. On an invented Forge estate: two
 * pass-through wrappers behind their own gateway proxies, both calling the Northwind Pay gateway.
 */

const ev = (repo: string, line: number) => [{ source: "code", repo, path: "src/App.java", line }];

const flow = (
  repo: string,
  id: string,
  component: string,
  entry: string,
  steps: object[],
): FlowRecord => {
  const r = parseRecord({
    kind: "Flow",
    schemaVersion: 2,
    id,
    component,
    name: `Flow ${id}`,
    template: "default@1",
    trigger: { kind: "endpoint", ref: entry, what: `${entry} is called`, evidence: ev(repo, 10) },
    steps: steps.map((s, i) => ({ refs: [], evidence: ev(repo, 11 + i), ...s })),
  });
  if (!r.ok || r.record.kind !== "Flow") throw new Error(JSON.stringify(r));
  return r.record;
};

const wrapper = (name: string, path: string) => ({
  repo: `forge-${name}-wrapper`,
  flow: flow(
    `forge-${name}-wrapper`,
    `forge-${name}-wrapper.get-${name}`,
    `forge-${name}-wrapper`,
    `forge-${name}-wrapper.get-${name}`,
    [
      { kind: "entry", what: `GET ${path} arrives` },
      {
        kind: "call-out",
        what: "Passed to Northwind Pay",
        to: { component: "northwind-pay-gateway", entry: `GET /v1${path}` },
      },
      { kind: "respond", what: "Northwind Pay's answer goes back" },
    ],
  ),
});

const proxy = (name: string, path: string) => ({
  repo: `forge-${name}-proxy`,
  flow: flow(
    `forge-${name}-proxy`,
    `forge-${name}-proxy.route-${name}`,
    `forge-${name}-proxy`,
    `forge-${name}-proxy.get-${name}`,
    [
      { kind: "entry", what: `GET ${path} arrives at the gateway` },
      {
        kind: "call-out",
        what: `Routed to the ${name} wrapper`,
        to: { component: `forge-${name}-wrapper`, entry: `GET ${path}` },
      },
      { kind: "respond", what: "The answer goes back" },
    ],
  ),
});

const flows = [
  wrapper("accounts", "/accounts/{id}"),
  wrapper("cards", "/cards/{id}"),
  proxy("accounts", "/accounts/{id}"),
  proxy("cards", "/cards/{id}"),
];
const records = [
  ...["accounts", "cards"].map((n) => ({
    kind: "Endpoint",
    id: `forge-${n}-wrapper.get-${n}`,
    component: `forge-${n}-wrapper`,
    method: "GET",
    pathOrTopic: `/${n}/{id}`,
  })),
  {
    kind: "Endpoint",
    id: "forge-accounts-proxy.get-accounts",
    component: "forge-accounts-proxy",
    method: "GET",
    pathOrTopic: "/accounts/{id}",
  },
];
const estate = {
  flows,
  ids: new Set([
    ...flows.flatMap((f) => [f.flow.id, f.flow.component]),
    ...records.map((r) => r.id),
    "northwind-pay-gateway",
  ]),
  byId: new Map(records.map((r) => [r.id, r as never])),
};

const absorb = (component: string, into: string, extra: object = {}) =>
  Stroke.parse({
    kind: "absorb",
    component,
    into: { component: into, ...extra },
    why: "One API service instead of a wrapper each",
  });

describe("absorbing a component into another (ADR 0193)", () => {
  it("moves its flows with the same entries, retires it, and sends its callers to the new one", () => {
    const r = applyStroke(
      [],
      absorb("forge-accounts-wrapper", "forge-api", { runsOn: { type: "service" } }),
      estate,
      "pat",
      "s1",
    );
    expect(r.problem).toBeUndefined();
    const byFlow = new Map(r.deltas.map((d) => [d.flow, d]));
    // The flow moves: a new flow of forge-api with the same trigger, entry and steps.
    const moved = byFlow.get("forge-api.get-accounts")!;
    expect(moved).toMatchObject({
      change: "new",
      repo: "forge-api",
      name: "Flow forge-accounts-wrapper.get-accounts",
      trigger: { kind: "endpoint", entry: "GET /accounts/{id}" },
      runsOn: { component: "forge-api", type: "service" },
    });
    expect(moved.steps.map((s) => [s.op, s.kind, s.to?.component, s.to?.entry])).toEqual([
      ["add", "entry", undefined, undefined],
      ["add", "call-out", "northwind-pay-gateway", "GET /v1/accounts/{id}"],
      ["add", "respond", undefined, undefined],
    ]);
    // The old flow goes.
    expect(byFlow.get("forge-accounts-wrapper.get-accounts")).toMatchObject({
      change: "remove",
      repo: "forge-accounts-wrapper",
    });
    // The proxy keeps its entry and now routes to forge-api with the same entry.
    const p = byFlow.get("forge-accounts-proxy.route-accounts")!;
    expect(p.change).toBe("modify");
    expect(p.steps.map((s) => [s.op, s.step ?? s.after, s.to?.component, s.to?.entry])).toEqual([
      ["remove", 2, undefined, undefined],
      ["add", 2, "forge-api", "GET /accounts/{id}"],
    ]);
    // The cards side is untouched.
    expect(byFlow.has("forge-cards-proxy.route-cards")).toBe(false);
    // Every part carries the one stroke's mark.
    const ids = new Set([
      ...r.deltas.map((d) => strokeIdOf(d)).filter(Boolean),
      ...r.deltas.flatMap((d) => d.steps.map((s) => strokeIdOf(s))),
    ]);
    expect(ids).toEqual(new Set(["s1"]));
    expect(r.changed.sort()).toEqual([
      "forge-accounts-proxy.route-accounts",
      "forge-accounts-wrapper.get-accounts",
      "forge-api.get-accounts",
    ]);
    // Drawn once, as one stroke, and kept as drawn for the stage.
    expect(drawnStrokes(r.deltas)).toEqual([
      expect.objectContaining({
        what: "absorbed forge-accounts-wrapper into forge-api",
        by: "pat",
      }),
    ]);
    expect(sketchOf(r.deltas)).toHaveLength(3);
  });

  it("absorbs a second component into the same one; one Undo takes back only its stroke", () => {
    const one = applyStroke([], absorb("forge-accounts-wrapper", "forge-api"), estate, "pat", "s1");
    const two = applyStroke(
      one.deltas,
      absorb("forge-cards-wrapper", "forge-api"),
      estate,
      "pat",
      "s2",
    );
    expect(two.problem).toBeUndefined();
    expect(two.deltas.map((d) => d.flow).sort()).toEqual([
      "forge-accounts-proxy.route-accounts",
      "forge-accounts-wrapper.get-accounts",
      "forge-api.get-accounts",
      "forge-api.get-cards",
      "forge-cards-proxy.route-cards",
      "forge-cards-wrapper.get-cards",
    ]);
    expect(drawnStrokes(two.deltas)).toHaveLength(2);
    const back = applyStroke(
      two.deltas,
      Stroke.parse({ kind: "undo", flow: "forge-api.get-cards", index: 0 }),
      estate,
      "pat",
    );
    expect(back.problem).toBeUndefined();
    expect(back.deltas.map((d) => d.flow).sort()).toEqual(one.deltas.map((d) => d.flow).sort());
    // Undo from the retired side, or a moved caller step, takes the same stroke back.
    for (const flow of [
      "forge-accounts-wrapper.get-accounts",
      "forge-accounts-proxy.route-accounts",
    ]) {
      const b = applyStroke(
        one.deltas,
        Stroke.parse({ kind: "undo", flow, index: 0 }),
        estate,
        "pat",
      );
      expect(b.problem).toBeUndefined();
      expect(b.deltas).toEqual([]);
    }
  });

  it("says what it can't do: an unknown component, itself, an entry the target has already, a busy flow", () => {
    const run = (s: Stroke, deltas = [] as ReturnType<typeof applyStroke>["deltas"]) =>
      applyStroke(deltas, s, estate, "pat", "s9");
    expect(run(absorb("forge-ghost", "forge-api")).problem).toBe(
      "forge-ghost isn't a component of today's map.",
    );
    expect(run(absorb("forge-api", "forge-api")).problem).toContain("into itself");
    const one = run(absorb("forge-accounts-wrapper", "forge-api"));
    // Absorbing again is refused: its flows are changed in this change already.
    expect(run(absorb("forge-accounts-wrapper", "forge-api"), one.deltas).problem).toContain(
      "changed in this change already",
    );
    // forge-accounts-proxy serves GET /accounts/{id} too: a second flow at that entry is refused.
    expect(run(absorb("forge-accounts-proxy", "forge-api"), one.deltas).problem).toContain(
      "forge-api has a flow at GET /accounts/{id} already",
    );
  });

  it("a component with no flows yet still sends its callers to the new one", () => {
    const thin = {
      ...estate,
      flows: estate.flows.filter((f) => f.flow.component !== "forge-cards-wrapper"),
    };
    const r = applyStroke([], absorb("forge-cards-wrapper", "forge-api"), thin, "pat", "s3");
    expect(r.problem).toBeUndefined();
    expect(r.deltas.map((d) => [d.flow, d.change])).toEqual([
      ["forge-cards-proxy.route-cards", "modify"],
    ]);
    expect(r.deltas[0]!.steps[1]).toMatchObject({
      to: { component: "forge-api", entry: "GET /cards/{id}" },
    });
  });

  it("keeps a moved flow's id clear of one the target has", () => {
    const taken = {
      ...estate,
      ids: new Set([...estate.ids, "forge-api.get-accounts"]),
    };
    const r = applyStroke([], absorb("forge-accounts-wrapper", "forge-api"), taken, "pat", "s4");
    expect(r.deltas.map((d) => d.flow)).toContain("forge-api.get-accounts-2");
  });

  it("moves the flows under a path prefix, so two components serving the same path can merge (ADR 0193)", () => {
    // A prefix puts the moved flows under their own path on forge-api, so wrappers that serve
    // the same paths can merge; the proxy's call goes to the prefixed path (its own contract is
    // unchanged: only where it routes changes).
    const first = applyStroke(
      [],
      absorb("forge-accounts-wrapper", "forge-api", { runsOn: { type: "service" } }),
      estate,
      "pat",
      "s1",
    );
    const r = applyStroke(
      first.deltas,
      absorb("forge-cards-wrapper", "forge-api", { prefix: "/legacy-cards" }),
      estate,
      "pat",
      "s2",
    );
    expect(r.problem).toBeUndefined();
    const moved = r.deltas.find((d) => d.flow === "forge-api.get-cards")!;
    expect(moved.trigger?.entry).toBe("GET /legacy-cards/cards/{id}");
    const proxy = r.deltas.find((d) => d.flow === "forge-cards-proxy.route-cards")!;
    expect(proxy.steps.find((s) => s.op === "add")?.to).toEqual({
      component: "forge-api",
      entry: "GET /legacy-cards/cards/{id}",
      new: false,
    });
    // Without a prefix the paths stay as they are; a prefix must start with a slash.
    const clash = applyStroke(
      first.deltas,
      Stroke.parse({
        kind: "absorb",
        component: "forge-cards-wrapper",
        into: { component: "forge-api" },
        why: "w",
      }),
      { ...estate },
      "pat",
      "s3",
    );
    expect(clash.problem).toBeUndefined();
    expect(
      Stroke.safeParse({
        kind: "absorb",
        component: "a",
        into: { component: "b", prefix: "no-slash" },
        why: "w",
      }).success,
    ).toBe(false);
  });
});
