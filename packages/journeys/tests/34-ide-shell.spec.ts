import { accessible, catalogFiles, expect, forgeJourney, open, test } from "../support/app.js";

/**
 * ADR 0194 (beta.26): the IDE layout. A title bar whose box opens Ctrl+K; an activity bar of the
 * six sections, More pages and Settings; the side panel; a tab per open page that the address
 * follows (Back and Forward too), kept on a reload; the page; the bottom panel; a status bar.
 * What was typed into a page comes back when its tab does. The classic layout stays a setting
 * away. Each width works without scrolling sideways. Invented Forge names.
 */
const app = forgeJourney();
// The side panel shows, as it does for a person on a wide window.
test.use({ sideHidden: false });
const CHANGE = "add-transfer-limit";

const sideways = (page: import("@playwright/test").Page) =>
  page.evaluate<boolean>(
    "document.documentElement.scrollWidth > document.documentElement.clientWidth",
  );

test("lays out the title bar, the activity bar, the tabs, the page and the status bar", async ({
  page,
}) => {
  await open(page, app(), "home");
  await expect(page.getByRole("banner")).toContainText("ATTICUS");
  await expect(
    page.getByRole("button", { name: /^Search the estate, ask, or run a command/ }),
  ).toBeVisible();
  const bar = page.getByRole("navigation", { name: "Main" });
  await expect(bar.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
  await expect(bar.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "#/settings");
  const tabs = page.getByRole("tablist", { name: "Open pages" });
  await expect(tabs.getByRole("tab", { name: "Home" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel", { name: "Home" })).toBeVisible();
  await expect(page.locator("main")).toHaveCount(1);
  await expect(page.getByRole("complementary", { name: "Explorer" })).toBeVisible();
  const status = page.getByRole("contentinfo", { name: "Status" });
  await expect(status).toContainText(/v2\.0\.0/);
  await expect(status).toContainText(/local API \d+\.\d+/);
  // Once Home loaded them, the counts it already has: no request of the shell's own.
  await expect(status.getByRole("link", { name: /questions? to answer$/ })).toBeVisible();
  await expect(status.getByRole("link", { name: /^\d+ repos?$/ })).toBeVisible();
  await accessible(page, "the IDE layout on Home, dark");
  await page.getByLabel("Theme").selectOption("light");
  await accessible(page, "the IDE layout on Home, light");
  await page.getByLabel("Theme").selectOption("dark");
  // Beta.27: the same counts on a page that doesn't load them (the map), opened first.
  await open(page, app(), "canvas");
  const there = page.getByRole("contentinfo", { name: "Status" });
  await expect(there.getByRole("link", { name: /^\d+ repos?$/ })).toBeVisible();
  await expect(there.getByRole("link", { name: /questions? to answer$/ })).toBeVisible();
});

test("opens a tab per page, focuses one already open, closes one, and follows Back", async ({
  page,
}) => {
  await open(page, app(), "home");
  const bar = page.getByRole("navigation", { name: "Main" });
  const tabs = page.getByRole("tablist", { name: "Open pages" });
  await bar.getByRole("link", { name: "Map" }).click();
  await expect(page).toHaveURL(/#\/canvas$/);
  await expect(tabs.getByRole("tab", { name: "Estate canvas" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await bar.getByRole("link", { name: /^Questions/ }).click();
  await expect(tabs.getByRole("tab")).toHaveCount(3);
  // The Map again: its tab, not a new one.
  await bar.getByRole("link", { name: "Map" }).click();
  await expect(tabs.getByRole("tab")).toHaveCount(3);
  await expect(tabs.getByRole("tab", { name: "Estate canvas" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  // A change's stages share the change's tab.
  await page.goto(`${app().url}/#/stories?change=${CHANGE}`);
  await expect(tabs.getByRole("tab", { name: CHANGE })).toHaveAttribute("aria-selected", "true");
  await page.goto(`${app().url}/#/architecture?change=${CHANGE}`);
  await expect(tabs.getByRole("tab")).toHaveCount(4);
  // The keyboard: arrows move along the tabs, Enter shows one and focus stays on it.
  await tabs.getByRole("tab", { name: CHANGE }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(tabs.getByRole("tab", { name: /^Questions/ })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/questions$/);
  await expect(tabs.getByRole("tab", { name: /^Questions/ })).toBeFocused();
  await accessible(page, "the tabs, Questions shown");
  // Delete closes it; the tab to its right is shown.
  await page.keyboard.press("Delete");
  await expect(tabs.getByRole("tab")).toHaveCount(3);
  await expect(page).toHaveURL(new RegExp(`#/architecture\\?change=${CHANGE}$`));
  // Home has no close.
  await tabs.getByRole("tab", { name: "Home" }).focus();
  await page.keyboard.press("Delete");
  await expect(tabs.getByRole("tab")).toHaveCount(3);
  // A reload keeps the tabs and the one shown.
  await page.reload();
  await expect(page.locator(".panel").first()).toBeVisible();
  await expect(tabs.getByRole("tab")).toHaveText([
    /^Home$/,
    /^Estate canvas/,
    new RegExp(`^${CHANGE}`),
  ]);
  await expect(tabs.getByRole("tab", { name: CHANGE })).toHaveAttribute("aria-selected", "true");
  // Back goes to the page before, in its tab.
  await tabs.getByRole("tab", { name: "Estate canvas" }).click();
  await expect(page).toHaveURL(/#\/canvas$/);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`#/architecture\\?change=${CHANGE}$`));
  await expect(tabs.getByRole("tab", { name: CHANGE })).toHaveAttribute("aria-selected", "true");
});

test("keeps what was typed into a page, and what was opened, when its tab comes back", async ({
  page,
}) => {
  // Beta.27 review: Questions opens on the kind that has questions (here the owner questions);
  // the steps' list, with its filter, is asked for by name.
  await open(page, app(), "questions?kind=steps");
  const filter = page.locator("#questions-filter");
  await filter.fill("ledger");
  const tabs = page.getByRole("tablist", { name: "Open pages" });
  // The map's tools, opened, with a filter typed.
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Map" }).click();
  const show = page.getByRole("button", { name: "Show the tools" }).first();
  await show.click();
  const box = page.locator(".canvas-tools-body input[type=search]").first();
  await box.fill("teller");
  await tabs.getByRole("tab", { name: /^Questions/ }).click();
  await expect(page.locator("#questions-filter")).toHaveValue("ledger");
  await tabs.getByRole("tab", { name: "Estate canvas" }).click();
  await expect(page.locator(".canvas-tools-body input[type=search]").first()).toHaveValue("teller");
});

test("the bottom panel holds the Console, and a scan started from a page shows in Runs", async ({
  page,
}) => {
  await open(page, app(), "scans");
  const panel = page.getByRole("region", { name: "Panel" });
  await panel.getByRole("button", { name: "Show the panel" }).click();
  const tabs = panel.getByRole("tablist", { name: "Panel tabs" });
  await expect(tabs.getByRole("tab", { name: /^Console/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await accessible(page, "the bottom panel open on the Console");
  const before = catalogFiles(app().root);
  expect(Object.keys(before).length).toBeGreaterThan(20);
  await page.getByRole("button", { name: "Check with the built-in readers" }).click();
  // No repo is cloned here, so the scan writes nothing and says so in the page, each repo with why
  // and what to do; the catalog is as it was (ADR 0195 point 4: a scan that read nothing).
  await expect(page.getByText("Nothing written: the catalog is as it was.")).toBeVisible({
    timeout: 60_000,
  });
  await expect(
    page.getByRole("list", { name: "Repos the scan didn't read in full" }).getByRole("listitem"),
  ).toHaveCount(7);
  await expect(
    page.getByText("forge-ledger: not cloned here. Sync repos, then check again."),
  ).toBeVisible();
  expect(catalogFiles(app().root)).toEqual(before);
  await tabs.getByRole("tab", { name: /^Runs/ }).click();
  const runs = panel.getByRole("list", { name: "Recent runs" });
  await expect(runs).toContainText(/Scan/);
  await accessible(page, "the bottom panel's runs");
  // The run keeps its lines: picked, the Console shows the refusal in words.
  await runs.getByRole("button", { name: /Scan/ }).first().click();
  await expect(tabs.getByRole("tab", { name: /^Console/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  // ADR 0195 point 4: the nothing-read guard writes no slot either, and says so.
  await expect(panel.getByRole("log")).toContainText(
    "Nothing written: the scan read no repo in full, so every slot and catalog/generated are as they were",
  );
  await expect(panel.getByRole("log")).toContainText(
    "forge-ledger: not cloned here; clone it with Sync repos on Set up › Repos (in a terminal: atticus workspace sync)",
  );
  await panel.getByRole("button", { name: "Hide the panel" }).click();
});

test("More pages and Settings are in the activity bar, and the classic layout a setting away", async ({
  page,
}) => {
  await open(page, app(), "home");
  const bar = page.getByRole("navigation", { name: "Main" });
  const more = bar.getByRole("button", { name: /^More pages \d+$/ });
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await more.click();
  await expect(page.locator("#more-pages a")).toHaveCount(21);
  await accessible(page, "More pages open in the activity bar");
  // Escape closes it and gives the focus back.
  await page.keyboard.press("Escape");
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await expect(more).toBeFocused();
  await more.click();
  await page.locator("#more-pages").getByRole("link", { name: "AI quality" }).click();
  await expect(page).toHaveURL(/#\/evals$/);
  await expect(more).toHaveAttribute("aria-expanded", "false");
  // Ctrl+K switches to the classic layout; the menu is back, More pages and all.
  await page.keyboard.press("Control+k");
  await page.keyboard.type("classic");
  const dialog = page.getByRole("dialog", { name: "Go to anything" });
  await expect(dialog.getByRole("option").first()).toContainText("Switch to the classic layout");
  await page.keyboard.press("Enter");
  await expect(page.locator(".nav")).toBeVisible();
  await expect(page.getByRole("tablist", { name: "Open pages" })).toHaveCount(0);
  await expect(page.getByLabel("Ask Atticus")).toBeVisible();
  await page.reload();
  await expect(page.locator(".nav")).toBeVisible();
  // Settings › Layout brings the IDE layout back.
  await page.goto(`${app().url}/#/settings`);
  await page.getByRole("radio", { name: /IDE \(new\)/ }).check();
  await expect(page.getByRole("tablist", { name: "Open pages" })).toBeVisible();
  await expect(page.getByRole("radio", { name: /IDE \(new\)/ })).toBeChecked();
  await accessible(page, "Settings with the layout");
});

test("on a narrow window the side panel lies over the page; on a phone the bar is at the foot", async ({
  page,
}) => {
  await page.setViewportSize({ width: 820, height: 900 });
  await open(page, app(), "home");
  const side = page.getByRole("complementary", { name: "Explorer" });
  await expect(side).toBeHidden();
  const toggle = page.getByRole("button", { name: "Show the side panel" });
  await toggle.click();
  await expect(side).toBeVisible();
  // Opened, the panel has the focus; Escape closes it and gives the focus back to its button.
  await expect(side.locator(":focus")).toHaveCount(1);
  await accessible(page, "the side panel over the page at 820 px");
  await page.keyboard.press("Escape");
  await expect(side).toBeHidden();
  await expect(toggle).toBeFocused();
  expect(await sideways(page)).toBe(false);
  for (const route of ["home", "canvas", `changes/${CHANGE}`, "questions"]) {
    await page.setViewportSize({ width: 420, height: 860 });
    await open(page, app(), route);
    const bar = (await page.getByRole("navigation", { name: "Main" }).boundingBox())!;
    const main = (await page.locator("main").boundingBox())!;
    expect(bar.y, `${route}: the activity bar is under the page`).toBeGreaterThan(main.y);
    expect(await sideways(page), `${route} scrolls sideways`).toBe(false);
  }
  await accessible(page, "Questions at 420 px");
});

test("in an editor's panel there is no second activity bar, and every page is still reachable", async ({
  page,
}) => {
  // A VS Code webview's body carries the editor's theme class (theme.ts inEditor).
  await page.addInitScript({
    content: `(() => {
      const mark = () => document.body.classList.add("vscode-dark");
      if (document.body) return mark();
      new MutationObserver((_m, o) => {
        if (document.body) {
          mark();
          o.disconnect();
        }
      }).observe(document, { childList: true, subtree: true });
    })();`,
  });
  await page.setViewportSize({ width: 780, height: 900 });
  await open(page, app(), "home");
  await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);
  await expect(page.getByRole("banner")).toHaveCount(0);
  await expect(page.getByRole("contentinfo", { name: "Status" })).toHaveCount(0);
  const tools = page.getByRole("group", { name: "Page tools" });
  await tools.getByRole("button", { name: /^More pages/ }).click();
  await expect(page.locator("#more-pages a")).toHaveCount(21);
  await page.keyboard.press("Escape");
  await tools.getByRole("button", { name: /^Search the estate/ }).click();
  await expect(page.getByRole("dialog", { name: "Go to anything" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Show the side panel" }).click();
  await expect(page.getByRole("complementary", { name: "Explorer" })).toBeVisible();
  // The side panel lies over the page this narrow: Esc closes it.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("complementary", { name: "Explorer" })).toBeHidden();

  // Ctrl+K from the keyboard, as the tab strip's search button opens it.
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Go to anything" });
  await expect(palette).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);

  // The AI chip is in the tab strip's tools when AI is limited here, as it is in the title bar.
  const me = (await (await page.request.get(`${app().url}/api/me`)).json()) as { ai?: string };
  await expect(tools.getByText(/^(AI OFF|TEXT-ONLY AI)$/)).toHaveCount(
    me.ai && me.ai !== "on" ? 1 : 0,
  );

  // Words opens the glossary; Help replays the tour.
  await tools.getByRole("link", { name: "Words" }).click();
  await expect(page).toHaveURL(/#\/words$/);
  await tools.getByRole("button", { name: "Help" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Skip the tour" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // The bottom panel opens, switches tabs and closes.
  const panel = page.getByRole("region", { name: "Panel" });
  await panel.getByRole("button", { name: "Show the panel" }).click();
  const panelTabs = panel.getByRole("tablist", { name: "Panel tabs" });
  await expect(panelTabs.getByRole("tab", { name: /^Console/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await panelTabs.getByRole("tab", { name: /^Questions/ }).click();
  await expect(panelTabs.getByRole("tab", { name: /^Questions/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await accessible(page, "the bottom panel in an editor's panel");
  await panel.getByRole("button", { name: "Hide the panel" }).click();
  await expect(panel.getByRole("button", { name: "Show the panel" })).toBeVisible();

  // The map in an editor's panel: its one bar of controls, the details over the canvas.
  await open(page, app(), "canvas");
  const bar = page.getByRole("group", { name: "Map controls" });
  await expect(bar.getByRole("tab", { name: "Architecture" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(bar.getByRole("button", { name: "Zoom in" })).toBeVisible();
  // Beta.27 review: with nothing picked, the details (over the canvas this narrow) start closed;
  // Show details opens them.
  await expect(page.locator(".viewer-aside")).toBeHidden();
  await page.getByRole("button", { name: "Show details" }).click();
  await expect(page.locator(".viewer-aside")).toBeVisible();
  expect(await sideways(page)).toBe(false);
  await accessible(page, "the map in an editor's panel");
});

test("the map gives its canvas the height: one bar, the legend folded until opened", async ({
  page,
}) => {
  await open(page, app(), "canvas");
  const bar = page.getByRole("group", { name: "Map controls" });
  const canvas = page.locator(".react-flow").first();
  await expect(canvas).toBeVisible();
  // The controls are one row: lens, tools and the picture's own zoom and find.
  const lens = (await bar.getByRole("tablist", { name: "Lens" }).boundingBox())!;
  const zoom = (await bar.getByRole("button", { name: "Zoom in" }).boundingBox())!;
  expect(Math.abs(zoom.y + zoom.height / 2 - (lens.y + lens.height / 2))).toBeLessThan(6);
  // The canvas ends inside the page, above the bottom panel, and takes most of its height.
  const main = (await page.locator("main").boundingBox())!;
  const box = (await canvas.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(main.y + main.height);
  expect(box.height).toBeGreaterThan(main.height * 0.7);

  // The tools open as a drawer over the canvas, and close back to their button.
  await bar.getByRole("button", { name: "Show the tools" }).click();
  const drawer = page.getByRole("region", { name: "Layers, filters and tools" });
  await expect(drawer).toBeVisible();
  await accessible(page, "the map's tools as a drawer");
  await drawer.getByRole("button", { name: "Hide the tools" }).click();
  await expect(drawer).toHaveCount(0);
  await expect(bar.getByRole("button", { name: "Show the tools" })).toBeFocused();

  // The details close to give the canvas the width, and open again.
  await page.getByRole("button", { name: "Hide details" }).click();
  await expect(page.locator(".viewer-aside")).toBeHidden();
  await expect(page.getByRole("button", { name: "Show details" })).toBeFocused();
  await page.getByRole("button", { name: "Show details" }).click();
  await expect(page.locator(".viewer-aside")).toBeVisible();

  // The legend starts folded (open, it covered a box), opens, and stays open on the next visit
  // in this browser; folded again, it stays folded.
  const legend = page.getByRole("button", { name: "Legend" });
  await expect(legend).toHaveAttribute("aria-expanded", "false");
  await legend.click();
  await expect(legend).toHaveAttribute("aria-expanded", "true");
  await page.reload();
  await expect(page.getByRole("button", { name: "Legend" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await accessible(page, "the map with its legend open");
  await page.getByRole("button", { name: "Legend" }).click();
  await page.reload();
  await expect(page.getByRole("button", { name: "Legend" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});
