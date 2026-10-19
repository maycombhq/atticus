import { accessible, expect, forgeJourney, open, test } from "../support/app.js";

/** SRE: what a failing system reaches, who to call, and the timeouts between callers and callees. */
const app = forgeJourney();

test("checks a failing system's reach and the timeouts", async ({ page }) => {
  await open(page, app(), "impact?q=ledger-api");
  await expect(page.getByText("team-portal").first()).toBeVisible();
  await page.getByRole("button", { name: "Incident mode" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Owners to call" })).toBeVisible();
  await expect(page.getByText("team-ledger").first()).toBeVisible();
  await expect(page.getByText("Ledger API error rate")).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 2, name: "Recent nearby changes" }),
  ).toBeVisible();
  await accessible(page, "impact explorer in incident mode");
  await open(page, app(), "governance");
  await expect(page.getByRole("heading", { level: 2, name: "Timeouts and retries" })).toBeVisible();
  await accessible(page, "governance");
});
