import { describe, expect, it } from "vitest";
import {
  closeTab,
  HOME_KEY,
  initialTabs,
  MAX_TABS,
  moveTab,
  openTab,
  readTabs,
  restoreTabs,
  saveTabs,
  tabKeyOf,
  tabLabel,
  TABS_KEY,
  type TabsState,
} from "../src/app/shell/tabs-model.js";

/**
 * ADR 0194: the IDE layout's tabs. Opening a page opens or focuses its tab; a change's pages
 * share the change's tab; Home stays first and can't be closed; at most MAX_TABS are open (the
 * least recently used closes); the tabs and the active one are kept per browser. The address
 * stays the page shown: the model only follows it. Invented Forge changes.
 */

function storage(o: { value?: string; throws?: boolean } = {}) {
  const saved: Record<string, string> = o.value === undefined ? {} : { [TABS_KEY]: o.value };
  return {
    saved,
    getItem: (k: string) => {
      if (o.throws) throw new Error("SecurityError");
      return saved[k] ?? null;
    },
    setItem: (k: string, v: string) => {
      if (o.throws) throw new Error("QuotaExceededError");
      saved[k] = v;
    },
  };
}

const keys = (s: TabsState) => s.tabs.map((t) => t.key);

describe("a tab per page", () => {
  it("keys a page by its screen, a change's pages by the change, old addresses by their page", () => {
    expect(tabKeyOf("#/home")).toBe(HOME_KEY);
    expect(tabKeyOf("")).toBe(HOME_KEY);
    expect(tabKeyOf("#/dashboard")).toBe(HOME_KEY);
    expect(tabKeyOf("#/no-such-page")).toBe(HOME_KEY);
    expect(tabKeyOf("#/canvas?arrow=a1")).toBe("canvas");
    expect(tabKeyOf("#/explore?ask=who%20calls")).toBe("explore");
    expect(tabKeyOf("#/changes")).toBe("changes");
    expect(tabKeyOf("#/changes/add-transfer-limit")).toBe("change:add-transfer-limit");
    expect(tabKeyOf("#/stories?change=add-transfer-limit")).toBe("change:add-transfer-limit");
    // A Change page with no change picked is its own page.
    expect(tabKeyOf("#/stories")).toBe("stories");
    // A Questions page scoped to a change is still Questions.
    expect(tabKeyOf("#/questions?change=add-transfer-limit")).toBe("questions");
  });

  it("names a tab by its page, a change's by the change", () => {
    expect(tabLabel({ key: "canvas", hash: "#/canvas", used: 1 })).toEqual({
      label: "Estate canvas",
      title: "Estate canvas",
    });
    expect(
      tabLabel({
        key: "change:add-transfer-limit",
        hash: "#/stories?change=add-transfer-limit",
        used: 1,
      }),
    ).toEqual({ label: "add-transfer-limit", title: "add-transfer-limit · Stories" });
  });

  it("starts with Home, opens a new page's tab and focuses one already open", () => {
    let s = initialTabs();
    expect(keys(s)).toEqual([HOME_KEY]);
    expect(s.active).toBe(HOME_KEY);
    s = openTab(s, "#/canvas");
    s = openTab(s, "#/questions");
    expect(keys(s)).toEqual([HOME_KEY, "canvas", "questions"]);
    expect(s.active).toBe("questions");
    // Back on the canvas, with an arrow picked: the same tab, its address kept.
    s = openTab(s, "#/canvas?arrow=a1");
    expect(keys(s)).toEqual([HOME_KEY, "canvas", "questions"]);
    expect(s.active).toBe("canvas");
    expect(s.tabs[1]!.hash).toBe("#/canvas?arrow=a1");
    // A change's stages move within its tab.
    s = openTab(s, "#/changes/add-transfer-limit");
    s = openTab(s, "#/stories?change=add-transfer-limit");
    expect(keys(s)).toEqual([HOME_KEY, "canvas", "questions", "change:add-transfer-limit"]);
    expect(s.tabs[3]!.hash).toBe("#/stories?change=add-transfer-limit");
    // Opening the page shown changes nothing.
    expect(openTab(s, "#/stories?change=add-transfer-limit")).toBe(s);
  });

  it("closes a tab, going to its right neighbour, else its left; Home stays", () => {
    let s = initialTabs();
    for (const h of ["#/canvas", "#/questions", "#/trust"]) s = openTab(s, h);
    s = openTab(s, "#/questions");
    const a = closeTab(s, "questions");
    expect(keys(a.state)).toEqual([HOME_KEY, "canvas", "trust"]);
    expect(a.state.active).toBe("trust");
    expect(a.go).toBe("#/trust");
    const b = closeTab(a.state, "trust");
    expect(b.state.active).toBe("canvas");
    expect(b.go).toBe("#/canvas");
    // An inactive tab closes without moving.
    const c = closeTab(openTab(b.state, "#/trust"), "canvas");
    expect(c.go).toBeUndefined();
    expect(keys(c.state)).toEqual([HOME_KEY, "trust"]);
    // Home is never closed, nor is a tab that isn't open.
    expect(closeTab(c.state, HOME_KEY).state).toBe(c.state);
    expect(closeTab(c.state, "nope").state).toBe(c.state);
    // The last tab after Home closes back to Home.
    const d = closeTab(c.state, "trust");
    expect(keys(d.state)).toEqual([HOME_KEY]);
    expect(d.go).toBe("#/home");
  });

  it("caps the open tabs, closing the least recently used one, never Home or the one shown", () => {
    let s = initialTabs();
    const pages = ["canvas", "flows", "contracts", "impact", "trust", "decisions", "questions"];
    const more = ["knowledge", "wikis", "documents", "wiki-search", "repos", "ai", "runs"];
    for (const p of [...pages, ...more]) s = openTab(s, `#/${p}`);
    expect(s.tabs).toHaveLength(MAX_TABS);
    expect(s.tabs[0]!.key).toBe(HOME_KEY);
    // The three used longest ago went: canvas, flows and contracts.
    for (const gone of ["canvas", "flows", "contracts"]) expect(keys(s)).not.toContain(gone);
    expect(s.active).toBe("runs");
    // Using impact again keeps it past the next page; trust goes instead.
    s = openTab(s, "#/impact");
    s = openTab(s, "#/orgpack");
    expect(s.tabs).toHaveLength(MAX_TABS);
    expect(keys(s)).toContain("impact");
    expect(keys(s)).not.toContain("trust");
  });

  it("moves a tab left or right, Home staying first", () => {
    let s = initialTabs();
    for (const h of ["#/canvas", "#/questions", "#/trust"]) s = openTab(s, h);
    s = moveTab(s, "trust", -1);
    expect(keys(s)).toEqual([HOME_KEY, "canvas", "trust", "questions"]);
    s = moveTab(s, "canvas", -1);
    expect(keys(s)).toEqual([HOME_KEY, "canvas", "trust", "questions"]);
    s = moveTab(s, "questions", 1);
    expect(keys(s)).toEqual([HOME_KEY, "canvas", "trust", "questions"]);
    expect(moveTab(s, HOME_KEY, 1)).toBe(s);
  });
});

