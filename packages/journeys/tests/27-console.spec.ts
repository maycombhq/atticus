import {
  accessible,
  atticus,
  catalogFiles,
  classicLayout,
  expect,
  forgeJourney,
  open,
  test,
} from "../support/app.js";

/**
 * ADR 0187: the Console. Whatever Atticus does on this metarepo shows in one place the person can
 * always open: a scan started from the app, with its lines; and a command run in a terminal
 * while the app is open (`atticus map forge-ledger --handoff`), which the app picks up from its
 * run files. Everything is the invented Forge estate (CLAUDE.md rule 3).
 */
const app = forgeJourney();

// ADR 0194: the classic layout's Console, at the foot of the page, as before; the IDE layout's
// bottom panel holds it too (34-ide-shell).
test.beforeEach(async ({ page }) => classicLayout(page));

test("opens the Console on a fresh metarepo, and starts a scan whose lines it shows", async ({
  page,
}) => {
  await open(page, app(), "scans");
  const toggle = page.getByRole("button", { name: "Open the Console" });
  await expect(toggle).toBeVisible();
  await toggle.click();
  const consoleBox = page.getByRole("region", { name: "Console" });
  await expect(consoleBox.getByText("Nothing has run yet on this metarepo.")).toBeVisible();
  await accessible(page, "the empty Console");

  const before = catalogFiles(app().root);
  await page.getByRole("button", { name: "Check with the built-in readers" }).click();
  const list = consoleBox.getByRole("tablist", { name: "What ran" });
  const scan = list.getByRole("tab", { name: /Scan/ }).first();
  await expect(scan).toBeVisible();
  await expect(scan).toContainText("from this app");
  await scan.click();
  await expect(scan).toHaveAttribute("aria-selected", "true");
  // The scan's own lines (its report in words, never its JSON), and how it ended.
  const log = consoleBox.getByRole("log");
  await expect(log).not.toHaveText("Nothing printed yet.", { timeout: 60_000 });
  // Beta.27 review: a safety stop is its own outcome, never a failed run.
  await expect(scan).toContainText("refused: nothing written", { timeout: 60_000 });
  await expect(scan).not.toContainText(/failed/);
  // Beta.26 safety stop: no repo is cloned on this metarepo, so the scan wrote nothing, and its
  // lines and the page say which repos and what to do; the catalog is as it was.
  await expect(log).toContainText("Nothing written: catalog/generated is as it was");
  // In the app's words, the command after them.
  await expect(log).toContainText(
    "forge-ledger: not cloned here; clone it with Sync repos on Set up › Repos (in a terminal: atticus workspace sync)",
  );
  await expect(log).not.toContainText('"stats"');
  await expect(page.getByText("Nothing written: the catalog is as it was.")).toBeVisible();
  expect(catalogFiles(app().root)).toEqual(before);
  await accessible(page, "the Console with a scan");
});

test("shows a command run in a terminal while the app is open", async ({ page }) => {
  await open(page, app(), "home");
  await page.getByRole("button", { name: "Open the Console" }).click();
  const consoleBox = page.getByRole("region", { name: "Console" });
  await expect(consoleBox.getByRole("tablist", { name: "What ran" })).toBeVisible();
  // As a person types it in a terminal: the hand-off prints the prompt's place and what's next.
  const said = atticus(app().root, "map", "forge-ledger", "--handoff");
  const entry = consoleBox.getByRole("tab", { name: /atticus map forge-ledger --handoff/ });
  await expect(entry).toBeVisible({ timeout: 30_000 });
  await expect(entry).toContainText(/from (a terminal|VS Code|IntelliJ)/);
  await entry.click();
  const first = said.split("\n").find((l) => l.trim().length > 8 && !/[\\/]tmp[\\/]/.test(l));
  if (first) await expect(consoleBox.getByRole("log")).toContainText(first.trim().slice(0, 40));
  await expect(entry).toContainText(/done|failed/);
  await accessible(page, "the Console with a terminal's run");
});
