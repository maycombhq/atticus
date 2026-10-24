import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { screenOf } from "../src/app/screens.js";
import { COPY } from "../src/copy.js";
import { EstimateView } from "../src/screens/work/Estimate.js";

/** The Estimate (ADR 0109): ranges with their drivers and sources, never a bare number. */

const E = COPY.estimate;
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

const EST: Api.ChangeEstimateT = {
  change: "add-fraud-check",
  title: "Screen orders for fraud",
  source: "openspec/changes/add-fraud-check/target-flows",
  units: [
    {
      flow: "forge-orders.place-order",
      repo: "forge-orders",
      step: 2,
      what: "Northwind Pay screens the order",
      class: "add/call-out/vendor/new-entry",
      days: { p20: 2, p50: 3, p80: 5 },
      source: "openspec/changes/add-fraud-check/target-flows/forge-orders.place-order.yaml",
    },
    {
      flow: "forge-orders.place-order",
      repo: "forge-orders",
      step: 4,
      what: "The verdict is logged",
      class: "add/log",
      source: "openspec/changes/add-fraud-check/target-flows/forge-orders.place-order.yaml",
    },
  ],
  needsClass: 1,
  effort: { p20: 2.1, p50: 3, p80: 6.2 },
  perRepo: [{ repo: "forge-orders", units: 2, effort: { p20: 2.1, p50: 3, p80: 5 } }],
  drivers: [
    {
      id: "new-vendor-call",
      what: "New calls to a vendor",
      count: 1,
      source: "openspec/changes/add-fraud-check/target-flows/forge-orders.place-order.yaml",
    },
    { id: "open-blocking", what: "Open blocking findings", count: 2, widens: 1.3 },
  ],
  calendar: { effortDays: 6.2, waitDays: 9, longer: "waiting" },
  calibration: { calibrated: false, source: "the Forge platform team (invented)" },
  table: "org-pack/estimates.yaml",
  problems: [],
};

describe("the Estimate (ADR 0109)", () => {
  it("is a tab of a change, in Plan (ADR 0119)", () => {
    expect(screenOf("#/estimate?change=add-fraud-check")).toMatchObject({
      id: "estimate",
      group: "Plan",
    });
  });

  it("shows the range, how much of the work it covers, and that it isn't calibrated, whose figures", () => {
    const out = renderToStaticMarkup(<EstimateView e={EST} />);
    expect(out).toContain(esc(E.effortRange(2.1, 6.2, 3)));
    expect(out).toContain(esc(E.from(1, 2)));
    expect(out).toContain(
      esc(E.notCalibrated("the Forge platform team (invented)", "org-pack/estimates.yaml")),
    );
    expect(out).toContain(esc(E.waiting(9)));
    expect(out).toContain(esc(E.longer("waiting")));
  });

  it("names each driver with its effect and source, and each unit with its class, or that it needs one", () => {
    const out = renderToStaticMarkup(<EstimateView e={EST} />);
    expect(out).toContain(esc(E.widens(1.3)));
    expect(out).toContain("add/call-out/vendor/new-entry");
    expect(out).toContain(`<strong>${esc(E.needsClass)}</strong>`);
    expect(out).toContain(esc(E.days({ p20: 2, p50: 3, p80: 5 })));
  });

  it("without ranges says why there are no days, never inventing one", () => {
    const out = renderToStaticMarkup(
      <EstimateView
        e={{
          ...EST,
          effort: undefined,
          table: undefined,
          needsClass: 2,
          units: EST.units.map(({ days: _d, ...u }) => u),
        }}
      />,
    );
    expect(out).toContain(esc(E.noTable));
    expect(out).not.toContain(esc(E.effortRange(2.1, 6.2, 3)));
  });

  it("before the architecture stage gives the command that writes the target flows", () => {
    const out = renderToStaticMarkup(
      <EstimateView e={{ ...EST, units: [], needsClass: 0, effort: undefined }} />,
    );
    expect(out).toContain(esc(E.noTargets("add-fraud-check")));
    expect(out).toContain("atticus change architecture add-fraud-check");
  });
});
