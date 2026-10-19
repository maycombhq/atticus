import { accessible, expect, forgeJourney, open, test } from "../support/app.js";

/** Security reviewer: unauthenticated calls, sensitive data, and the contracts behind them. */
const app = forgeJourney();

test("finds calls with no authentication and checks the map", async ({ page }) => {
  await open(page, app(), "governance");
  await expect(page.getByRole("heading", { level: 2, name: "Authentication gaps" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Sensitive data" })).toBeVisible();
  await accessible(page, "governance");
  await open(page, app(), "map");
  await expect(
    page.getByRole("heading", { level: 2, name: "What the catalog knows" }),
  ).toBeVisible();
  await accessible(page, "ecosystem map");
});
