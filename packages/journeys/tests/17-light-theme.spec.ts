import type { Page } from "@playwright/test";
import { accessible, ESTATES, expect, forgeJourney, open, routeOf, test } from "../support/app.js";
import { SCREENS } from "../support/screens.js";

/**
 * The browser app's light theme: it follows a light system setting, every screen passes axe
 * (WCAG 2.1 AA) in it, and the theme switch (system, light or dark) is remembered across a
 * reload. 14-every-screen does the same pass in the dark theme. Beta.30 (slice 9): every screen on
 * the tidy Forge estate, and the map's screens on the field-shaped one (fixtures/forge-field).
 */
test.use({ colorScheme: "light" });

/** The field estate's screens in the light theme: the map's, where its shape shows. */
const FIELD_LIGHT = ["canvas", "map", "trust", "flows", "impact?q=ledger-api"];

const theme = (page: Page) =>
  page.evaluate<string | undefined>("document.documentElement.dataset.theme");

for (const estate of ESTATES)
  test.describe(`the ${estate} estate`, () => {
    const app = forgeJourney({ estate });

    // The field estate's light pass is of the screens its shape changes most: the map's.
    const screens = estate === "tidy" ? SCREENS : FIELD_LIGHT;
    for (const s of screens.map((x) => routeOf(estate, x)))
      test(`#/${s} is accessible in the light theme`, async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(String(e)));
        await open(page, app(), s);
        expect(await theme(page)).toBe("light");
        await accessible(page, `${s} (light)`);
        expect(errors, `script errors on ${s}`).toEqual([]);
      });

    // The palette, the tour and the theme switch don't depend on the estate: the tidy one's only.
    if (estate !== "tidy") return;

    test("the command palette and the tour are accessible in the light theme", async ({ page }) => {
      await open(page, app(), "home");
      await page.keyboard.press("Control+k");
      await expect(page.getByRole("dialog", { name: "Go to anything" })).toBeVisible();
      await accessible(page, "command palette (light)");
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Help" }).click();
      await expect(page.getByRole("dialog", { name: "Your home" })).toBeVisible();
      await accessible(page, "tour (light)");
    });

    test("the theme switch is remembered, and System follows the computer again", async ({
      page,
    }) => {
      // Home, which the Overview is part of now.
      await open(page, app(), "home");
      const pick = page.getByLabel("Theme");
      await expect(pick).toHaveValue("system");
      await pick.selectOption("dark");
      expect(await theme(page)).toBe("dark");
      await page.reload();
      await expect(page.getByLabel("Theme")).toHaveValue("dark");
      expect(await theme(page)).toBe("dark");
      await accessible(page, "home (dark chosen on a light system)");

      await page.getByLabel("Theme").selectOption("system");
      expect(await theme(page)).toBe("light");
      // While on System, the app follows the computer when it changes.
      await page.emulateMedia({ colorScheme: "dark" });
      await expect.poll(() => theme(page)).toBe("dark");
      await page.emulateMedia({ colorScheme: "light" });
      await expect.poll(() => theme(page)).toBe("light");

      await page.getByLabel("Theme").selectOption("light");
      await page.emulateMedia({ colorScheme: "dark" });
      await page.reload();
      expect(await theme(page)).toBe("light");
    });
  });
