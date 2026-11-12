import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  accessible,
  atticus,
  catalogFiles,
  commitInClone,
  expect,
  forgeSlotsJourney,
  open,
  test,
} from "../support/app.js";

/**
 * ADR 0195 (ticket CS5): a removal above the limit is refused, confirmed with the count it was
 * shown, then undone. The Forge estate is cloned and built from its slots; forge-ledger's second
 * migration is deleted in its clone, so a check with the built-in readers would take the entry
 * table, its columns and indexes out of the catalog: more than 10% of the repo's records. The
 * check started from Set up › Scans writes nothing and the Console lists the removals with the
 * count that confirms them; the person confirms in a terminal (`atticus scan --allow-removals
 * <n>`) and takes it back (`atticus catalog undo --yes`), and the Console shows both runs. Then
 * the same refusal is confirmed in the app, with the count it lists (Set up › Scans, CS3's confirm
 * step), and undone on Catalog builds, its files listed first. Invented Forge estate only
 * (CLAUDE.md rule 3); no network. (Journey 35 is CS3's own: the cross-check and Catalog builds.)
 */
const app = forgeSlotsJourney();

// "/"-separated on every OS, as catalogFiles keys the catalog's files (join takes it on Windows too).
const ENTRY = "table/ledger-db.entry.yaml";

test("a large removal is refused in the app, confirmed with its count, then undone", async ({
  page,
}) => {
  const root = app().root;
  commitInClone(root, "forge-ledger", "src/main/resources/db/migration/V2__create_entry.sql", null);
  const before = catalogFiles(root);
  expect(Object.keys(before)).toContain(ENTRY);

  await open(page, app(), "scans");
  const panel = page.getByRole("region", { name: "Panel" });
  await panel.getByRole("button", { name: "Show the panel" }).click();
  await page.getByRole("button", { name: "Check with the built-in readers" }).click();
  // Refused: nothing written, said on the page, and the Console lists what it would remove.
  // With CS3, the page says a refused build as its confirm step does (ADR 0195 point 4: it says
  // why and lists what it would have done), not as beta.26's stop.
  await expect(page.getByText("The build waits for you: nothing has been written.")).toBeVisible({
    timeout: 90_000,
  });
  const log = panel.getByRole("log");
  await expect(log).toContainText(/This would remove \d+ records/);
  await expect(log).toContainText("Table/ledger-db.entry");
  const said = (await log.textContent()) ?? "";
  const count = /atticus scan --allow-removals (\d+)/.exec(said)?.[1];
  expect(count, said).toBeTruthy();
  expect(catalogFiles(root)).toEqual(before);
  await accessible(page, "Set up › Scans with a refused build");

  // A wrong count confirms nothing.
  const wrong = atticus(root, "scan", "--no-drift", "--allow-removals", String(Number(count) + 1));
  expect(wrong).toContain(`doesn't name the ${count} listed`);
  expect(catalogFiles(root)).toEqual(before);

  // Confirmed with the count it was shown, from a terminal while the app is open.
  const confirmed = atticus(root, "scan", "--no-drift", "--allow-removals", count!);
  expect(confirmed).toMatch(new RegExp(`Removed ${count} records`));
  expect(existsSync(join(root, "catalog", "generated", ENTRY))).toBe(false);
  // The panel's Console follows the latest run, a terminal's included: its name and its lines.
  await expect(panel.getByText("atticus scan --no-drift --allow-removals: done")).toBeVisible({
    timeout: 30_000,
  });
  await expect(log).toContainText(`Removed ${count} records`);
  await expect(log).toContainText("atticus catalog undo takes this back");

  // Taken back: the catalog is byte for byte as before the confirmed scan.
  const listed = atticus(root, "catalog", "undo");
  expect(listed).toMatch(/atticus catalog undo --yes would put back/);
  const undone = atticus(root, "catalog", "undo", "--yes");
  expect(undone).toMatch(/Put back \d+ files?/);
  expect(catalogFiles(root)).toEqual(before);
  expect(existsSync(join(root, "catalog", "generated", ENTRY))).toBe(true);
  await accessible(page, "the Console after the undo");
});

