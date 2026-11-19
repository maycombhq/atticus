import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import { boxPages } from "../src/screens/map/box-pages.js";

/**
 * v30 slice 8: Contracts, Impact and Decided by AI left the Map's tabs; a box's panel opens each
 * for that box.
 */

const node = (o: Partial<Api.HierNodeT>): Api.HierNodeT => ({
  id: "repo:forge-ledger",
  kind: "repo",
  label: "forge-ledger",
  childCount: 0,
  state: "current",
  gaps: [],
  evidence: [],
  properties: {},
  ...o,
});
const html = (n: Api.HierNodeT) => renderToStaticMarkup(<>{boxPages(n)}</>);

describe("a box's panel opens the Map's pages about that box", () => {
  it("a repo: its contracts, what breaks if it changes, and what the AI decided in it", () => {
    const out = html(node({ record: { kind: "Component", id: "ledger-api" } }));
    expect(out).toContain(`href="#/contracts?q=forge-ledger">${COPY.boxPages.contracts}<`);
    expect(out).toContain(`href="#/impact?q=ledger-api">${COPY.boxPages.impact}<`);
    expect(out).toContain(`href="#/decisions?repo=forge-ledger">${COPY.boxPages.decisions}<`);
  });

  it("a component: its contracts, and no Decided by AI (that is by repo)", () => {
    const out = html(node({ kind: "component", label: "ledger-api", id: "c:ledger-api" }));
    expect(out).toContain('href="#/contracts?q=ledger-api"');
    expect(out).not.toContain("#/impact");
    expect(out).not.toContain("#/decisions");
  });

  it("nothing on an outside system with no record: its arrows are declared, not read", () => {
    expect(boxPages(node({ kind: "system", label: "Northwind Pay", id: "x" }))).toEqual([]);
  });

  it("nothing for a box no contract is about (a table, the estate)", () => {
    expect(boxPages(node({ kind: "estate" }))).toEqual([]);
    expect(boxPages(node({ kind: "table" }))).toEqual([]);
  });
});
