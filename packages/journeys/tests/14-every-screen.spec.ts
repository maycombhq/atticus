import { accessible, expect, forgeJourney, open, test } from "../support/app.js";

/** WCAG 2.1 AA on all 27 screens: axe reports no serious or critical violation on any of them. */
const app = forgeJourney();

const SCREENS = [
  "dashboard",
  "onboarding",
  "feature-design?change=add-transfer-limit",
  "stories?change=add-transfer-limit",
  "task-list?change=add-transfer-limit",
  "home",
  "explore",
  "flows",
  "map",
  "impact?q=ledger-api",
  "impact?q=ledger-api&incident=1",
  "features",
  "orgpack",
  // ADR 0102: knowledge in the app.
  "wikis",
  "knowledge",
  "wiki-search?q=transfer",
  "parties",
  "orgpack-draft",
  "intake",
  "scans",
  "brief?change=add-transfer-limit",
  "ux?change=add-transfer-limit",
  "arch-review?change=add-transfer-limit",
  "diagrams",
  "architecture",
  "reconcile",
  "contracts",
  "mappings?change=add-transfer-limit",
  "breakdown?change=add-transfer-limit",
  "initiatives",
  "changes/add-transfer-limit",
  "changes?across=findings",
  "changes?across=tasks",
  "changes?across=stories",
  "changes?across=tests",
  "changes?across=requests",
  "changes?across=releases",
  "tasks?change=add-transfer-limit",
  "trace?change=add-transfer-limit",
  "todo",
  "release/add-transfer-limit",
  "service-desk",
  "governance",
  "evals",
  "learning",
  "settings",
];

for (const s of SCREENS)
  test(`#/${s} is accessible`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await open(page, app(), s);
    await accessible(page, s);
    expect(errors, `script errors on ${s}`).toEqual([]);
  });

test("the command palette is accessible and takes you anywhere", async ({ page }) => {
  await open(page, app(), "home");
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Go to anything" });
  await expect(dialog).toBeVisible();
  await accessible(page, "command palette");
  await page.keyboard.type("governance");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/governance$/);
});