// ADR 0187: the Console keeps every command that writes, and the run log's list
// (packages/core/src/run-log.ts) has the build's commands: `atticus catalog build`, `edits`,
// `undo`, `prune` and `crosscheck`.
test("the Console shows the undo run from a terminal", async ({ page }) => {
  await open(page, app(), "scans");
  const panel = page.getByRole("region", { name: "Panel" });
  await panel.getByRole("button", { name: "Show the panel" }).click();
  // Undo the undo: the confirmed scan's catalog comes back, and the Console shows the run.
  expect(atticus(app().root, "catalog", "undo", "--yes")).toMatch(/Put back \d+ files?/);
  await expect(panel.getByText("atticus catalog undo --yes: done")).toBeVisible({
    timeout: 15_000,
  });
  // The log is read after the run's line says done: a slow Windows runner takes longer than
  // the default wait to show it.
  await expect(panel.getByRole("log")).toContainText(/Put back \d+ files?/, { timeout: 15_000 });
});

// CS3 (ADR 0195 point 4 and "Plan for beta.27"): the app's confirm step lists the refused
// scan's removals and confirms exactly that list with its count, and Catalog builds' undo step
// lists what it will put back before it puts it back.
test("the refused scan's confirm step and the undo step in the app", async ({ page }) => {
  const root = app().root;
  // Back to before the confirmed scan (the test above undid the undo): the clone still lacks
  // the migration, so a check with the built-in readers is refused again.
  expect(atticus(root, "catalog", "undo", "--yes")).toMatch(/Put back \d+ files?/);
  const before = catalogFiles(root);
  expect(Object.keys(before)).toContain(ENTRY);

  await open(page, app(), "scans");
  await page.getByRole("button", { name: "Check with the built-in readers" }).click();
  await expect(page.getByText("The build waits for you: nothing has been written.")).toBeVisible({
    timeout: 90_000,
  });
  const review = page.getByRole("button", { name: /^Review the \d+ removals$/ });
  await expect(review).toBeVisible();
  const n = Number(/\d+/.exec((await review.textContent()) ?? "")![0]);
  expect(n).toBeGreaterThan(0);
  await review.click();
  const dialog = page.getByRole("dialog", { name: `Confirm ${n} removals` });
  await expect(
    dialog.getByRole("table", { name: "The records the build would remove" }),
  ).toContainText("Table/ledger-db.entry");
  await accessible(page, "the refused scan's confirm step");
  const confirm = dialog.getByRole("button", { name: `Scan again, removing ${n} records` });
  // A wrong count confirms nothing.
  await dialog.getByLabel(`Type ${n} to confirm exactly these`).fill(String(n + 1));
  await expect(confirm).toBeDisabled();
  expect(catalogFiles(root)).toEqual(before);
  await dialog.getByLabel(`Type ${n} to confirm exactly these`).fill(String(n));
  await confirm.click();
  await expect(dialog).toBeHidden({ timeout: 90_000 });
  await expect
    .poll(() => existsSync(join(root, "catalog", "generated", ENTRY)), { timeout: 90_000 })
    .toBe(false);

  // Undone on Catalog builds: the files it puts back are listed first.
  await open(page, app(), "catalog-builds");
  await page.getByRole("button", { name: "Undo the latest build" }).first().click();
  const undo = page.getByRole("dialog", { name: "Undo the latest build" });
  await expect(undo.getByRole("list", { name: "The files undo puts back" })).toBeVisible();
  await accessible(page, "the undo step after the app's confirmed scan");
  await undo.getByRole("button", { name: /^Put back \d+ files?$/ }).click();
  await expect(undo).toBeHidden({ timeout: 60_000 });
  expect(catalogFiles(root)).toEqual(before);
});
