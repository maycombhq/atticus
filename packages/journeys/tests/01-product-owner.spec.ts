import { accessible, expect, forgeJourney, open, test } from "../support/app.js";

/** Product owner: writes the feature in plain words, sees what the critic asks, and hands it to architecture. */
const app = forgeJourney();

test("starts from the same home as everyone, as their Git user (ADR 0073)", async ({ page }) => {
  await open(page, app(), "home");
  // The top bar names the metarepo's Git user; no sign-in, no role.
  await expect(page.getByText(/Priya Nair \(priya\)/).first()).toBeVisible();
  // The first-run tour: one for everyone, skippable, and it replays from Help.
  await page.getByRole("button", { name: "Help" }).click();
  const tour = page.getByRole("dialog", { name: "Your home" });
  await expect(tour).toBeVisible();
  await accessible(page, "first-run tour");
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("dialog", { name: "Ask in plain words" })).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("dialog", { name: "Approving is the pull request" })).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // No view to pick: one navigation, every screen in its group.
  await expect(page.getByLabel("View", { exact: true })).toHaveCount(0);
  // ADR 0119: six sections, the same on every surface; every page a tab of its section.
  const nav = page.getByRole("navigation", { name: "Main" });
  const main = nav.getByRole("group", { name: "Main" });
  await expect(main.getByRole("link")).toHaveText([
    "Home",
    "Changes",
    "Knowledge",
    "Estate",
    "Set up",
    "Atticus",
  ]);
  await expect(main.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("button", { name: "More" })).toHaveCount(0);
  const home = page.getByRole("navigation", { name: "Home pages" });
  await expect(home.getByRole("link", { name: "Waiting on you" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  // A change's pages are tabs of Changes, grouped by phase.
  await main.getByRole("link", { name: "Changes" }).click();
  const define = page
    .getByRole("navigation", { name: "Changes pages" })
    .getByRole("group", { name: "Define" });
  await expect(define.getByRole("link", { name: "Feature brief" })).toHaveAttribute(
    "href",
    "#/brief",
  );
  await open(page, app(), "home");
  await expect(page.getByRole("heading", { level: 2, name: "Needs a person" })).toBeVisible();
  await expect(page.getByText(/Approving is the pull request/).first()).toBeVisible();
  await accessible(page, "home");
});

test("reads and edits the brief, then saves it", async ({ page }) => {
  await open(page, app(), "brief?change=add-transfer-limit");
  await expect(page.getByRole("heading", { level: 2, name: "Feature brief" })).toBeVisible();
  await expect(page.getByText("Add a daily transfer limit").first()).toBeVisible();
  await accessible(page, "feature brief");
  await page.getByRole("button", { name: "Edit" }).first().click();
  const box = page.getByLabel("brief text");
  await box.fill(
    `${await box.inputValue()}\n\n## Examples\n\n- A customer with a 1000 limit sends 900, then 200: the 200 is refused.\n`,
  );
  await page.getByRole("button", { name: "Save" }).click();
  await expect(
    page.getByText(/Saved openspec\/changes\/add-transfer-limit\/brief\.md/),
  ).toBeVisible();
});

test("asks the critic, and sees prototypes and UX", async ({ page }) => {
  await open(page, app(), "brief?change=add-transfer-limit");
  await page.getByRole("button", { name: "Run the critic" }).click();
  await expect(page.getByRole("status").or(page.getByRole("alert")).first()).toBeVisible();
  await open(page, app(), "ux?change=add-transfer-limit");
  await expect(page.getByRole("heading", { level: 2, name: "Prototypes and UX" })).toBeVisible();
  await accessible(page, "prototypes and UX");
});
