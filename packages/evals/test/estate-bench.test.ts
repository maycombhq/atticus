import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, type CatalogRecord, type FlowRecord } from "@maycombhq/core";
import { monorepoPlace, scoreEstateFlows } from "../src/estate-bench.js";
import { parseReferenceFlows } from "../src/spec-bench.js";

/**
 * Scoring the estate the facts make (ADR 0124 addendum C-join) against reference flows: each
 * reference flow followed across repos through the joins, its steps matched in order, and the
 * fields at each crossing. The estate is the scanner's golden one (fixtures/estate-facts).
 */

const ESTATE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/estate-facts");
const golden = () => {
  const g = parse(readFileSync(join(ESTATE, "expected", "estate.yaml"), "utf8")) as {
    records: unknown[];
    specs: { repo: string; flows: unknown[] }[];
    joins: { from: { flow: string; step: number }; to: { flow: string } }[];
  };
  const rec = (x: unknown) => {
    const p = parseRecord(x);
    if (!p.ok) throw new Error(JSON.stringify(p.issues));
    return p.record;
  };
  return {
    records: g.records.map(rec) as CatalogRecord[],
    specs: g.specs.map((s) => ({ repo: s.repo, flows: s.flows.map(rec) as FlowRecord[] })),
    joins: g.joins,
  };
};
const ref = () => parseReferenceFlows(readFileSync(join(ESTATE, "reference-flows.yaml"), "utf8"));

describe("scoreEstateFlows: reference flows against the estate the facts make", () => {
  it("follows the flow through the joins: steps in order across three repos, fields at each crossing", () => {
    const s = scoreEstateFlows(ref(), golden());
    expect(s.flows).toEqual([
      {
        flow: "add-customer",
        start: "web-app.add-a-customer",
        startBy: "trigger",
        steps: 10,
        stepsInOrder: 9,
        // The entry step: the facts name the entry, not a step for it.
        missed: ["3 entry forge-customers"],
        crossings: [
          { step: 2, want: 7, found: 6, missed: ["createdAt"] },
          { step: 6, want: 2, found: 2, missed: [] },
        ],
      },
    ]);
    expect(s.total).toEqual({
      flows: 1,
      started: 1,
      startedByTrigger: 1,
      steps: 10,
      stepsInOrder: 9,
      crossingFields: { want: 9, found: 8 },
      strict: { steps: 10, stepsInOrder: 9, crossingFields: { want: 9, found: 8 } },
    });
  });

  it("without the joins, the flow stops at the first crossing", () => {
    const s = scoreEstateFlows(ref(), { ...golden(), joins: [] });
    expect(s.total.stepsInOrder).toBe(3);
  });

  it("starts at the flow that matches most steps when no trigger is cited where the reference's is, and says so", () => {
    const r = ref();
    r.flows[0]!.trigger.at = "src/app/customers/new-customer.component.ts:2";
    const s = scoreEstateFlows(r, golden());
    expect(s.flows[0]).toMatchObject({ start: "web-app.add-a-customer", startBy: "best" });
    expect(s.total).toMatchObject({
      started: 1,
      startedByTrigger: 0,
      strict: { steps: 10, stepsInOrder: 0, crossingFields: { want: 9, found: 0 } },
    });
  });

  it("of the flows whose triggers are near the reference's (routes on neighbouring lines), starts at the one matching most steps", () => {
    const r = ref();
    // Line 10 is the customer page's route; the add-customer flow's is line 9, both within 3.
    r.flows[0]!.trigger.at = "src/app/app.routes.ts:10";
    const s = scoreEstateFlows(r, golden());
    expect(s.flows[0]).toMatchObject({ start: "web-app.add-a-customer", startBy: "trigger" });
  });

  it("places a monorepo's folders as the reference's repos", () => {
    const place = monorepoPlace("src/");
    expect(place("shop", "src/cartservice/src/CartService.cs")).toEqual({
      repo: "cartservice",
      path: "src/CartService.cs",
    });
    expect(place("shop", "protos/demo.proto")).toEqual({ repo: "shop", path: "protos/demo.proto" });
  });
});