describe("the tabs, kept per browser", () => {
  it("saves and restores the tabs and the one shown", () => {
    const st = storage();
    let s = initialTabs();
    for (const h of ["#/canvas", "#/changes/add-transfer-limit", "#/questions"]) s = openTab(s, h);
    saveTabs(s, st);
    const back = readTabs(st)!;
    expect(keys(back)).toEqual(keys(s));
    expect(back.active).toBe("questions");
    // A reload keeps the address: the page it names is shown, the other tabs come back.
    const r = restoreTabs(back, "#/canvas?arrow=a2");
    expect(keys(r)).toEqual(keys(s));
    expect(r.active).toBe("canvas");
    expect(r.tabs[1]!.hash).toBe("#/canvas?arrow=a2");
    // A deep link to a page not open adds its tab.
    expect(keys(restoreTabs(back, "#/trust"))).toEqual([...keys(s), "trust"]);
    // No address: the tab that was shown.
    expect(restoreTabs(back, "").active).toBe("questions");
  });

  it("ignores what it can't read, and a storage that refuses", () => {
    expect(readTabs(storage())).toBeUndefined();
    expect(readTabs(storage({ value: "{not json" }))).toBeUndefined();
    expect(readTabs(storage({ value: '{"tabs":"x"}' }))).toBeUndefined();
    expect(readTabs(storage({ throws: true }))).toBeUndefined();
    expect(readTabs(undefined)).toBeUndefined();
    expect(() => saveTabs(initialTabs(), storage({ throws: true }))).not.toThrow();
    // Addresses that aren't the app's pages are dropped; Home is put back first; the cap holds.
    const odd = JSON.stringify({
      active: "canvas",
      tabs: [
        { key: "canvas", hash: "#/canvas" },
        { key: "x", hash: "javascript:alert(1)" },
        { key: "canvas", hash: "#/canvas" },
        ...Array.from({ length: 20 }, (_, i) => ({ key: `change:c${i}`, hash: `#/changes/c${i}` })),
      ],
    });
    const r = readTabs(storage({ value: odd }))!;
    expect(r.tabs[0]!.key).toBe(HOME_KEY);
    expect(r.tabs.filter((t) => t.key === "canvas")).toHaveLength(1);
    expect(keys(r)).not.toContain("x");
    expect(r.tabs).toHaveLength(MAX_TABS);
    expect(r.active).toBe("canvas");
    // A saved key is worked out again from its address.
    const wrong = JSON.stringify({ active: "a", tabs: [{ key: "a", hash: "#/trust" }] });
    expect(keys(readTabs(storage({ value: wrong }))!)).toEqual([HOME_KEY, "trust"]);
  });
});
