import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("asks for them by repo, not by words: a repo's name is rarely in its components' ids", async () => {
    // Forge's forge-portal-bff holds portal-bff (server.test.ts asks the real route).
    const { repoComponentsPath } = await import("../src/screens/know/Know.js");
    expect(repoComponentsPath("forge-portal-bff")).toBe(
      "/api/catalog/Component?limit=500&repo=forge-portal-bff",
    );
  });
});

describe("Impact asked of a repo, as the page shows it", () => {
  afterEach(() => vi.unstubAllGlobals());
  const ready = <T,>(data: T) => ({ state: "ready" as const, data });
  /** A fake server: the repo's components, `per` to a page, with the next cursor while more. */
  const server = (
    all: { id: string; kind: string; repo: string; name?: string }[],
    per: number,
  ) => {
    const asked: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        asked.push(url);
        const at = Number(new URL(url, "http://x").searchParams.get("cursor") ?? "0");
        const items = all.slice(at, at + per);
        const more = at + per < all.length ? { next: String(at + per) } : {};
        return new Response(JSON.stringify({ items, total: all.length, ...more }), {
          status: 200,
        });
      }),
    );
    return asked;
  };
  const LEDGER = [
    { id: "ledger-api", kind: "Component", repo: "forge-ledger", name: "Ledger API" },
    { id: "ledger-worker", kind: "Component", repo: "forge-ledger" },
  ];

  it("a repo with two components: both listed, each opening its impact", async () => {
    const asked = server(LEDGER, 500);
    const { loadRepoComponents, repoComponentsPath, RepoComponentsView } =
      await import("../src/screens/know/Know.js");
    const { setSessionToken } = await import("../src/api/client.js");
    setSessionToken("t");
    const data = await loadRepoComponents(
      repoComponentsPath("forge-ledger"),
      new AbortController().signal,
    );
    expect(asked).toEqual(["/api/catalog/Component?limit=500&repo=forge-ledger"]);
    const out = renderToStaticMarkup(<RepoComponentsView repo="forge-ledger" list={ready(data)} />);
    expect(out).toContain(COPY.know.impactOfRepo("forge-ledger"));
    expect(out).toContain('href="#/impact?q=ledger-api">ledger-api · Ledger API<');
    expect(out).toContain('href="#/impact?q=ledger-worker">ledger-worker<');
    expect(out.match(/<li>/g)).toHaveLength(2);
  });

  it("follows the next cursor: a repo with more than one page of components lists them all", async () => {
    const many = Array.from({ length: 5 }, (_, n) => ({
      id: `ledger-${n}`,
      kind: "Component",
      repo: "forge-ledger",
    }));
    const asked = server(many, 2);
    const { loadRepoComponents, repoComponentsPath, RepoComponentsView } =
      await import("../src/screens/know/Know.js");
    const { setSessionToken } = await import("../src/api/client.js");
    setSessionToken("t");
    const data = await loadRepoComponents(
      repoComponentsPath("forge-ledger"),
      new AbortController().signal,
    );
    expect(asked).toEqual([
      "/api/catalog/Component?limit=500&repo=forge-ledger",
      "/api/catalog/Component?limit=500&repo=forge-ledger&cursor=2",
      "/api/catalog/Component?limit=500&repo=forge-ledger&cursor=4",
    ]);
    const out = renderToStaticMarkup(<RepoComponentsView repo="forge-ledger" list={ready(data)} />);
    expect(out.match(/<li>/g)).toHaveLength(5);
    expect(out).toContain('href="#/impact?q=ledger-4"');
  });

  it("the Impact page opened from a repo box shows the repo's components, not an id to type", async () => {
    server(LEDGER, 500);
    const { ImpactExplorer } = await import("../src/screens/know/Know.js");
    // Rendered once, before any answer: the repo's panel, loading.
    const out = renderToStaticMarkup(<ImpactExplorer hash="#/impact?repo=forge-ledger" />);
    expect(out).toContain(COPY.know.impactOfRepo("forge-ledger"));
    expect(out).toContain('aria-busy="true"');
    const byId = renderToStaticMarkup(<ImpactExplorer hash="#/impact?q=ledger-api" />);
    expect(byId).not.toContain(COPY.know.impactOfRepo("forge-ledger"));
  });

  it("says when the repo has no component, while it loads, and why it couldn't load", async () => {
    const { RepoComponentsView } = await import("../src/screens/know/Know.js");
    const empty = renderToStaticMarkup(
      <RepoComponentsView repo="forge-none" list={ready({ items: [] })} />,
    );
    expect(empty).toContain(COPY.know.noComponentsIn("forge-none"));
    expect(empty).not.toContain("<li>");
    const loading = renderToStaticMarkup(
      <RepoComponentsView repo="forge-ledger" list={{ state: "loading" }} />,
    );
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain(COPY.know.impactOfRepo("forge-ledger"));
    const failed = renderToStaticMarkup(
      <RepoComponentsView
        repo="forge-ledger"
        list={{ state: "error", error: "the index is locked", reload: () => undefined }}
      />,
    );
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("the index is locked");
    expect(failed).toContain(COPY.app.tryAgain);
  });
});
