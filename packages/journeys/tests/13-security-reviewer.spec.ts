import { accessible, expect, forgeJourney, open, test } from "../support/app.js";

/** Security reviewer: unauthenticated calls, sensitive data, and the contracts behind them. */
const app = forgeJourney();

test("finds calls with no authentication and checks the map", async ({ page }) => {
  await open(page, app(), "governance");
  await expect(page.getByRole("heading", { level: 2, name: "Authentication gaps" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Sensitive data" })).toBeVisible();
  await accessible(page, "governance");
  // v30 slice 8 (56f9d489): what the catalog knows is on Systems, no longer under the map.
  await open(page, app(), "systems");
  await expect(
    page.getByRole("heading", { level: 2, name: "What the catalog knows" }),
  ).toBeVisible();
  await accessible(page, "systems");
});
