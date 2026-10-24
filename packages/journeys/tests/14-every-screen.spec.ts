import { accessible, expect, forgeJourney, open, test } from "../support/app.js";
import { SCREENS } from "../support/screens.js";

/**
 * WCAG 2.1 AA on every screen in the dark theme: axe reports no moderate, serious or critical violation
 * on any of them. 17-light-theme does the same in the light theme.
 */
const app = forgeJourney();

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
