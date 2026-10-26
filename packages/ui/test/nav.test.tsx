import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MORE_KEY, Nav, paletteKeys, readMore, saveMore } from "../src/app/nav.js";
import { morePages, screenOf } from "../src/app/screens.js";

// The menu (the ADR 0124 D-app addendum's follow-up, 2026-10-25): the six entries, then More
// pages, always there, collapsed until a person opens it, then the Ctrl+K hint.

/** A browser's localStorage, or one that refuses (private windows, blocked site data). */
function storage(o: { value?: string; throws?: boolean } = {}) {
  const saved: Record<string, string> = o.value === undefined ? {} : { [MORE_KEY]: o.value };
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

const at = (hash: string, full = false) =>
  renderToStaticMarkup(<Nav current={screenOf(hash)} hash={hash} full={full} />);

const COUNT = morePages().reduce((n, g) => n + g.pages.length, 0);

describe("the menu's More pages", () => {
  it("is there on first load, closed, naming how many pages it holds", () => {
    const html = at("#/home");
    expect(COUNT).toBe(26);
    expect(html).toMatch(
      new RegExp(`<button type="button"[^>]*aria-expanded="false"[^>]*>.*More pages.*${COUNT}`),
    );
    expect(html).toContain('aria-controls="more-pages"');
    expect(html).toMatch(/id="more-pages"[^>]*hidden=""/);
  });

  it("lists every page the six don't show, by section, Change's by phase", () => {
    const html = at("#/home");
    for (const g of morePages())
      for (const p of g.pages) expect(html).toContain(`href="#/${p.id}"`);
    for (const label of ["Map", "Change", "Knowledge", "Set up", "Atticus", "Plan", "Build"])
      expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain(">Prompt history<");
    expect(html).toContain(">Estimate<");
    // Model runs is a tab of Set up, not under More.
    expect(html).not.toContain('href="#/runs"');
  });

  it("keeps the change a page is about, else opens the page as Ctrl+K does", () => {
    expect(at("#/home")).toContain('href="#/estimate"');
    expect(at("#/stories?change=add-transfer-limit")).toContain(
      'href="#/estimate?change=add-transfer-limit"',
    );
  });

  it("opens by itself on a page it holds, marking that page", () => {
    const html = at("#/history");
    expect(html).toContain('aria-expanded="true"');
    expect(html).toMatch(/href="#\/history" aria-current="page"/);
    expect(html).not.toMatch(/id="more-pages"[^>]*hidden/);
  });

  it("starts open with atticus ui --full", () => {
    expect(at("#/home", true)).toContain('aria-expanded="true"');
  });

  it("keeps the six entries in their own group, Model runs marking Set up", () => {
    const html = at("#/runs");
    expect(html).toMatch(/href="#\/repos" aria-current="page">Set up</);
  });

  it("shows the Ctrl+K hint, Cmd on a Mac", () => {
    expect(at("#/home")).toMatch(/Ctrl\+K: any page/);
    expect(paletteKeys("MacIntel")).toBe("Cmd+K");
    expect(paletteKeys("iPad")).toBe("Cmd+K");
    expect(paletteKeys("Win32")).toBe("Ctrl+K");
    expect(paletteKeys("Linux x86_64")).toBe("Ctrl+K");
    expect(paletteKeys(undefined)).toBe("Ctrl+K");
  });
});

describe("whether More pages is open, remembered per viewer", () => {
  it("is unknown until the viewer chooses, then remembered", () => {
    const s = storage();
    expect(readMore(s)).toBeUndefined();
    saveMore(true, s);
    expect(s.saved[MORE_KEY]).toBe("open");
    expect(readMore(s)).toBe(true);
    saveMore(false, s);
    expect(readMore(s)).toBe(false);
  });

  it("ignores what it doesn't know, and a storage that refuses", () => {
    expect(readMore(storage({ value: "sideways" }))).toBeUndefined();
    expect(readMore(storage({ throws: true }))).toBeUndefined();
    expect(() => saveMore(true, storage({ throws: true }))).not.toThrow();
    expect(readMore(undefined)).toBeUndefined();
  });
});
