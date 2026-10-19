import { accessible, expect, forgeJourney, open, test, workAs } from "../support/app.js";

/** Designer: prototypes and UX, the brief they feed, and the features users see. */
const app = forgeJourney();

test("works on prototypes and UX, and sees the features", async ({ page }) => {
  await open(page, app(), "home");
  await workAs(page, "designer");
  await open(page, app(), "ux?change=add-transfer-limit");
  await expect(page.getByRole("heading", { level: 2, name: "Bring in a prototype" })).toBeVisible();
  await accessible(page, "prototypes and UX");
  await open(page, app(), "features");
  await expect(page.getByText("Account balance").first()).toBeVisible();
  await accessible(page, "features");
});
