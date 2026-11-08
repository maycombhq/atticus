import { accessible, expect, forgeJourney, open, test } from "../support/app.js";

/** Developer: runs a task with their assistant, and looks up the contracts it touches. */
const app = forgeJourney();

test("runs a task with AI, which opens the change's workspace itself", async ({ page }) => {
  await open(page, app(), "home");
  await open(page, app(), "tasks?change=add-transfer-limit");
  // The Task board is under More pages: its address still opens it, Change's entry marked, and
  // Change's tabs keep the change, At a glance among them.
  await expect(
    page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Change" }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    page
      .getByRole("navigation", { name: "Change pages" })
      .getByRole("link", { name: "At a glance" }),
  ).toHaveAttribute("href", "#/cockpit?change=add-transfer-limit");
  await page.getByRole("button", { name: "Run with AI" }).first().click();
  // UX review: Run with AI opens (or clones) the task's worktree itself, so the person is never
  // sent to a terminal first; what it says next is the run, or why it couldn't start.
  const said = page.getByRole("status").filter({ hasText: /prepared|couldn't|isn't|no |clone/i });
  await expect(said.first()).toBeVisible();
  await expect(said.first()).not.toContainText("atticus workspace open");
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
