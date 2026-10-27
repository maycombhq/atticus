import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { accessible, expect, forgeJourney, open, test } from "../support/app.js";

/**
 * A change's knowledge on its own page (2026-10-27). The product owner looked for the knowledge
 * attached to a change and couldn't find it at the foot of the Feature page. It is a tab of Change
 * now, beside Feature design: empty before the feature stage has picked any, then every page
 * attached, with its source and the tasks that use it. Feature design links to it; Ctrl+K finds
 * it; it passes axe in both themes. Everything is the invented Forge estate (CLAUDE.md rule 3).
 */
const app = forgeJourney();

const KNOWLEDGE = `schemaVersion: 1
change: add-transfer-limit
items:
  - id: "forge-eng/transfer-limits.md#Daily limits"
    kind: WikiSection
    status: suggested
    stages: [feature]
    score: 1.4
    why: named in the brief
    title: Transfer limits › Daily limits
    tasks: ["1.1"]
  - id: firewall-rule-request
    kind: ProcessDefinition
    status: confirmed
    stages: [feature, stories]
    score: 2
    title: Network firewall rule
nearMisses:
  - id: northwind-pay
    kind: Party
    score: 1.1
    stage: feature
    title: Northwind Pay
`;

const ROUTE = "change-knowledge?change=add-transfer-limit";

test("a change with no knowledge yet says so and what to run", async ({ page }) => {
  await open(page, app(), ROUTE);
  const tabs = page.getByRole("navigation", { name: "Change pages" });
  await expect(tabs.getByRole("link", { name: "Knowledge" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByText(/No knowledge is attached to this change yet/)).toBeVisible();
  await expect(page.getByText("atticus change feature add-transfer-limit")).toBeVisible();
  await accessible(page, "a change's knowledge, empty");
});

test("lists the pages attached, and passes axe in the dark and light themes", async ({ page }) => {
  await writeFile(
    join(app().root, "openspec/changes/add-transfer-limit/knowledge.yaml"),
    KNOWLEDGE,
  );
  await open(page, app(), ROUTE);
  const table = page.getByRole("table", { name: "Knowledge that applies to this change" });
  await expect(table.getByText("Transfer limits › Daily limits")).toBeVisible();
  await expect(table.getByText("Network firewall rule")).toBeVisible();
  await expect(table.getByText(/task 1\.1/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Confirm Transfer limits › Daily limits" }),
  ).toBeEnabled();
  await expect(page.getByText("Nearly picked (1): left out for room")).toBeVisible();
  expect(await page.evaluate("document.documentElement.dataset.theme")).toBe("dark");
  await accessible(page, "a change's knowledge (dark)");

  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(() => page.evaluate("document.documentElement.dataset.theme")).toBe("light");
  await accessible(page, "a change's knowledge (light)");
});

test("Feature design links to it, and Ctrl+K finds it", async ({ page }) => {
  await open(page, app(), "feature-design?change=add-transfer-limit");
  await expect(
    page.getByRole("table", { name: "Knowledge that applies to this change" }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: "Open the change's knowledge" }).click();
  await expect(page).toHaveURL(/#\/change-knowledge\?change=add-transfer-limit$/);
  await expect(page.getByText("Transfer limits › Daily limits")).toBeVisible();

  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Go to anything" });
  await expect(dialog).toBeVisible();
  await page.keyboard.type("knowledge that applies");
  await expect(dialog.getByRole("option").first()).toContainText("Knowledge");
  await expect(dialog.getByRole("option").first()).toContainText("Change · Define");
});
