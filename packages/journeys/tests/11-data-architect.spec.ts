import { accessible, expect, forgeJourney, open, test } from "../support/app.js";

/** DBA or data architect: tables, who reads and writes them, and what a column change reaches. */
const app = forgeJourney();

test("sees tables and their dependants, and the mappings artifact", async ({ page }) => {
  await open(page, app(), "contracts");
  await page.getByRole("button", { name: /^entry/ }).click();
  await expect(page.getByRole("heading", { level: 2, name: "entry" })).toBeVisible();
  await accessible(page, "contracts: table");
  await open(page, app(), "impact?q=ledger-db.entry");
  await expect(page.getByText("reports-job").first()).toBeVisible();
  await open(page, app(), "mappings?change=add-transfer-limit");
  await expect(
    page.getByRole("heading", { level: 2, name: "Mappings", exact: true }),
  ).toBeVisible();
  await accessible(page, "API mappings");
});
