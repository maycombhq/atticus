import { accessible, expect, forgeJourney, open, test, workAs } from "../support/app.js";

/** QA: owns the trace, the test kinds the change needs, and the gaps before sign-off. */
const app = forgeJourney();

test("sees coverage, gaps and the test kinds the strategy asks for", async ({ page }) => {
  await open(page, app(), "home");
  await workAs(page, "qa");
  await open(page, app(), "trace?change=add-transfer-limit");
  await expect(page.getByRole("heading", { level: 2, name: "Scenario coverage" })).toBeVisible();
  await expect(page.getByText("CONTRACT", { exact: true })).toBeVisible();
  await accessible(page, "test trace");
});

test("checks the release plan's gates", async ({ page }) => {
  await open(page, app(), "release/add-transfer-limit");
  await expect(page.getByText(/Ready to raise|Next/).first()).toBeVisible();
  await accessible(page, "release plan");
});
