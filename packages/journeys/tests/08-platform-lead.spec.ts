import { accessible, expect, forgeJourney, open, test } from "../support/app.js";

/** Platform lead: repos and scans, intake, the org pack, governance and settings. */
const app = forgeJourney();

test("follows the setup checklist and accepts the catalog", async ({ page }) => {
  await open(page, app(), "home");
  await expect(page.getByRole("heading", { level: 2, name: "Set up Atticus" })).toBeVisible();
  await expect(page.getByText(/Repos are cloned here/)).toBeVisible();
  await accessible(page, "setup checklist");
  await page.getByRole("button", { name: "Accept the catalog as the baseline" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Set up Atticus" })).toHaveCount(0);
});

test("sees the repos and the catalog", async ({ page }) => {
  await open(page, app(), "home");
  await open(page, app(), "scans");
  await expect(page.getByText("forge-ledger").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Scan now" })).toBeVisible();
  await accessible(page, "scans");
});

test("checks the org pack, governance and settings", async ({ page }) => {
  await open(page, app(), "orgpack");
  await expect(page.getByText("S.GW.SOR").first()).toBeVisible();
  await accessible(page, "org pack");
  await open(page, app(), "governance");
  await expect(page.getByRole("heading", { level: 2, name: "Authentication gaps" })).toBeVisible();
  await accessible(page, "governance");
  await open(page, app(), "settings");
  await expect(page.getByRole("heading", { level: 2, name: "Runtime modes" })).toBeVisible();
  await accessible(page, "settings");
});

test("reads AI quality and learning", async ({ page }) => {
  await open(page, app(), "evals");
  await expect(page.getByRole("heading", { level: 2, name: "Quality signals" })).toBeVisible();
  await accessible(page, "AI quality");
  await open(page, app(), "learning");
  await expect(page.getByRole("heading", { level: 2, name: "Lessons" })).toBeVisible();
  await accessible(page, "learning");
});
