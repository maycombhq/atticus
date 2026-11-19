import { accessible, ESTATES, expect, forgeJourney, open, routeOf, test } from "../support/app.js";
import { SCREENS } from "../support/screens.js";

/**
 * WCAG 2.1 AA on every screen in the dark theme: axe reports no moderate, serious or critical violation
 * on any of them. 17-light-theme does the same in the light theme. Beta.30 (slice 9): on the tidy
 * Forge estate and on the field-shaped one (fixtures/forge-field), each screen with the estate's
 * own change and component.
 */
for (const estate of ESTATES)
  test.describe(`the ${estate} estate`, () => {
    const app = forgeJourney({ estate });

    for (const s of SCREENS.map((x) => routeOf(estate, x)))
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
      // Change's list of every change (the ADR 0124 D-app addendum: Change opens on All changes).
      await page.keyboard.type("all changes");
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/#\/changes$/);
      // A page under More pages (Governance) is offered too, without `atticus ui --full`
      // (2026-10-25: anything that exists is findable), then the question for Ask.
      await page.keyboard.press("Control+k");
      await expect(dialog).toBeVisible();
      // The box opens empty and focused (the palette clears what was typed last time as it opens).
      const box = dialog.getByRole("combobox");
      await expect(box).toBeFocused();
      await expect(box).toHaveValue("");
      await page.keyboard.type("governance");
      await expect(dialog.getByRole("option").first()).toContainText("Governance");
      await expect(dialog.getByRole("option").last()).toContainText("Ask: governance");
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/#\/governance$/);
    });
  });
