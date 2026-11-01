import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import { ImpactView } from "../src/screens/work/Impact.js";

/** A change's impact on its Architecture tab (ADR 0144, V1). */

const I = COPY.changeImpact;
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

const IMPACT: Api.ChangeImpactT = {
  change: "hold-stock",
  flows: 2,
  breaks: 2,
  mayBreak: 1,
  routes: 1,
  rule: "constitution.change-links-known",
  items: [
    {
      kind: "endpoint",
      flow: "forge-stock.reserve-stock",
      repo: "forge-stock",
      id: "forge-stock.post-stock-reservations",
      name: "POST /stock/reservations",
      why: ["it no longer returns reservationId"],
      fields: { gone: ["reservationId"], required: [] },
      owner: { team: "team-stock", name: "Stock team" },
      callers: [
        {
          component: "forge-mobile",
          repo: "forge-mobile",
          verdict: "may-break",
          guessed: "joined-by-path",
          interfaces: ["if-1a9099e78c189509"],
          flows: [],
          routes: [],
          at: ["forge-mobile src/stock/reserve.ts:7"],
          owner: { team: "team-mobile" },
        },
        {
          component: "forge-partner",
          repo: "forge-partner",
          verdict: "breaks",
          interfaces: ["if-8fafe6cc046fe865"],
          flows: [],
          routes: ["gw-stock-v1"],
          at: ["forge-partner src/partner/StockClient.java:22"],
          owner: { none: "no repos.manifest.yaml lists forge-partner, so no team owns it" },
        },
      ],
      routes: [
        {
          id: "gw-stock-v1",
          proxy: "stock-v1",
          basepath: "/stock/v1",
          repo: "forge-gateway",
          at: [],
          callers: ["forge-partner"],
          owner: { team: "team-platform" },
        },
      ],
    },
  ],
  owners: [{ owner: { team: "team-mobile" }, repos: ["forge-mobile"] }],
  problems: [],
};

describe("a change's impact on its Architecture tab (ADR 0144)", () => {
  it("counts the sure breaks apart from the guessed ones, and links the critic's rule", () => {
    const out = renderToStaticMarkup(<ImpactView i={IMPACT} />);
    expect(out).toContain(esc(I.counts(2, 1, 1)));
    expect(out).toContain(esc(I.mayBreak("by path")));
    expect(out).toContain(esc(I.confirm("constitution.change-links-known")));
    expect(out).toContain("reservationId");
    expect(out).toContain(esc(I.route("gw-stock-v1", ["forge-partner"])));
    expect(out).toContain("Stock team");
    expect(out).toContain(
      esc(I.noTeam("no repos.manifest.yaml lists forge-partner, so no team owns it")),
    );
    // The table names its columns and has a caption.
    expect(out).toContain("<caption");
    expect(out).toContain('scope="col"');
  });

  it("has an empty state for no target flows (with the command) and for nothing broken", () => {
    const none = renderToStaticMarkup(<ImpactView i={{ ...IMPACT, flows: 0, items: [] }} />);
    expect(none).toContain(esc(I.noTargets("hold-stock")));
    expect(none).toContain("atticus change architecture hold-stock");
    const clean = renderToStaticMarkup(<ImpactView i={{ ...IMPACT, items: [] }} />);
    expect(clean).toContain(esc(I.nothing));
  });
});
