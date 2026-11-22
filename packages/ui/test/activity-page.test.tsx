import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ACTIVITY_TABS,
  activityHref,
  activityTabOf,
  movedHash,
  type ActivityTab,
} from "../src/app/screens.js";
import { initialTabs, openTab, readTabs, TABS_KEY } from "../src/app/shell/tabs-model.js";
import { pageTitle, screenOf } from "../src/app/screens.js";
import { SectionTabs } from "../src/app/tabs.js";
import { ACTIVITY_LABELS, ActivityPage } from "../src/screens/activity/ActivityPage.js";
import { COPY } from "../src/copy.js";
import { SCREEN_COMPONENTS } from "../src/screens/registry.js";

/**
 * v30 slice 8 (fewer pages): Model runs, Prompt history, Scans and Catalog builds are the tabs of
 * one Activity page. Each tab is the page it was; its old address opens it, query kept.
 */

const stub = (t: ActivityTab) => {
  const S = ({ hash }: { hash: string }) => <p data-tab={t}>{`${t} at ${hash}`}</p>;
  return S;
};
const TABS = Object.fromEntries(ACTIVITY_TABS.map((t) => [t, stub(t)])) as Record<
  ActivityTab,
  ReturnType<typeof stub>
>;
const page = (hash: string) => renderToStaticMarkup(<ActivityPage hash={hash} tabs={TABS} />);

describe("the Activity page", () => {
  it("names its four tabs by the pages they were, in order", () => {
    expect(ACTIVITY_TABS.map((t) => ACTIVITY_LABELS[t])).toEqual([
      "Model runs",
      "Prompt history",
      "Scans",
      "Catalog builds",
    ]);
    expect(COPY.nav.screens.activity).toBe("Activity");
  });

  it("shows the tab its address asks for, marked as the current page, and passes the address on", () => {
    const out = page("#/activity?tab=scans");
    expect(out).toContain(`aria-label="${COPY.nav.activityTabs}"`);
    expect(out).toMatch(/href="#\/activity\?tab=scans" aria-current="true">Scans</);
    expect(out).toContain('data-tab="scans"');
    expect(out).not.toContain('data-tab="runs"');
    expect(out).toContain(COPY.nav.activityIntro.replace("'", "&#x27;"));
  });

  it("opens Model runs when no tab is asked, or one it doesn't know", () => {
    expect(activityTabOf("#/activity")).toBe("runs");
    expect(activityTabOf("#/activity?tab=nope")).toBe("runs");
    expect(page("#/activity")).toMatch(/aria-current="true">Model runs</);
  });

  it("reads an old address as its tab, so a page never shows the wrong tab mid-redirect", () => {
    expect(activityTabOf("#/history?change=x")).toBe("history");
    expect(activityTabOf("#/catalog-builds?at=undo")).toBe("catalog-builds");
    expect(page("#/runs?run=run-1")).toContain("runs at #/runs?run=run-1");
  });

  it("builds a tab's address with its own query", () => {
    expect(activityHref("runs", { run: "run-1", q: undefined })).toBe(
      "#/activity?tab=runs&run=run-1",
    );
    expect(activityHref("history")).toBe("#/activity?tab=history");
  });

  it("is wired, and each old address opens its tab", () => {
    expect(SCREEN_COMPONENTS.activity).toBeDefined();
    for (const t of ACTIVITY_TABS) {
      expect(movedHash(`#/${t}`)).toBe(`#/activity?tab=${t}`);
      expect(SCREEN_COMPONENTS[t]).toBeUndefined();
    }
  });

  it("keeps an IDE tab at the new address, never the old", () => {
    const s = openTab(initialTabs(), "#/runs?run=run-1");
    expect(s.active).toBe("activity");
    expect(s.tabs.find((t) => t.key === "activity")!.hash).toBe("#/activity?tab=runs&run=run-1");
  });

  it("brings back IDE tabs kept at an old address at the new place, the one shown still shown", () => {
    const saved: Record<string, string> = {
      [TABS_KEY]: JSON.stringify({
        active: "runs",
        tabs: [
          { key: "home", hash: "#/home" },
          { key: "runs", hash: "#/runs?run=run-1" },
          { key: "map", hash: "#/map" },
        ],
      }),
    };
    const store = { getItem: (k: string) => saved[k] ?? null, setItem: () => undefined };
    const s = readTabs(store)!;
    expect(s.active).toBe("activity");
    expect(s.tabs.map((t) => [t.key, t.hash])).toEqual([
      ["home", "#/home"],
      ["activity", "#/activity?tab=runs&run=run-1"],
      ["canvas", "#/canvas"],
    ]);
  });

  it("names the tab shown in the title, the heading and where-you-are, with one current page", () => {
    const at = (h: string) => pageTitle(screenOf(h), h);
    expect(at("#/activity?tab=scans")).toBe("Activity › Scans");
    expect(at("#/runs?run=x")).toBe("Activity › Model runs");
    expect(at("#/trust")).toBe("Read status");
    const crumbs = renderToStaticMarkup(
      <SectionTabs current={screenOf("#/activity?tab=history")} hash="#/activity?tab=history" />,
    );
    expect(crumbs).toContain('<span aria-current="location">Activity › Prompt history</span>');
    const both = crumbs + page("#/activity?tab=history");
    expect(both.match(/aria-current="page"/g)).toHaveLength(1);
  });

  it("says Map once where you are on the Map, not Map › Map", () => {
    const crumbs = renderToStaticMarkup(
      <SectionTabs current={screenOf("#/canvas")} hash="#/canvas" />,
    );
    expect(crumbs).not.toContain(
      'Map</span><span aria-hidden="true"> › </span><span aria-current="location">Map',
    );
    expect(crumbs).not.toContain('aria-current="location"');
  });
});
