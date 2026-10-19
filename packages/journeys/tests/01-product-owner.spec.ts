import { accessible, expect, forgeJourney, open, test, workAs } from "../support/app.js";

/** Product owner: writes the feature in plain words, sees what the critic asks, and hands it to architecture. */
const app = forgeJourney();

test("starts from a home made for the product owner", async ({ page }) => {
  await open(page, app(), "home");
  await workAs(page, "product-owner", { keepTour: true });
  // The first-run tour: three steps, skippable, and it replays from Help.
  const tour = page.getByRole("dialog", { name: "Your home" });
  await expect(tour).toBeVisible();
  await accessible(page, "first-run tour");
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("dialog", { name: "Write the brief" })).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("dialog", { name: /Your home|Write the brief/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Help" }).click();
  await expect(page.getByRole("dialog", { name: "Your home" })).toBeVisible();
  await page.getByRole("button", { name: "Skip the tour" }).click();
  await expect(page.getByText("Product owner view · chosen by you")).toBeVisible();
  const nav = page.getByRole("group", { name: "Your screens" });
  await expect(nav.getByRole("link", { name: "Feature brief" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Waiting on you" })).toBeVisible();
  await accessible(page, "home");
});

test("reads and edits the brief, then saves it", async ({ page }) => {
  await open(page, app(), "brief?change=add-transfer-limit");
  await expect(page.getByRole("heading", { level: 2, name: "Feature brief" })).toBeVisible();
  await expect(page.getByText("Add a daily transfer limit").first()).toBeVisible();
  await accessible(page, "feature brief");
  await page.getByRole("button", { name: "Edit" }).first().click();
  const box = page.getByLabel("brief text");
  await box.fill(
    `${await box.inputValue()}\n\n## Examples\n\n- A customer with a 1000 limit sends 900, then 200: the 200 is refused.\n`,
  );
  await page.getByRole("button", { name: "Save" }).click();
  await expect(
    page.getByText(/Saved openspec\/changes\/add-transfer-limit\/brief\.md/),
  ).toBeVisible();
});

test("asks the critic, and sees prototypes and UX", async ({ page }) => {
  await open(page, app(), "brief?change=add-transfer-limit");
  await page.getByRole("button", { name: "Run the critic" }).click();
  await expect(page.getByRole("status").or(page.getByRole("alert")).first()).toBeVisible();
  await open(page, app(), "ux?change=add-transfer-limit");
  await expect(page.getByRole("heading", { level: 2, name: "Prototypes and UX" })).toBeVisible();
  await accessible(page, "prototypes and UX");
});
