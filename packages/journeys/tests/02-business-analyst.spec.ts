import { accessible, expect, forgeJourney, open, test, workAs } from "../support/app.js";

/** Business analyst: turns the feature into stories that meet the bar, and checks the trace. */
const app = forgeJourney();

test("sees the stories, their bar and what isn't covered", async ({ page }) => {
  await open(page, app(), "home");
  await workAs(page, "business-analyst");
  await open(page, app(), "breakdown?change=add-transfer-limit");
  await expect(page.getByRole("heading", { level: 2, name: "Story bar" })).toBeVisible();
  await expect(page.getByText("s1-refuse-over-limit").first()).toBeVisible();
  await expect(page.getByText(/No story covers/).first()).toBeVisible();
  await accessible(page, "breakdown");
});

test("asks the story writer, and is stopped from overwriting stories a person wrote", async ({
  page,
}) => {
  await open(page, app(), "breakdown?change=add-transfer-limit");
  await page.getByRole("button", { name: "Write stories with AI" }).click();
  await expect(page.getByRole("alert")).toContainText("already has planning files a person wrote");
});

test("checks requirement to test trace", async ({ page }) => {
  await open(page, app(), "trace?change=add-transfer-limit");
  await expect(
    page.getByRole("heading", { level: 2, name: "Gaps before QA sign-off" }),
  ).toBeVisible();
  await expect(page.getByText("NO TEST").first()).toBeVisible();
  await accessible(page, "test trace");
});
