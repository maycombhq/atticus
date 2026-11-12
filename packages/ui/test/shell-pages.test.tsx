import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COPY } from "../src/copy.js";
import { paletteItems } from "../src/app/palette.js";
import {
  landingOf,
  morePages,
  OLD_ADDRESSES,
  SCREENS,
  screenOf,
  SECTIONS,
  tabsOf,
  type ScreenDef,
} from "../src/app/screens.js";
import { LAYOUT_KEY } from "../src/app/shell/layout.js";
import { SCREEN_COMPONENTS } from "../src/screens/registry.js";

/**
 * ADR 0194, "no page lost": every page of the screen registry, every old address and every kind
 * of address the app handles (a change's own, a page with ?change=, a record's) is reachable in
 * the IDE layout (from the activity bar, a section's tabs, More pages in the activity bar, or
 * Ctrl+K) and in the classic one (the menu, the tabs, More pages, Ctrl+K), and renders inside
 * either layout without an error. Rendered as markup with no server: each page shows its
 * loading state. Invented Forge names.
 */

const saved: Record<string, string> = {};
const g = globalThis as unknown as Record<string, unknown>;
const before = { location: g.location, localStorage: g.localStorage, document: g.document };
beforeAll(() => {
  // A browser's page, as far as rendering asks: no editor's theme class on its body.
  g.document = {
    body: { classList: { contains: () => false } },
    documentElement: { dataset: {}, style: {} },
    getElementById: () => null,
  };
  g.localStorage = {
    getItem: (k: string) => saved[k] ?? null,
    setItem: (k: string, v: string) => void (saved[k] = v),
    removeItem: (k: string) => void delete saved[k],
  };
});
afterAll(() => {
  g.location = before.location;
  g.localStorage = before.localStorage;
  g.document = before.document;
});

const { App } = await import("../src/app/App.js");

/** Every address the app handles, by kind: each page, its old addresses, a change's and a record's. */
const CHANGE = "add-transfer-limit";
const ROUTES: string[] = [
  "#/",
  "",
  ...SCREENS.map((s) => `#/${s.id}`),
  ...Object.keys(OLD_ADDRESSES).map((a) => `#/${a}`),
  `#/changes/${CHANGE}`,
  ...SCREENS.filter((s) => s.section === "Change").map((s) => `#/${s.id}?change=${CHANGE}`),
  `#/questions?change=${CHANGE}&role=architecture`,
  "#/explore?ask=who%20calls%20ledger-api",
  "#/explore?q=ledger-api",
  "#/features?id=feature.transfers",
  "#/systems?id=ledger",
  "#/no-such-page",
];

type Entry = "activity bar" | "section tab" | "More pages" | "Ctrl+K" | "menu";

/** Where a person finds a page in the IDE layout. */
function ideEntries(s: ScreenDef): Entry[] {
  const out: Entry[] = [];
  if (SECTIONS.some((x) => landingOf(x).id === s.id) || s.id === "settings")
    out.push("activity bar");
  if (tabsOf(s.section).some((t) => t.id === s.id)) out.push("section tab");
  if (morePages().some((g) => g.pages.some((p) => p.id === s.id))) out.push("More pages");
  if (paletteItems(s.label, [], []).some((i) => i.href === `#/${s.id}`)) out.push("Ctrl+K");
  return out;
}

/** Where a person finds a page in the classic layout: the same, with the menu for the bar. */
const classicEntries = (s: ScreenDef): Entry[] =>
  ideEntries(s).map((e) => (e === "activity bar" ? "menu" : e));

function render(hash: string, layout: "ide" | "classic"): string {
  saved[LAYOUT_KEY] = layout;
  g.location = { hash, replace: () => undefined };
  return renderToStaticMarkup(<App />);
}

describe("no page lost in the IDE layout", () => {
  it("finds every page of the registry from the bar, a tab, More pages or Ctrl+K", () => {
    const lost: string[] = [];
    for (const s of SCREENS) {
      const e = ideEntries(s);
      // Ctrl+K finds every page; each also has a place to click, or is a page reached by a link
      // from another page (an aside), which Ctrl+K finds too.
      if (!e.includes("Ctrl+K") || (e.length < 2 && !s.aside))
        lost.push(`${s.id}: ${e.join(", ")}`);
    }
    expect(lost).toEqual([]);
  });

  it("puts each section's first page and every More pages page in the activity bar", () => {
    const html = render("#/home", "ide");
    for (const s of SECTIONS) expect(html).toContain(`href="#/${landingOf(s).id}"`);
    expect(html).toContain('href="#/settings"');
    for (const grp of morePages())
      for (const p of grp.pages) expect(html).toContain(`href="#/${p.id}"`);
  });

  it.each(ROUTES)("renders %s inside the shell, in its tab, without an error", (hash) => {
    const html = render(hash, "ide");
    const s = screenOf(hash);
    expect(html).toMatch(/<div class="sh[ "]/);
    expect(html.match(/<main /g)).toHaveLength(1);
    expect(html).toMatch(/<main id="main"[^>]*class="sh-main"/);
    expect(html).toMatch(/role="tabpanel" aria-labelledby="sh-tab-[^"]+" class="sh-page"/);
    expect(html).toContain(`<h1 class="sr">${s.label.replace(/&/g, "&amp;")}</h1>`);
    expect(html).toContain(COPY.shell.skipToContent);
    expect(html).toContain('<nav aria-label="Main" class="sh-activity">');
    expect(html).toContain('role="tablist"');
    // The page's own component, never the "being built" note.
    expect(SCREEN_COMPONENTS[s.id], s.id).toBeDefined();
    expect(html).not.toContain(COPY.notBuilt.thisScreenIsBeing);
    // The tab shown is this page's.
    expect(html).toMatch(/role="tab" class="sh-tab[^"]*" aria-selected="true"/);
  });
});

describe("no page lost in the classic layout", () => {
  it("finds every page of the registry from the menu, a tab, More pages or Ctrl+K", () => {
    const lost = SCREENS.filter((s) => {
      const e = classicEntries(s);
      return !e.includes("Ctrl+K") || (e.length < 2 && !s.aside);
    }).map((s) => s.id);
    expect(lost).toEqual([]);
  });

  it.each(ROUTES)("renders %s in the classic layout, as before", (hash) => {
    const html = render(hash, "classic");
    expect(html).toMatch(/^<div class="shell">/);
    expect(html).not.toMatch(/<div class="sh[ "]/);
    expect(html.match(/<main /g)).toHaveLength(1);
    expect(html).toContain('<main id="main" class="main" tabindex="-1">');
    expect(html).toContain('<nav aria-label="Main" class="nav">');
    expect(html).toContain('role="search" class="ask-form"');
    expect(html).toContain(`<h1 class="sr">${screenOf(hash).label.replace(/&/g, "&amp;")}</h1>`);
  });
});
