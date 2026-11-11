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
 * <n>`) and takes it back (`atticus catalog undo --yes`), and the Console shows both runs. The
 * app's own confirm and undo steps are CS3's (a placeholder below). Invented Forge estate only
 * (CLAUDE.md rule 3); no network.
 */
const app = forgeSlotsJourney();

const ENTRY = join("table", "ledger-db.entry.yaml");

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
  await expect(page.getByText("Nothing written: the catalog is as it was.")).toBeVisible({
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

// WAITS FOR CS2: the Console keeps every command that writes (ADR 0187), but the run log's list
// (packages/core/src/run-log.ts, `catalog: only("migrate")`) doesn't have CS2's new writers yet:
// `atticus catalog build`, `undo`, `prune` and `edits --curate`. Turns green when they are
// recorded; test.fail then fails, as the reminder to drop it.
test("WAITS FOR CS2: the Console shows the undo run from a terminal", async ({ page }) => {
  test.fail(true, "CS2: catalog undo isn't recorded for the Console yet");
  await open(page, app(), "scans");
  const panel = page.getByRole("region", { name: "Panel" });
  await panel.getByRole("button", { name: "Show the panel" }).click();
  // Undo the undo: the confirmed scan's catalog comes back, and the Console shows the run.
  expect(atticus(app().root, "catalog", "undo", "--yes")).toMatch(/Put back \d+ files?/);
  await expect(panel.getByText("atticus catalog undo --yes: done")).toBeVisible({
    timeout: 15_000,
  });
  await expect(panel.getByRole("log")).toContainText(/Put back \d+ files?/);
});

// CS3 (ADR 0195 point 4 and "Plan for beta.27"): the app's confirm step lists the refused
// build's removals and confirms exactly that list, and its undo step lists what it will put
// back. CS3 builds the view and its C4 routes; this step is filled in when it lands.
test.skip("CS3: the refused build's confirm step and the undo step in the app", async () => {
  // Waits for CS3: Set up › Scans' confirm step (removals listed, confirm with the count) and
  // the undo step, over the routes CS3 adds to the local API.
});
