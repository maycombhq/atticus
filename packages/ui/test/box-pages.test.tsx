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
  it("a repo, as the map draws one (no record): its contracts, its impact and what the AI decided in it", () => {
    // diagrams' hierarchy: a repo box is repo:<slug>, its name its label, and no record.
    const out = html(node({}));
    expect(out).toContain(`href="#/contracts?q=forge-ledger">${COPY.boxPages.contracts}<`);
    // Impact of a repo is asked of its components: the page lists them to pick from.
    expect(out).toContain(`href="#/impact?repo=forge-ledger">${COPY.boxPages.impact}<`);
    expect(out).toContain(`href="#/decisions?repo=forge-ledger">${COPY.boxPages.decisions}<`);
  });

  it("a component with its record: its impact by the record's id", () => {
    const out = html(
      node({
        kind: "component",
        label: "ledger-api",
        id: "component:ledger-api",
        record: { kind: "Component", id: "ledger-api" },
      }),
    );
    expect(out).toContain(`href="#/impact?q=ledger-api">${COPY.boxPages.impact}<`);
  });

  it("names each page as its page is named (one name per thing)", () => {
    expect(COPY.nav.screens.impact).toBe("Impact");
    expect(COPY.boxPages.impact).toBe("Its impact");
    expect(COPY.boxPages.contracts).toBe("Its contracts");
    expect(COPY.boxPages.decisions).toBe("Decided by AI here");
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

describe("Impact asked of a repo", () => {
  it("lists the repo's components, each opening its impact", async () => {
    const { componentsOfRepo } = await import("../src/screens/know/Know.js");
    const items = [
      { id: "ledger-api", kind: "Component", repo: "forge-ledger", name: "Ledger API" },
      { id: "ledger-worker", kind: "Component", repo: "forge-ledger" },
      { id: "ledger-ui", kind: "Component", repo: "forge-ledger-ui" },
    ];
    expect(componentsOfRepo(items, "forge-ledger").map((c) => c.id)).toEqual([
      "ledger-api",
      "ledger-worker",
    ]);
    expect(componentsOfRepo(items, "forge-none")).toEqual([]);
  });
});
