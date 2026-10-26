import { expect, forgeStudioJourney, test } from "../support/app.js";

/**
 * Every page under More pages on an Atticus 2 metarepo (fixtures/forge-studio, 2026-10-25). With
 * --full on a real one, five Atticus 1 pages failed on an Atticus 2 change: the feature brief, the
 * prototypes, the architecture review and the API mappings asked for artifacts the change never
 * has, and reconcile ran with no diagrams. Opened from More pages with the change picked, no page
 * asks the local API for something it answers with an error, and none throws.
 */
const app = forgeStudioJourney();

const CHANGE = "add-note-tags";

test("every page in More pages opens on an Atticus 2 change without an API error", async ({
  page,
}) => {
  const a = app();
  const failed: string[] = [];
  const errors: string[] = [];
  let asked = 0;
  page.on("response", (r) => {
    const path = new URL(r.url()).pathname;
    if (!path.startsWith("/api/")) return;
    asked += 1;
    if (r.status() >= 400) failed.push(`${r.status()} ${path}`);
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${a.url}/#/changes/${CHANGE}`);
  await expect(page.locator(".panel").first()).toBeVisible();
  const skip = page.getByRole("button", { name: "Skip the tour" });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  const more = page.getByRole("button", { name: /^More pages/ });
  await more.click();
  const hrefs = await page
    .locator("#more-pages a")
    .evaluateAll((as) => as.map((x) => x.getAttribute("href")!));
  expect(hrefs).toHaveLength(26);
  // A change's pages keep the change picked.
  expect(hrefs).toContain(`#/brief?change=${CHANGE}`);
  for (const href of hrefs) {
    // A fresh load each time, so every answer counted is this page's.
    await page.goto("about:blank");
    failed.length = 0;
    await page.goto(`${a.url}/${href}`);
    await expect(page.locator("main")).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(failed, `${href} asked the API for what it doesn't have`).toEqual([]);
    expect(errors, `script errors on ${href}`).toEqual([]);
  }
  // The pages asked the API for what they show (the check above saw their answers).
  expect(asked).toBeGreaterThan(hrefs.length);
});

test("an Atticus 1 page says what an Atticus 2 change has instead of an error", async ({
  page,
}) => {
  const a = app();
  for (const [route, artifact] of [
    ["brief", "proposal"],
    ["ux", "ux"],
    ["arch-review", "interfaces"],
    ["mappings", "mappings"],
  ] as const) {
    await page.goto(`${a.url}/#/${route}?change=${CHANGE}`);
    await expect(page.getByText(`This change has no ${artifact}.`).first()).toBeVisible();
  }
  await page.goto(`${a.url}/#/reconcile`);
  await expect(page.getByText(/No diagrams yet/i).first()).toBeVisible();
});
