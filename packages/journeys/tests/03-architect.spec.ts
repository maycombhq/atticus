import { accessible, expect, forgeJourney, open, test } from "../support/app.js";

/** Architect: reviews the design against the code and settles diagram names; approving is the hand-off PR. */
const app = forgeJourney();

test("reviews the design with its patterns and drift", async ({ page }) => {
  await open(page, app(), "home");
  await open(page, app(), "arch-review?change=add-transfer-limit");
  await expect(page.getByRole("heading", { level: 2, name: "Architecture review" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Integration patterns" })).toBeVisible();
  await expect(page.getByText("S.GW.SOR").first()).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 2, name: "Design vs plans vs code" }),
  ).toBeVisible();
  await accessible(page, "architecture review");
});

test("reconciles the drawn diagram with the code", async ({ page }) => {
  await open(page, app(), "reconcile");
  await expect(page.getByText("forge-context.drawio").first()).toBeVisible();
  await expect(page.getByText("pattern-mismatch").first()).toBeVisible();
  await accessible(page, "reconcile");
});

test("decides a diagram name in triage, and it leaves the queue", async ({ page }) => {
  await open(page, app(), "intake");
  const decide = page.getByRole("button", { name: '"Ledger Platform" is ledger-api' });
  await decide.click();
  await expect(page.getByText(/Decided: "Ledger Platform" is ledger-api/)).toBeVisible();
  await expect(decide).toHaveCount(0);
  await accessible(page, "intake");
});

test("sees what a change to the ledger API reaches", async ({ page }) => {
  await open(page, app(), "impact?q=ledger-api");
  await expect(
    page.getByRole("heading", { level: 2, name: "Blast radius of ledger-api" }),
  ).toBeVisible();
  await expect(page.getByText("portal-bff").first()).toBeVisible();
  await accessible(page, "impact explorer");
});
