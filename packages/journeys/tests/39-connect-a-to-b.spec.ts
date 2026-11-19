import { readFileSync } from "node:fs";
import { join } from "node:path";
import { accessible, expect, open, reconnectJourney, test } from "../support/app.js";

/**
 * ADR 0204: "Connect A to B" on every box. On the invented estate of fixtures/reconnect, Northwind
 * Pay (a vendor, no code in the estate) has no call to forge-ledger anyone could read. The person
 * picks Northwind Pay's box, chooses Connect to…, picks forge-ledger and the direction, says why,
 * and one button declares the arrow: written to the profile's links and built in one job, said
 * "Connected", with Undo; again, and Show the arrow draws it dashed, "declared by priya". Every
 * screen state is checked for accessibility. No network; nothing is committed or pushed.
 */
const app = reconnectJourney();
const WHY = "Northwind settles card payments into the ledger every night.";
const DECLARED = '.react-flow__edge[aria-label*="declared by priya"]';

test("an outside system is connected to a repo by declaring the arrow, in one go, with Undo", async ({
  page,
}) => {
  const root = app().root;
  await open(page, app(), "canvas");
  const profile = () =>
    readFileSync(join(root, "org-pack", "profiles", "forge", "profile.yaml"), "utf8");
  const start = async () => {
    const connect = page.getByRole("button", { name: "Connect to…" });
    await expect(async () => {
      await page
        .locator('.react-flow__node[data-id="system:northwind-pay"]')
        .click({ timeout: 2_000 });
      await expect(connect).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await connect.click();
    await page.getByLabel("The other box").selectOption({ label: "repo: forge-ledger" });
    const panel = page.locator(".connect-panel");
    await expect(
      panel.getByRole("heading", { name: "Connect northwind-pay to forge-ledger" }),
    ).toBeVisible();
    await expect(
      panel.getByRole("radio", { name: "northwind-pay calls forge-ledger" }),
    ).toBeChecked();
    await expect(
      panel.getByText(/Atticus found no call in Northwind Pay's code that goes to forge-ledger/),
    ).toBeVisible({ timeout: 60_000 });
    return panel;
  };
  const before = profile();
  const panel = await start();
  const go = panel.getByRole("button", { name: "Connect: declare the arrow" });
  // Why is required.
  await expect(go).toBeDisabled();
  await panel.getByLabel("Why is it so? (your words, kept with the arrow)").fill(WHY);
  await accessible(page, "Connect, declaring an arrow");
  await go.click();
  await expect(
    panel.getByText("Connected: Northwind Pay → forge-ledger is on the map."),
  ).toBeVisible({
    timeout: 120_000,
  });
  await expect(panel.getByText("Not proposed yet: only this machine has it.")).toBeVisible();
  expect(profile()).toContain(`why: ${WHY}`);
  expect(profile()).toContain("schemaVersion: 3");
  await accessible(page, "Connect, the arrow declared");

  // Undo takes back exactly what it wrote, and builds once.
  await panel.getByRole("button", { name: "Undo" }).click();
  await expect(
    panel.getByText("Undone: what this wrote is taken back, and the map built again."),
  ).toBeVisible({ timeout: 120_000 });
  // Byte for byte as it was, its version too.
  expect(profile()).toBe(before);

  // Again, and Show the arrow: dashed, declared by the person.
  await panel.getByRole("button", { name: "Close" }).first().click();
  const again = await start();
  await again.getByLabel("Why is it so? (your words, kept with the arrow)").fill(WHY);
  await again.getByRole("button", { name: "Connect: declare the arrow" }).click();
  await again.getByRole("button", { name: "Show the arrow" }).click({ timeout: 120_000 });
  await expect(page.locator(DECLARED)).toHaveCount(1, { timeout: 60_000 });
  await accessible(page, "the map with a declared arrow");
});
