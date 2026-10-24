import { accessible, expect, forgeJourney, open, test } from "../support/app.js";

/** Developer: runs a task with their assistant, and looks up the contracts it touches. */
const app = forgeJourney();

test("runs a task with AI, and is told to open the change's workspace first", async ({ page }) => {
  await open(page, app(), "home");
  await open(page, app(), "tasks?change=add-transfer-limit");
  // The Task board is behind --full: its address still opens it, Change's entry marked.
  await expect(
    page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Change" }),
  ).toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: "Run with AI" }).first().click();
  await expect(page.getByRole("status").filter({ hasText: "worktree" })).toContainText(
    "atticus workspace open add-transfer-limit",
  );
  await accessible(page, "task board");
});

test("reads a contract's evidence and who depends on it", async ({ page }) => {
  await open(page, app(), "contracts");
  await expect(
    page.getByRole("heading", { level: 2, name: "Contracts", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Consumers and dependants")).toBeVisible();
  await accessible(page, "contracts");
});

test("asks a question in plain words and sees the query", async ({ page }) => {
  await open(page, app(), "home");
  await page.getByLabel("Ask Atticus").fill("who calls ledger-api?");
  await page.getByRole("button", { name: "Ask" }).click();
  await expect(page.getByText("kind:interface to:ledger-api").first()).toBeVisible();
  await accessible(page, "ask");
});
