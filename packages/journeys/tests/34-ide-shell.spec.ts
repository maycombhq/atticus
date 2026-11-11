import { accessible, expect, forgeJourney, open, test } from "../support/app.js";

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
  await expect(status.getByRole("link", { name: /questions? open$/ })).toBeVisible();
  await accessible(page, "the IDE layout on Home, dark");
  await page.getByLabel("Theme").selectOption("light");
  await accessible(page, "the IDE layout on Home, light");
  await page.getByLabel("Theme").selectOption("dark");
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
  await open(page, app(), "questions");
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
  await page.getByRole("button", { name: "Check with the built-in readers" }).click();
  await tabs.getByRole("tab", { name: /^Runs/ }).click();
  await expect(panel.getByRole("list", { name: "Recent runs" })).toContainText(/Scan/);
  await accessible(page, "the bottom panel's runs");
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
});
