import {
  accessible,
  ESTATES,
  expect,
  fieldInfo,
  forgeJourney,
  open,
  routeOf,
  test,
} from "../support/app.js";
import { MOVED, SCREENS } from "../support/screens.js";

/**
 * WCAG 2.1 AA on every screen in the dark theme: axe reports no moderate, serious or critical violation
 * on any of them. 17-light-theme does the same in the light theme. Beta.30 (slice 9): on the tidy
 * Forge estate and on the field-shaped one (fixtures/forge-field), each screen with the estate's
 * own change and component; on the field estate no screen says "Couldn't load this".
 */

/**
 * The change pages with no change picked, on the field estate (as 15-empty-and-error opens them on
 * a new metarepo): each says to pick one, never "Couldn't load this".
 */
const BARE = [
  "feature-design",
  "stories",
  "task-list",
  "impact",
  "wiki-search",
  "brief",
  "ux",
  "arch-review",
  "change-diagram",
  "estimate",
  "conformance",
  "mappings",
  "breakdown",
  "tasks",
  "trace",
];

for (const estate of ESTATES)
  test.describe(`the ${estate} estate`, () => {
    const app = forgeJourney({ estate });

    for (const s of [
      ...SCREENS.map((x) => routeOf(estate, x)),
      ...(estate === "field" ? BARE.filter((b) => !SCREENS.includes(b)) : []),
    ])
      test(`#/${s} is accessible`, async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(String(e)));
        await open(page, app(), s);
        // On the field estate every screen says what to do, never "Couldn't load this" (what
        // 15-empty-and-error checks of a new metarepo).
        if (estate === "field") await expect(page.getByText(/Couldn't load this/)).toHaveCount(0);
        await accessible(page, s);
        expect(errors, `script errors on ${s}`).toEqual([]);
      });

    // Beta.30: the app's Ask names both consumers of a topic with consumers in two repos, on its
    // own panel, the list named by its Read as line.
    if (estate === "field")
      test("Ask: who consumes a topic with consumers in two repos, accessibly", async ({
        page,
      }) => {
        const t = fieldInfo().topic!;
        await open(
          page,
          app(),
          `explore?ask=${encodeURIComponent(`who consumes the topic ${t.name}?`)}`,
        );
        const list = page.getByRole("list", { name: new RegExp(`who receives ${t.name}`) });
        await expect(list).toBeVisible();
        for (const l of t.listeners) await expect(list).toContainText(l);
        await expect(
          page.getByRole("link", { name: /^What breaks if this changes: / }),
        ).toHaveCount(t.listeners.length);
        await accessible(page, "Ask: who receives a topic with two consumers");
      });

    // The palette doesn't depend on the estate's shape: the tidy estate's only.
    if (estate === "tidy")
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

    // v30 slice 8: a page folded into another keeps its address, which opens its new place
    // (the addresses don't depend on the estate's shape: the tidy estate's only).
    if (estate === "tidy")
      for (const [old, now] of MOVED)
        test(`#/${old} opens its new place`, async ({ page }) => {
          await open(page, app(), old);
          await expect(page).toHaveURL(now);
        });
  });
