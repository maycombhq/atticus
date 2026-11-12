import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { cp, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import {
  accessible,
  atticus,
  catalogFiles,
  expect,
  open,
  startApp,
  stopApp,
  test,
  type App,
} from "../support/app.js";

/**
 * ADR 0195 (ticket CS3): the readers' cross-check and the build's confirm steps, in the app. The
 * metarepo is the Forge estate built from its golden slots (every repo's readers slot, the
 * ledger's facts snapshot) with `atticus catalog build`, as a team has it after beta.27's
 * upgrade. A person reads what the readers found beside the facts, dismisses one (its command in
 * the Console), and both pages fit VS Code's panel without scrolling sideways; then a scan-like
 * read that lost most of a repo's records waits for its count, is confirmed, and is undone; a
 * hand edit is made curated. Everything is the invented Forge estate (CLAUDE.md rule 3).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "../../../fixtures");
const SHOTS = process.env.ATTICUS_SHOTS;

async function slotsMetarepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-journey-cs3-"));
  await cp(join(FIXTURES, "forge/metarepo"), root, { recursive: true });
  await cp(join(FIXTURES, "forge/slots/readers"), join(root, "catalog/sources/readers"), {
    recursive: true,
  });
  await cp(join(FIXTURES, "forge/slots/facts"), join(root, "catalog/sources/facts"), {
    recursive: true,
  });
  await mkdir(join(root, "facts"), { recursive: true });
  const built = atticus(root, "catalog", "build");
  if (!existsSync(join(root, "catalog/sources/build.json")))
    throw new Error(`atticus catalog build didn't build: ${built}`);
  const git = (...a: string[]) => spawnSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Priya Nair");
  git("config", "user.email", "priya@forge.example");
  git("add", "-A");
  git("commit", "-qm", "Forge metarepo, built from its slots");
  return root;
}

let app: App | undefined;
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  app = await startApp(await slotsMetarepo());
});
test.afterAll(async () => {
  if (app) await stopApp(app);
});
const a = () => app!;

const sideways = (page: Page) =>
  page.evaluate<boolean>(
    "document.documentElement.scrollWidth > document.documentElement.clientWidth",
  );
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `cs3-${name}.png`), fullPage: false });
};
/** As VS Code's panel and IntelliJ's tool window load the app (ADR 0194 point 4). */
async function embedded(page: Page, route: string, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${a().url}/?host=intellij#/${route}`);
  await expect(page.locator(".panel").first()).toBeVisible();
  await page.waitForLoadState("networkidle");
  const skip = page.getByRole("button", { name: "Skip the tour" });
  if (await skip.isVisible().catch(() => false)) await skip.click();
}

test.use({ deviceScaleFactor: 2 });

test("reads what the readers found beside the facts, and dismisses one", async ({ page }) => {
  await open(page, a(), "trust");
  await page.getByRole("link", { name: "Readers found / facts say" }).first().click();
  await expect(page).toHaveURL(/#\/crosscheck/);
  await expect(page.getByRole("heading", { name: "Readers found / facts say" })).toBeVisible();
  await expect(page.getByLabel("Repo")).toHaveValue("forge-ledger");
  const list = page.getByRole("list", { name: "Cross-check items of forge-ledger" });
  await expect(list).toBeVisible();
  await expect(list.getByText("api/ledger-openapi.yaml:6")).toBeVisible();
  await accessible(page, "Readers found / facts say, dark");
  await shot(page, "crosscheck-1440-dark");

  // The filter is a group of radios: the arrow keys move between them.
  const found = page.getByRole("radio", { name: /^Readers found \(\d+\)$/ });
  await expect(found).toBeChecked();
  await found.focus();
  await page.keyboard.press("ArrowRight");
  const disagree = page.getByRole("radio", { name: "Disagree (2)" });
  await expect(disagree).toBeChecked();
  await expect(page).toHaveURL(/show=disagree/);
  await expect(list.getByText("forge-service")).toBeVisible();

  const before = catalogFiles(a().root);
  await page.getByRole("button", { name: "Dismiss Component|ledger-api" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Dismissed Component|ledger-api." }),
  ).toBeVisible();
  await expect(page.getByRole("radio", { name: "Dismissed (1)" })).toBeVisible();
  expect(readFileSync(join(a().root, "facts/forge-ledger.crosscheck.yaml"), "utf8")).toContain(
    "key: Component|ledger-api",
  );
  // Nothing in the catalog changed.
  expect(catalogFiles(a().root)).toEqual(before);
  // Its command is in the Console, with what it printed (ADR 0187).
  await page.getByRole("button", { name: "Show in the Console" }).click();
  await expect(
    page.getByRole("tab", { name: /Dismiss on forge-ledger: Component\|ledger-api/ }).first(),
  ).toBeVisible();
  await expect(page.getByRole("log")).toContainText("dismissed Component|ledger-api");
  await accessible(page, "the cross-check with the Console open");
});

test("fits VS Code's panel at 780 and 420 px without scrolling sideways", async ({ page }) => {
  for (const width of [780, 420]) {
    for (const route of ["crosscheck?repo=forge-ledger", "catalog-builds"]) {
      await embedded(page, route, width);
      expect(await sideways(page), `${route} at ${width} px scrolls sideways`).toBe(false);
      if (width === 780) await shot(page, `${route.split("?")[0]}-780-embedded`);
    }
    await accessible(page, `Catalog builds at ${width} px`);
  }
});

test("a large removal waits for its count, is confirmed, then undone", async ({ page }) => {
  // The gateway's next read finds one record where it found many (a reader that stopped short).
  const slot = join(a().root, "catalog/sources/readers/forge-gateway.json");
  const s = JSON.parse(readFileSync(slot, "utf8")) as { records: unknown[] };
  const was = readFileSync(slot, "utf8");
  writeFileSync(slot, JSON.stringify({ ...s, records: s.records.slice(0, 1) }, null, 2) + "\n");
  const before = catalogFiles(a().root);
  await open(page, a(), "scans");
  await page.getByRole("link", { name: "Catalog builds: confirm, undo, prune" }).click();
  await expect(page).toHaveURL(/#\/catalog-builds$/);
  await expect(page.getByText("The build waits for you: nothing has been written.")).toBeVisible();
  const review = page.getByRole("button", { name: /^Review the \d+ removals$/ });
  const n = Number(/\d+/.exec((await review.textContent()) ?? "")![0]);
  await review.click();
  const dialog = page.getByRole("dialog", { name: `Confirm ${n} removals` });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("table", { name: "The records the build would remove" }),
  ).toBeVisible();
  await accessible(page, "the removals' confirm");
  await shot(page, "confirm-removals-1440-dark");
  const remove = dialog.getByRole("button", { name: `Remove ${n} records` });
  await expect(remove).toBeDisabled();
  await dialog.getByLabel(`Type ${n} to confirm exactly these`).fill(String(n + 1));
  await expect(remove).toBeDisabled();
  expect(catalogFiles(a().root)).toEqual(before);
  await dialog.getByLabel(`Type ${n} to confirm exactly these`).fill(String(n));
  await remove.click();
  await expect(dialog).toBeHidden({ timeout: 60_000 });
  await expect(page.getByText("Done. What it printed is in the Console.")).toBeVisible();
  await expect(
    page.getByText("catalog/generated is what the slots and inputs build."),
  ).toBeVisible();
  const after = catalogFiles(a().root);
  expect(Object.keys(after).length).toBe(Object.keys(before).length - n);

  // Undo the build: the files it puts back are listed first.
  await page
    .getByRole("button", { name: /^Undo to before copy \d+$/ })
    .first()
    .click();
  const undo = page.getByRole("dialog", { name: /^Undo to before copy \d+$/ });
  await expect(undo.getByRole("list", { name: "The files undo puts back" })).toBeVisible();
  await accessible(page, "the undo's confirm");
  await undo.getByRole("button", { name: /^Put back \d+ files?$/ }).click();
  await expect(undo).toBeHidden({ timeout: 60_000 });
  expect(catalogFiles(a().root)).toEqual(before);
  // The slot was written by hand here, not by a command, so undo leaves it: put it back, and the
  // build has nothing waiting.
  writeFileSync(slot, was);
  await page.reload();
  await expect(
    page.getByText("catalog/generated is what the slots and inputs build."),
  ).toBeVisible();
  await shot(page, "catalog-builds-1440-dark");
});

test("a hand edit is never overwritten: it is made curated", async ({ page }) => {
  const files = Object.keys(catalogFiles(a().root)).filter((f) => f.startsWith("table/"));
  const path = join(a().root, "catalog/generated", files[0]!);
  writeFileSync(path, readFileSync(path, "utf8").replace(/^name: (.+)$/m, "name: $1-by-hand"));
  await open(page, a(), "catalog-builds");
  await expect(page.getByText(`changed: catalog/generated/${files[0]}`)).toBeVisible();
  await accessible(page, "a hand edit listed");
  await page.getByRole("button", { name: "Make it curated" }).click();
  await expect(page.getByText("Done. What it printed is in the Console.")).toBeVisible({
    timeout: 60_000,
  });
  await expect(
    page.getByText("catalog/generated is what the slots and inputs build."),
  ).toBeVisible();
  expect(readFileSync(path, "utf8")).toContain("-by-hand");
});
