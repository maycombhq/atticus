import { accessible, expect, forgeJourney, open, test } from "../support/app.js";

/** Business analyst: turns the feature into stories that meet the bar, and checks the trace. */
const app = forgeJourney();

test("sees the stories, their bar and what isn't covered", async ({ page }) => {
  await open(page, app(), "home");
  await open(page, app(), "breakdown?change=add-transfer-limit");
  await expect(page.getByRole("heading", { level: 2, name: "Story bar" })).toBeVisible();
  await expect(page.getByText("s1-refuse-over-limit").first()).toBeVisible();
  await expect(page.getByText(/No story covers/).first()).toBeVisible();
  await accessible(page, "breakdown");
});

test("writes stories at the stories stage, one path from Breakdown (eighth UX walk)", async ({
  page,
}) => {
  await open(page, app(), "breakdown?change=add-transfer-limit");
  // Breakdown runs nothing itself: it sends the analyst to the stories stage.
  await expect(page.getByRole("button", { name: "Write stories with AI" })).toHaveCount(0);
  const go = page.getByRole("link", { name: "Open the stories stage" });
  await expect(go).toHaveAttribute("href", "#/stories?change=add-transfer-limit");
  await go.click();
  await expect(page).toHaveURL(/#\/stories\?change=add-transfer-limit$/);
  await accessible(page, "the stories stage from Breakdown");
});

test("checks requirement to test trace", async ({ page }) => {
  await open(page, app(), "trace?change=add-transfer-limit");
  await expect(
    page.getByRole("heading", { level: 2, name: "Gaps before QA sign-off" }),
  ).toBeVisible();
  await expect(page.getByText("NO TEST").first()).toBeVisible();
  await accessible(page, "test trace");
});
