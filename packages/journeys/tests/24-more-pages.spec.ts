import { accessible, expect, forgeJourney, open, test } from "../support/app.js";

/**
 * More pages (the ADR 0124 D-app addendum's follow-up, 2026-10-25): the product owner opened the
 * app and couldn't find Model runs, Prompt history or "all the pages". The menu keeps its six
 * entries, then More pages, always there: every other page by section, its open or closed state
 * remembered, keyboard-only with an accessible name, and fitting an editor's panel. Model runs is
 * a tab of Set up; Ctrl+K finds every page and the menu says so.
 */
const app = forgeJourney();

const HIDDEN = 26;

test("More pages is in the menu on first load, closed, and lists every page the six don't show", async ({
  page,
}) => {
  await open(page, app(), "home");
  const nav = page.getByRole("navigation", { name: "Main" });
  // The six stay the menu's own group.
  await expect(nav.getByRole("group", { name: "Main" }).getByRole("link")).toHaveText([
    "Home",
    "Map",
    "Change",
    "Questions",
    "Knowledge",
    "Set up",
  ]);
  const more = nav.getByRole("button", { name: `More pages ${HIDDEN}` });
  await expect(more).toBeVisible();
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await expect(nav.getByRole("link", { name: "Prompt history" })).toBeHidden();
  await more.click();
  await expect(more).toHaveAttribute("aria-expanded", "true");
  // By section, Change's by phase.
  for (const [group, pages] of [
    ["Map", ["Ecosystem map", "Features", "API mappings", "Diagrams", "Reconcile", "Governance"]],
    ["Define", ["Feature brief", "Prototypes and UX"]],
    ["Plan", ["Breakdown", "Estimate"]],
    ["Build", ["Task board", "Code against design", "Test trace", "Manual steps"]],
    ["Knowledge", ["Teams, vendors and products", "Org pack from the wikis"]],
    ["Set up", ["Scans", "Intake", "Settings"]],
    ["Atticus", ["Prompt history", "AI quality", "Learning"]],
  ] as const) {
    const g = nav.getByRole("group", { name: group, exact: true }).last();
    for (const p of pages)
      await expect(g.getByRole("link", { name: p, exact: true })).toBeVisible();
  }
  await expect(nav.locator("#more-pages").getByRole("link")).toHaveCount(HIDDEN);
  await accessible(page, "the menu with More pages open");
  await page.emulateMedia({ colorScheme: "light" });
  await accessible(page, "the menu with More pages open, light theme");
});

test("Prompt history and Estimate open from More pages; Model runs is a tab of Set up", async ({
  page,
}) => {
  await open(page, app(), "home");
  const nav = page.getByRole("navigation", { name: "Main" });
  const more = nav.getByRole("button", { name: /^More pages/ });
  if ((await more.getAttribute("aria-expanded")) !== "true") await more.click();
  await nav.getByRole("link", { name: "Prompt history" }).click();
  await expect(page).toHaveURL(/#\/history$/);
  await expect(page.getByRole("heading", { level: 1, name: "Prompt history" })).toBeAttached();
  await expect(nav.getByRole("link", { name: "Prompt history" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  // A change's page keeps the change it is about, else asks for one as from Ctrl+K.
  await open(page, app(), "stories?change=add-transfer-limit");
  await nav.getByRole("link", { name: "Estimate", exact: true }).click();
  await expect(page).toHaveURL(/#\/estimate\?change=add-transfer-limit$/);
  await expect(page.getByRole("heading", { level: 1, name: "Estimate" })).toBeAttached();
  // Model runs, in plain sight: Set up's tabs, beside AI.
  await nav.getByRole("link", { name: "Set up" }).click();
  const tabs = page.getByRole("navigation", { name: "Set up pages" });
  await expect(tabs.getByRole("link")).toHaveText(["Repos", "AI", "Model runs", "Org pack"]);
  await tabs.getByRole("link", { name: "Model runs" }).click();
  await expect(page).toHaveURL(/#\/runs$/);
  await expect(nav.getByRole("link", { name: "Set up" })).toHaveAttribute("aria-current", "page");
  await accessible(page, "model runs from Set up");
});

test("More pages stays open or closed as the viewer left it", async ({ page }) => {
  await open(page, app(), "home");
  const more = page.getByRole("button", { name: /^More pages/ });
  // Left open by the step before? Each test is a fresh browser: it starts closed.
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await more.click();
  await page.reload();
  await expect(page.locator(".panel").first()).toBeVisible();
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("link", { name: "Prompt history" })).toBeVisible();
  await more.click();
  await page.goto(`${app().url}/#/trust`);
  await page.reload();
  await expect(page.locator(".panel").first()).toBeVisible();
  await expect(more).toHaveAttribute("aria-expanded", "false");
  // Closed on purpose stays closed, even on a page More holds.
  await page.goto(`${app().url}/#/history`);
  await expect(more).toHaveAttribute("aria-expanded", "false");
});

test("works with the keyboard alone: Tab to it, Enter opens, Tab into it, Escape closes", async ({
  page,
}) => {
  await open(page, app(), "home");
  const more = page.getByRole("button", { name: /^More pages/ });
  // From Ask Atticus, the menu's last link, Tab reaches More pages.
  await page.getByRole("link", { name: "Ask Atticus" }).focus();
  await page.keyboard.press("Tab");
  await expect(more).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Ecosystem map" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await expect(more).toBeFocused();
  await page.keyboard.press("Space");
  await expect(more).toHaveAttribute("aria-expanded", "true");
  // Enter on a page in it opens the page.
  await page.getByRole("link", { name: "AI quality" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/evals$/);
});

test("the menu says Ctrl+K reaches any page, and it does, Prompt history among them", async ({
  page,
}) => {
  await open(page, app(), "home");
  const hint = page.getByRole("button", { name: "Ctrl+K: any page" });
  await expect(hint).toBeVisible();
  // A click opens it too (an editor's panel may keep the keys).
  await hint.click();
  const dialog = page.getByRole("dialog", { name: "Go to anything" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  // Without --full: a page under More pages is found by its name.
  await page.keyboard.press("Control+k");
  await expect(dialog).toBeVisible();
  await page.keyboard.type("Prompt history");
  await expect(dialog.getByRole("option").first()).toContainText("Prompt history");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/history$/);
});

test("in an editor's panel (780 px) More pages fits beside the page", async ({ page }) => {
  for (const width of [780, 620]) {
    await page.setViewportSize({ width, height: 900 });
    await open(page, app(), "home");
    const nav = page.getByRole("navigation", { name: "Main" });
    const more = nav.getByRole("button", { name: /^More pages/ });
    if ((await more.getAttribute("aria-expanded")) !== "true") await more.click();
    await expect(nav.getByRole("link", { name: "Service desk queue" })).toBeVisible();
    const box = (await nav.boundingBox())!;
    const main = (await page.locator("main").boundingBox())!;
    expect(main.x, `${width}`).toBeGreaterThanOrEqual(box.x + box.width - 1);
    // Every page's name stays inside the menu.
    for (const l of await nav.locator("#more-pages a").all()) {
      const b = (await l.boundingBox())!;
      expect(b.x + b.width, `${width}`).toBeLessThanOrEqual(box.x + box.width + 1);
    }
    const sideways = await page.evaluate<boolean>(
      "document.documentElement.scrollWidth > document.documentElement.clientWidth",
    );
    expect(sideways, `${width} scrolls sideways`).toBe(false);
  }
  await accessible(page, "More pages open at 620 px");
});
