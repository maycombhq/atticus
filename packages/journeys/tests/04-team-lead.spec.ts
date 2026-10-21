import { accessible, expect, forgeJourney, open, test } from "../support/app.js";

/** Team lead: orders the work across repos and watches the initiative's dates. */
const app = forgeJourney();

test("sees tasks by repo in the breakdown and on the board", async ({ page }) => {
  await open(page, app(), "home");
  await open(page, app(), "tasks?change=add-transfer-limit");
  await expect(page.getByRole("heading", { level: 2, name: "Tasks by repo" })).toBeVisible();
  await expect(page.getByText("forge-ledger").first()).toBeVisible();
  await accessible(page, "task board");
});

test("follows the initiative's timeline against the target", async ({ page }) => {
  await open(page, app(), "initiatives");
  await expect(
    page.getByRole("heading", { level: 2, name: "Transfer limits rollout" }),
  ).toBeVisible();
  await expect(page.getByRole("img", { name: /Timeline of/ })).toBeVisible();
  await accessible(page, "initiatives");
});

test("sees every change's tasks in one list and narrows it to a repo", async ({ page }) => {
  await open(page, app(), "changes?across=tasks");
  await expect(page.getByRole("heading", { level: 2, name: "Tasks across changes" })).toBeVisible();
  const status = page.getByRole("status").filter({ hasText: /across 1 open change/ });
  await expect(status).toBeVisible();
  await page.getByLabel("Filter").fill("forge-portal-bff");
  await expect(status).toHaveText(/^\d+ of \d+ across/);
  await expect(page.getByRole("region", { name: "Tasks across open changes" })).toContainText(
    "forge-portal-bff",
  );
  await accessible(page, "tasks across changes");
});
