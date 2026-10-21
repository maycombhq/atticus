import { accessible, expect, forgeJourney, open, test } from "../support/app.js";

/** Process owner: the procedures and request templates of their process, and the steps they cause. */
const app = forgeJourney();

test("reviews procedures, templates and the steps waiting", async ({ page }) => {
  await open(page, app(), "home");
  await open(page, app(), "orgpack");
  await expect(
    page.getByRole("heading", { level: 2, name: "Checklists and procedures" }),
  ).toBeVisible();
  await open(page, app(), "service-desk");
  await expect(page.getByText(/request templates? in the org pack/).first()).toBeVisible();
  await open(page, app(), "todo");
  await expect(
    page.getByRole("heading", { level: 2, name: "Procedures a local tool can run" }),
  ).toBeVisible();
  await accessible(page, "to-do");
});
