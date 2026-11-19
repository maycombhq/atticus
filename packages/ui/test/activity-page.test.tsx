import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ACTIVITY_TABS,
  activityHref,
  activityTabOf,
  movedHash,
  type ActivityTab,
} from "../src/app/screens.js";
import { openTab, initialTabs } from "../src/app/shell/tabs-model.js";
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
    expect(out).toMatch(/href="#\/activity\?tab=scans" aria-current="page">Scans</);
    expect(out).toContain('data-tab="scans"');
    expect(out).not.toContain('data-tab="runs"');
    expect(out).toContain(COPY.nav.activityIntro.replace("'", "&#x27;"));
  });

  it("opens Model runs when no tab is asked, or one it doesn't know", () => {
    expect(activityTabOf("#/activity")).toBe("runs");
    expect(activityTabOf("#/activity?tab=nope")).toBe("runs");
    expect(page("#/activity")).toMatch(/aria-current="page">Model runs</);
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
});
