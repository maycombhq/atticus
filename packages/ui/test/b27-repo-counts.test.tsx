import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { COPY } from "../src/copy.js";
import {
  manifestRepoCount,
  manifestRepos,
  mapRepos,
  repoCountsOf,
} from "../src/app/repo-counts.js";
import { ExplorerView, systemsHeader } from "../src/app/shell/Explorer.js";
import { systemItems, treeRepos, type SectionModel } from "../src/app/shell/explorer-model.js";
import { shellCounts } from "../src/app/shell/Shell.js";
import { StatusBar } from "../src/app/shell/StatusBar.js";

/**
 * Beta.27 review: "repos" means the manifest's repos wherever a count of them shows. Beta.27's
 * first cut said 4 repos in the Explorer's Systems header (the map's repo boxes), 7 in the status
 * bar (the manifest) and 1/1/2/1 on the systems' rows (repos and components no repo holds). One
 * estate (the invented Forge one) and every place that counts its repos.
 */

const E = COPY.explorer;

const node = (
  id: string,
  kind: string,
  label: string,
  parent: string,
  properties: Record<string, string | number | boolean | string[]> = {},
) => ({ id, kind, label, parent, childCount: 0, properties });

/** The map: four repos with a box, and a system holding a component but no repo. */
const ESTATE = {
  children: [
    node("system:ledger", "system", "Ledger", "estate", { boundary: "product" }),
    node("system:payments", "system", "Payments", "estate", { boundary: "product" }),
    node("system:cards", "system", "Cards", "estate", { boundary: "product" }),
    node("system:northwind-pay", "system", "Northwind Pay", "estate", { boundary: "outside" }),
    node("repo:forge-ledger", "repo", "forge-ledger", "system:ledger"),
    node("repo:forge-payments-common", "repo", "forge-payments-common", "system:ledger"),
    node("repo:forge-proxy-ledger-v1", "repo", "forge-proxy-ledger-v1", "system:ledger"),
    node("repo:forge-teller", "repo", "forge-teller", "system:payments"),
    node("component:card-limits", "component", "card-limits", "system:cards", { type: "service" }),
    node("component:payments-batch", "component", "payments-batch", "system:payments", {
      type: "worker",
    }),
    node("component:ledger-api", "component", "ledger-api", "repo:forge-ledger", {
      type: "service",
    }),
  ],
};
/** GET /api/trust: the manifest's seven repos (gateway, events and infra have no box). */
const TRUST = {
  repos: [
    "forge-ledger",
    "forge-payments-common",
    "forge-proxy-ledger-v1",
    "forge-teller",
    "forge-gateway",
    "forge-events",
    "forge-infra",
  ].map((repo) => ({ repo })),
};

describe("repos are the manifest's, the same wherever they are counted", () => {
  it("counts the manifest's repos, those on the map and those not", () => {
    expect(manifestRepos(TRUST)).toHaveLength(7);
    expect(mapRepos(ESTATE.children)).toEqual([
      "forge-ledger",
      "forge-payments-common",
      "forge-proxy-ledger-v1",
      "forge-teller",
    ]);
    expect(repoCountsOf(TRUST, ESTATE)).toEqual({
      repos: 7,
      onMap: 4,
      notOnMap: ["forge-events", "forge-gateway", "forge-infra"],
    });
    // Neither read alone is the count.
    expect(repoCountsOf(undefined, ESTATE)).toBeUndefined();
    expect(repoCountsOf(TRUST, undefined)).toBeUndefined();
    expect(manifestRepoCount({})).toBeUndefined();
  });

  it("agrees in the status bar, the Explorer's header, its tree and its rows", () => {
    const c = repoCountsOf(TRUST, ESTATE)!;
    // The status bar: the manifest's.
    const shell = shellCounts(undefined, undefined, TRUST);
    expect(shell.repos).toBe(7);
    const bar = renderToStaticMarkup(<StatusBar facts={shell} />);
    expect(bar).toContain(COPY.ide.repos(7));
    // The header: how many of them the map has.
    expect(systemsHeader(c)).toBe(E.reposOnMap(4, 7));
    expect(E.reposOnMap(4, 7)).toBe("4 of 7 repos on the map");
    expect(systemsHeader({ repos: 3, onMap: 3, notOnMap: [] })).toBe(E.repos(3));
    expect(systemsHeader(undefined)).toBeUndefined();
    // The tree: every manifest repo once, the ones with no box under Not on the map.
    const items = systemItems(ESTATE, c.notOnMap);
    expect(treeRepos(items)).toBe(7);
    const last = items.at(-1)!;
    expect(last).toMatchObject({ label: E.notOnMap, count: 3, countOf: "repos", hash: "#/trust" });
    expect(last.children!.map((x) => x.label)).toEqual([
      "forge-events",
      "forge-gateway",
      "forge-infra",
    ]);
    // A system's row counts its repos only; one with none says so; an outside one is marked.
    const row = (label: string) => items.find((i) => i.label === label)!;
    expect(row("Ledger")).toMatchObject({ count: 3, countOf: "repos" });
    expect(row("Payments")).toMatchObject({ count: 1, countOf: "repos" });
    expect(row("Cards").count).toBeUndefined();
    expect(row("Cards").detail).toBe(E.noRepo);
    expect(row("Cards").children!.map((x) => x.label)).toEqual(["card-limits"]);
    expect(row("Northwind Pay")).toMatchObject({ kind: "outside" });
    expect(row("Northwind Pay").detail).toBeUndefined();
    // The rows' repos add up to the header's on the map, and Not on the map to the rest.
    const onMapRows = items
      .filter((i) => i.countOf === "repos" && i.id !== "systems/not-on-map")
      .reduce((n, i) => n + (i.count ?? 0), 0);
    expect(onMapRows).toBe(c.onMap);
    expect(onMapRows + last.count!).toBe(c.repos);
    // As the Explorer draws it: the header's words, and a repo row's count said as components.
    const sections: SectionModel[] = [
      {
        id: "systems",
        open: true,
        state: "ready",
        items,
        count: systemsHeader(c)!,
      },
    ];
    const html = renderToStaticMarkup(
      <ExplorerView
        current="#/home"
        filter=""
        sections={sections}
        expanded={new Set(["systems/system:ledger", "systems/not-on-map"])}
        focus={{}}
        pinnedHere={false}
        onFilter={() => undefined}
        onToggleSection={() => undefined}
        onToggleItem={() => undefined}
        onOpen={() => undefined}
        onRetry={() => undefined}
        onPinHere={() => undefined}
        onTreeKey={() => undefined}
        onTreeFocus={() => undefined}
      />,
    );
    expect(html).toContain(`>${E.reposOnMap(4, 7)}<`);
    expect(html).toContain(E.spoken("Ledger", E.repos(3)));
    expect(html).toContain(E.spoken("forge-ledger", E.components(1)));
    expect(html).toContain(E.spoken("Cards", E.noRepo));
    expect(html).toContain("forge-gateway");
  });
});
