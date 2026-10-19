import { accessible, expect, forgeJourney, open, test, workAs } from "../support/app.js";

/** Delivery lead: the service-desk queue, the manual steps, the release plan and go/no-go. */
const app = forgeJourney();

test("works the service-desk queue", async ({ page }) => {
  await open(page, app(), "home");
  await workAs(page, "delivery-lead");
  await open(page, app(), "service-desk");
  await expect(page.getByText("Gateway proxy deployment").first()).toBeVisible();
  await expect(page.getByText(/Missing: fill it in snow\.md/).first()).toBeVisible();
  await accessible(page, "service desk queue");
});

test("sees the release plan and manual steps", async ({ page }) => {
  await open(page, app(), "release/add-transfer-limit");
  await expect(page.getByRole("button", { name: "Ask for go / no-go" })).toBeVisible();
  await accessible(page, "release plan");
  await open(page, app(), "todo");
  await expect(
    page.getByRole("heading", { level: 2, name: "Where steps come from" }),
  ).toBeVisible();
  await accessible(page, "to-do");
});

test("sees the releases across changes and their digest on Home", async ({ page }) => {
  await open(page, app(), "changes?across=releases");
  await expect(
    page.getByRole("heading", { level: 2, name: "Releases across changes" }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Releases across open changes" })).toContainText(
    "add-transfer-limit",
  );
  await open(page, app(), "home");
  await workAs(page, "delivery-lead");
  await page.getByRole("button", { name: "Show my digest" }).click();
  await expect(page.getByRole("status").filter({ hasText: /^Atticus: / })).toBeVisible();
  await accessible(page, "home with the digest");
});
