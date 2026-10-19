import { accessible, expect, forgeJourney, open, test, workAs } from "../support/app.js";

/** Team lead: orders the work across repos and watches the initiative's dates. */
const app = forgeJourney();

test("sees tasks by repo in the breakdown and on the board", async ({ page }) => {
  await open(page, app(), "home");
  await workAs(page, "team-lead");
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
